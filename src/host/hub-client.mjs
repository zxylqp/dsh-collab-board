/**
 * 协作看板 · Hub 客户端（成员侧）
 *
 * 三件事，都是它一个人干：
 *   1. `join` 换 token；token 丢了自动重来（Hub 重启后所有 token 失效，这是正常的）
 *   2. 心跳 15 秒一次 —— Hub 靠它判在线 / 离线（45 秒无响应）
 *   3. 增量拉事件 + 把本机未同步的事件推上去
 *
 * **不轮询得很凶**：拉取默认 3 秒，和面板的刷新频率无关（面板有自己的轮询）。
 *
 * @module dsh-collab-board/host/hub-client
 */
import { WIRE_PROTOCOL, EVENT_VERSION, compareEvents, dedupeById } from './events.mjs';
import { createHash } from 'node:crypto';

/** 拉取间隔：比心跳密，因为「看得见」比「在线状态」更急。 */
const PULL_MS = 3000;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  if (typeof t.unref === 'function') t.unref();
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/**
 * 连一个 Hub。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      形如 `http://192.168.1.5:48910`
 * @param {string} opts.origin       本机 origin
 * @param {string} opts.name         显示名
 * @param {string[]} [opts.capabilities]
 * @param {string} [opts.code]       口令
 * @param {(events:any[], meta:object)=>void} [opts.onEvents]  拉到的新事件（已排序去重）
 * @param {()=>any[]} [opts.pending]  取本机待推送事件
 * @param {(ids:string[], stamped:any[])=>void} [opts.onPushed] 推送成功（回写 seq）
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export function createHubClient(opts = {}) {
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  const origin = String(opts.origin || '');
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let token = '';
  let epoch = 0;
  let since = 0;
  let stopped = false;
  let pullTimer = null;
  let beatTimer = null;
  let connecting = null;
  let name = String(opts.name || '成员');
  let capabilities = Array.isArray(opts.capabilities) ? opts.capabilities : [];
  let online = false;
  let lastError = '';
  /**
   * Hub 明确拒过的事件 id。
   *
   * 为什么必须记：Hub 的 `/events` 是**整批**校验，一条不过就整批 403，
   * 而客户端不标记失败项 —— 那条脏事件会每轮重推、每轮连坐，
   * 整台机器的同步从此停摆。所以被拒的拉黑，剩下的继续走。
   */
  const rejected = new Set();

  async function call(path, { method = 'GET', body, needToken = true, timeout = 8000 } = {}) {
    const t = withTimeout(timeout);
    try {
      const headers = { 'content-type': 'application/json' };
      if (needToken && token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}/collab/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: t.signal,
      });
      const text = await res.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { ok: false, error: { code: 'internal', message: text.slice(0, 200) } };
      }
      if (!res.ok || payload.ok === false) {
        const err = payload.error || { code: 'internal', message: `HTTP ${res.status}` };
        const e = new Error(err.message || `HTTP ${res.status}`);
        e.code = err.code;
        e.status = res.status;
        e.payload = payload;
        throw e;
      }
      return payload.data ?? payload;
    } finally {
      t.done();
    }
  }

  /** 加入。失败不抛给调用方 —— 网络断了是常态，循环里会重试。 */
  async function join() {
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const data = await call('/join', {
          method: 'POST',
          needToken: false,
          body: {
            wireProtocol: WIRE_PROTOCOL,
            eventVersion: EVENT_VERSION,
            origin,
            name,
            capabilities,
            code: opts.code || '',
          },
        });
        token = data.token;
        epoch = Number(data.epoch) || 1;
        // 新加入从 0 拉到全部；Hub 有 500 上限，循环会拉完
        since = 0;
        online = true;
        lastError = '';
        log('info', `已连上 Hub：epoch ${epoch}`);
        // 通知宿主「连上了」—— 成员事件要由成员自己写（系统 origin 不许写 member）
        if (typeof opts.onJoined === 'function') {
          try { opts.onJoined({ epoch }); } catch { /* 回调失败不影响连接 */ }
        }
        return true;
      } catch (e) {
        online = false;
        lastError = e.message;
        log('warn', `连 Hub 失败：${e.message}`);
        return false;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function heartbeat() {
    if (!token) return;
    try {
      const data = await call('/heartbeat', {
        method: 'POST',
        body: { status: opts.status ? opts.status() : 'idle', capabilities },
      });
      epoch = Number(data.epoch) || epoch;
      online = true;
      lastError = '';
    } catch (e) {
      // 401 = token 失效（Hub 重启过）→ 干净地重连
      if (e.status === 401) {
        token = '';
        online = false;
        await join();
        return;
      }
      online = false;
      lastError = e.message;
    }
  }

  /** 拉一轮增量。返回值给调用方决定要不要重绘。 */
  async function pullOnce() {
    if (!token) return [];
    let got = [];
    // 一次最多 500 条；拉满就说明还有，下一轮接着拉
    for (let round = 0; round < 20; round += 1) {
      const data = await call(`/events?since=${since}&limit=500`);
      const rows = Array.isArray(data.events) ? data.events : [];
      if (!rows.length) break;
      got = got.concat(rows);
      const maxSeq = rows.reduce((m, e) => Math.max(m, Number(e.seq) || 0), since);
      since = Math.max(since, maxSeq);
      epoch = Number(data.epoch) || epoch;
      if (!data.hasMore) break;
    }
    if (got.length && typeof opts.onEvents === 'function') {
      const clean = dedupeById(got.sort(compareEvents));
      try {
        opts.onEvents(clean, { epoch });
      } catch (e) {
        log('warn', `处理拉取事件失败：${e.message}`);
      }
    }
    return got;
  }

  /** 推本机未同步的事件。失败就留着，下一轮再推。 */
  async function pushOnce() {
    if (!token || typeof opts.pending !== 'function') return [];
    const list = opts.pending();
    if (!Array.isArray(list) || list.length === 0) return [];
    // 被 Hub 明确拒过的不再重推 —— 一条脏事件能把整批连坐，队列会永久卡住
    const alive = list.filter((e) => e && e.id && !rejected.has(e.id));
    if (alive.length === 0) return [];
    const batch = alive.slice(0, 100);
    try {
      const data = await call('/events', { method: 'POST', body: { events: batch } });
      const accepted = Array.isArray(data.accepted) ? data.accepted : [];
      if (typeof opts.onPushed === 'function') opts.onPushed(accepted, batch);
      epoch = Number(data.epoch) || epoch;
      return accepted;
    } catch (e) {
      // 只有「这批里有东西不对」才值得逐条拆开；网络错误拆了也是白拆
      /**
       * 哪些拒绝要「拆开逐条定位、把坏的那条拉黑」。
       *
       * **`conflict` 必须在名单里**（0.10.8 修）：它是 409，比如改别人建的任务卡标题。
       * 以前漏了它，于是 409 走进「网络错误」分支：整批原样留着、只打一行 warn，
       * 下一轮重试还是同一条 409，**该机器的同步队列就此永久卡死**
       * （R10 真机实测：汐汐 18:39 改标题被 409 之后，后续消息全推不上去）。
       */
      const isRejection = e.code === 'forbidden' || e.code === 'bad-param'
        || e.code === 'too-large' || e.code === 'cycle' || e.code === 'conflict'
        || e.status === 400;
      if (!isRejection) {
        log('warn', `推送失败：${e.message}`);
        return [];
      }
      log('warn', `整批被拒（${e.message}），逐条重发定位`);
      const ok = [];
      for (const ev of batch) {
        try {
          const data = await call('/events', { method: 'POST', body: { events: [ev] } });
          const accepted = Array.isArray(data.accepted) ? data.accepted : [];
          if (typeof opts.onPushed === 'function') opts.onPushed(accepted, [ev]);
          epoch = Number(data.epoch) || epoch;
          ok.push(...accepted);
        } catch (one) {
          // 单条也不认 —— 拉黑，别再让它拖累别人。
          // **但必须让它出声**：静默丢弃等于让人以为写成功了（汐汐 2026-11-04 的原话）。
          rejected.add(ev.id);
          log('warn', `这条 Hub 不认，已跳过：${ev.id} —— ${one.message}`);
          if (typeof opts.onRejected === 'function') {
            try { opts.onRejected(ev, one); } catch { /* 回调失败不该停同步 */ }
          }
        }
      }
      return ok;
    }
  }

  /** 认领。成功后 Hub 会写一条 task 事件，自己那轮拉取就能看到。 */
  async function claim(taskId, { leaseMs, capabilities: claimCaps, claimId } = {}) {
    if (!token) throw new Error('还没连上 Hub');
    return call('/tasks/claim', {
      method: 'POST',
      body: {
        taskId,
        claimId,
        leaseMs,
        capabilities: claimCaps,
      },
    });
  }

  /**
   * 上传一个文件到 Hub。
   *
   * base64 走 JSON —— 没做 multipart，因为 Node 原生拼 multipart 要自己算 boundary，
   * 而 64 MB 以内的文件 base64 成本可以接受（§7.2 允许二选一）。
   */
  async function uploadFile(buffer, name) {
    if (!token) throw new Error('还没连上 Hub');
    const sha = createHash('sha256').update(buffer).digest('hex');
    const data = await call('/files', {
      method: 'POST',
      timeout: 120000,
      body: { name, sha256: sha, size: buffer.length, data: buffer.toString('base64') },
    });
    return { ...data, sha256: sha };
  }

  /** 从 Hub 取一个文件，返回 Buffer + 实际 sha256（调用方自己校验）。 */
  async function downloadFile(fileId) {
    if (!token) throw new Error('还没连上 Hub');
    const res = await fetch(`${base}/collab/v1/files/${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j?.error?.message || msg;
      } catch { /* 二进制错误页 */ }
      throw new Error(`下载失败：${msg}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(buf).digest('hex');
    return { buffer: buf, sha256: sha, size: buf.length };
  }

  /** 系统写入熔断恢复（§32）。没连 Hub 时明确报错。 */
  async function recoverSystem() {
    if (!token) throw new Error('还没连上 Hub');
    return call('/system/recover', { method: 'POST', body: {} });
  }

  function start() {
    if (stopped) return;
    (async () => {
      if (!token) {
        const ok = await join();
        if (!ok) {
          // 连不上就慢点重试，别把日志刷满
          if (!stopped) setTimeout(() => { if (!stopped) start(); }, 10000).unref?.();
          return;
        }
      }
      const tick = async () => {
        if (stopped) return;
        try {
          if (!token) await join();
          await pushOnce();
          await pullOnce();
        } catch (e) {
          log('warn', `同步轮出错：${e.message}`);
        } finally {
          if (!stopped) pullTimer = setTimeout(tick, PULL_MS);
        }
      };
      tick();
      beatTimer = setInterval(() => { if (!stopped) heartbeat(); }, 15000);
      if (typeof beatTimer.unref === 'function') beatTimer.unref();
    })();
  }

  function stop() {
    stopped = true;
    if (pullTimer) clearTimeout(pullTimer);
    if (beatTimer) clearInterval(beatTimer);
    pullTimer = null;
    beatTimer = null;
  }

  return {
    start,
    stop,
    join,
    claim,
    uploadFile,
    downloadFile,
    recoverSystem,
    pullOnce,
    pushOnce,
    state: () => ({ online, epoch, since, token: token ? token.slice(0, 8) : '', lastError, baseUrl: base }),
    setProfile: (p) => {
      if (p && typeof p.name === 'string') name = p.name;
      if (p && Array.isArray(p.capabilities)) capabilities = p.capabilities;
    },
  };
}
