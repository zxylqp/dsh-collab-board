/**
 * 协作看板 · 局域网发现（UDP 广播，DESIGN §8）
 *
 * Hub 每秒在 UDP 48911 上喊一嗓子：
 *   `{ t:"hub", wireProtocol, origin, name, port, needCode, epoch, groupId, hmac? }`
 *
 * 两个用途：
 *   1. 成员不用手输地址也能发现 Hub（这一版界面还没做自动发现，先只做接收）
 *   2. **双 Hub 并存告警**（§12.4.1）—— 已经有一个 Hub 在广播了，自己又起了一个，
 *      要让人知道「现在有两个，事件流会分叉」，而且**不自动处理**：由人决定谁是权威 Hub。
 *
 * 广播不可信（§8）：同网段谁都能伪造。有口令时用 `hmac` 校验，无口令时无解 ——
 * 文档里认了这一点，别把它当安全边界。
 *
 * @module dsh-collab-board/host/discovery
 */
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { createHmac } from 'node:crypto';

export const DISCOVERY_PORT = 48911;
/** 广播周期：每秒一次（§8）。 */
export const BROADCAST_MS = 1000;
/** 15 秒没广播就算离线（§8）。 */
export const PEER_OFFLINE_MS = 15000;

const MAX_PACKET = 2048;

/**
 * 广播目标：全局广播地址 + 每块非内网网卡算出来的广播地址。
 *
 * 只发 255.255.255.255 在部分 Windows / 多网卡环境会被丢弃，所以要逐网卡算。
 */
export function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  let ifaces = {};
  try {
    ifaces = networkInterfaces();
  } catch {
    return [...out];
  }
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (!ni || (ni.family !== 'IPv4' && ni.family !== 4)) continue;
      if (ni.internal) continue;
      const addr = String(ni.address || '').split('.').map(Number);
      const mask = String(ni.netmask || '').split('.').map(Number);
      if (addr.length !== 4 || mask.length !== 4) continue;
      if (addr.some((n) => !Number.isFinite(n)) || mask.some((n) => !Number.isFinite(n))) continue;
      const bc = addr.map((a, i) => ((a & mask[i]) | (~mask[i] & 255)) & 255);
      out.add(bc.join('.'));
    }
  }
  return [...out];
}

/** 有口令时的签名。拼什么由实现定，接收方用同一份 —— 两边代码都在这儿，不会走偏。 */
export function signPacket(code, { groupId, origin, port, epoch }) {
  if (!code) return '';
  return createHmac('sha256', String(code))
    .update(`${groupId}:${origin}:${port}:${epoch}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 双 Hub 判定（§12.4.1）。
 *
 * 门槛：**连续 3 次广播、且持续 ≥10 秒**。只看单包会假阳性 ——
 * 旧 Hub 停机前最后一包可能还在路上，网络抖一下也会收到一包。
 *
 * 幂等：同一个 origin 只告警一次（不然一次抖动就刷屏）。
 * **不自动停、不自动切、不选举**：这是硬立场（§12.5）。
 */
export function createHubWatch({ threshold = 3, minDurationMs = 10000, resetAfterMs = 5000, onFork, log } = {}) {
  const peers = new Map();
  const say = typeof log === 'function' ? log : () => {};

  return {
    /**
     * 收到一包别人的 hub 广播。
     * @param {{origin:string, name?:string, host?:string, port?:number, epoch?:number}} info
     * @param {number} [now]
     */
    observe(info, now = Date.now()) {
      if (!info || typeof info.origin !== 'string') return null;
      let p = peers.get(info.origin);
      // 断了太久就当新的一轮：不能拿两小时前的第一包算「持续 10 秒」
      if (!p || now - p.lastAt > resetAfterMs) {
        p = { origin: info.origin, count: 0, firstAt: now, lastAt: now, warned: false };
        peers.set(info.origin, p);
      }
      p.count += 1;
      p.lastAt = now;
      p.name = info.name || p.name || '';
      p.host = info.host || p.host || '';
      p.port = Number(info.port) || p.port || 0;
      p.epoch = Number.isFinite(Number(info.epoch)) ? Number(info.epoch) : p.epoch;

      if (p.warned) return p;
      if (p.count >= threshold && now - p.firstAt >= minDurationMs) {
        p.warned = true;
        say('warn', `检测到第二个 Hub：origin=${p.origin.slice(0, 6)}（${p.host}:${p.port}），事件流会分叉`);
        if (typeof onFork === 'function') {
          try {
            onFork({ origin: p.origin, name: p.name, host: p.host, port: p.port, epoch: p.epoch });
          } catch { /* 回调炸了不该让监听停 */ }
        }
      }
      return p;
    },
    peers: () => [...peers.values()].map((p) => ({ ...p })),
    hasFork: () => [...peers.values()].some((p) => p.warned),
  };
}

/**
 * 起一个发现服务：广播自己 + 听别人。
 *
 * @param {object} opts
 * @param {string} opts.groupId
 * @param {string} opts.origin
 * @param {string} [opts.name]
 * @param {number} opts.port        Hub HTTP 端口（广播里告诉别人连哪）
 * @param {boolean} [opts.needCode]
 * @param {number} [opts.epoch]
 * @param {string} [opts.code]      口令，用来签名 / 验签
 * @param {number} [opts.discoveryPort] 默认 48911
 * @param {(info:object, rinfo:object)=>void} [opts.onPeer] 收到别的 Hub 广播
 * @param {boolean} [opts.quiet]    只听不发（成员侧用）
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export async function createDiscovery(opts = {}) {
  const groupId = String(opts.groupId || '');
  const origin = String(opts.origin || '');
  const code = typeof opts.code === 'string' ? opts.code : '';
  const dport = Number.isFinite(Number(opts.discoveryPort)) ? Number(opts.discoveryPort) : DISCOVERY_PORT;
  const say = typeof opts.log === 'function' ? opts.log : () => {};
  const quiet = opts.quiet === true;

  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  const peers = new Map(); // origin -> 最后一次广播
  let timer = null;
  let closed = false;

  sock.on('error', (e) => {
    // 端口被占 / 网卡变了都不该让插件崩：发现是增强能力，不是生命线
    say('warn', `UDP 发现出错：${e.message}`);
  });

  sock.on('message', (buf, rinfo) => {
    if (buf.length > MAX_PACKET) return;
    let pkt;
    try {
      pkt = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!pkt || pkt.t !== 'hub') return;
    if (pkt.groupId !== groupId) return;      // 不同组：不管
    if (pkt.origin === origin) return;        // 自己发的：丢了
    if (Number(pkt.wireProtocol) !== 1) return;

    // 有口令时验签；无口令时只能信内容（文档认了这个洞）
    if (code) {
      const expect = signPacket(code, {
        groupId: pkt.groupId,
        origin: pkt.origin,
        port: pkt.port,
        epoch: pkt.epoch,
      });
      if (pkt.hmac !== expect) {
        say('warn', `广播验签失败，丢弃：origin=${String(pkt.origin).slice(0, 6)}`);
        return;
      }
    }

    const info = {
      origin: String(pkt.origin || ''),
      name: String(pkt.name || ''),
      host: rinfo && rinfo.address ? rinfo.address : '',
      port: Number(pkt.port) || 0,
      epoch: Number(pkt.epoch) || 0,
      needCode: pkt.needCode === true,
      at: Date.now(),
    };
    peers.set(info.origin, info);
    if (typeof opts.onPeer === 'function') {
      try { opts.onPeer(info, rinfo); } catch { /* 回调炸了不该让监听停 */ }
    }
  });

  await new Promise((resolve, reject) => {
    const onErr = (e) => {
      sock.removeListener('listening', onUp);
      reject(e);
    };
    const onUp = () => {
      sock.removeListener('error', onErr);
      resolve();
    };
    sock.once('error', onErr);
    sock.once('listening', onUp);
    sock.bind(dport, '0.0.0.0');
  });

  try { sock.setBroadcast(true); } catch { /* 某些环境的限制，不影响 unicast */ }

  if (!quiet) {
    // 默认发到局域网广播；测试可以指定 `targets` / `targetPort` 只走回环
    const targets = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : broadcastTargets();
    const tport = Number.isFinite(Number(opts.targetPort)) ? Number(opts.targetPort) : dport;
    const payload = () => JSON.stringify({
      t: 'hub',
      wireProtocol: 1,
      origin,
      name: String(opts.name || ''),
      port: Number(opts.port) || 0,
      needCode: opts.needCode === true,
      epoch: Number(opts.epoch) || 0,
      groupId,
      hmac: signPacket(code, {
        groupId,
        origin,
        port: Number(opts.port) || 0,
        epoch: Number(opts.epoch) || 0,
      }),
    });
    const shout = () => {
      if (closed) return;
      const buf = Buffer.from(payload(), 'utf8');
      for (const host of targets) {
        try {
          sock.send(buf, 0, buf.length, tport, host, () => { /* 发不出去就算了 */ });
        } catch { /* 网卡来回变，下次再试 */ }
      }
    };
    shout();
    timer = setInterval(shout, BROADCAST_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  let bound = dport;
  try {
    const a = sock.address();
    if (a && Number.isFinite(a.port) && a.port > 0) bound = a.port;
  } catch { /* 拿不到就用请求的那个 */ }

  return {
    port: bound,
    /** 最近 15 秒内听到的其它 Hub。 */
    livePeers: () => [...peers.values()].filter((p) => Date.now() - p.at < PEER_OFFLINE_MS),
    allPeers: () => [...peers.values()],
    close: async () => {
      closed = true;
      if (timer) clearInterval(timer);
      await new Promise((resolve) => {
        try { sock.close(resolve); } catch { resolve(); }
      });
    },
  };
}
