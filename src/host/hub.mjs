/**
 * 协作看板 · Hub 服务端
 *
 * 一台机器兼 Hub，别的机器当成员连上来。Hub 只干三件事：
 *   1. 给每条事件分配权威序号 `(epoch, seq)` —— 全组唯一顺序
 *   2. 认领串行化（CAS）—— 两个人同时点「认领」，只有一个成功
 *   3. 存一份全组事件日志 —— 成员挂了重连能拉回来
 *
 * **不做**：审批流、任务转让、子任务、统计、搜索（DESIGN §21.1 拍过板）。
 *
 * 端口：TCP 48910 可配，0 = 系统分配（§7.1）。
 * 鉴权：口令换 token，之后所有端点要 token；`/info` 不要（用来探测）。
 *
 * @module dsh-collab-board/host/hub
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  WIRE_PROTOCOL,
  EVENT_VERSION,
  MAX_BATCH_BYTES,
  compareEvents,
  dedupeById,
  eventBytes,
  makeEventId,
  validateBatch,
  validateEvent,
} from './events.mjs';
import { SYSTEM_ORIGIN } from './identity.mjs';
import { createDiscovery, createHubWatch } from './discovery.mjs';

/** 心跳 15 秒一次，45 秒无响应视为离线（§13 成员态）。 */
export const HEARTBEAT_MS = 15000;
export const OFFLINE_MS = 45000;
/** 租约默认 10 分钟；`claim` 不传 `leaseMs` 时用它（§6.11）。 */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
export const MAX_LEASE_MS = 86400000;

const MAX_BODY = MAX_BATCH_BYTES + 256 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function fail(res, httpStatus, code, message, extra = {}) {
  json(res, httpStatus, { ok: false, error: { code, message, ...extra } });
}

function ok(res, data) {
  json(res, 200, { ok: true, data });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体太大'), { httpStatus: 413, code: 'too-large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { httpStatus: 400, code: 'bad-param' }));
      }
    });
    req.on('error', reject);
  });
}

/** 写文件用「临时 + rename」，崩溃时不留半截文件。 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * 起一个 Hub。
 *
 * @param {object} opts
 * @param {string} opts.dir        数据目录（`~/.dsh/collab`）
 * @param {string} opts.groupId    组身份（来自 identity.json，**不重新生成**）
 * @param {string} opts.origin     本机 origin（Hub 自己也是一个成员）
 * @param {string} [opts.name]     Hub 显示名
 * @param {number} [opts.port]     48910；0 = 系统分配
 * @param {string} [opts.code]     口令；空 = 不设口令
 * @param {(level:string,msg:string)=>void} [opts.log]
 * @returns {Promise<{info: object, controller: object}>}
 */
export async function startHub(opts = {}) {
  const dir = String(opts.dir || '');
  const groupId = String(opts.groupId || '');
  const selfOrigin = String(opts.origin || '');
  const code = typeof opts.code === 'string' ? opts.code : '';
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  if (!/^[0-9a-f]{16}$/.test(groupId)) throw new Error('Hub 需要一个 16 位十六进制 groupId');
  if (!/^[0-9a-f]{16}$/.test(selfOrigin)) throw new Error('Hub 需要一个 16 位十六进制 origin');

  mkdirSync(dir, { recursive: true });
  const LOG_FILE = join(dir, 'hub-events.jsonl');
  const STATE_FILE = join(dir, 'hub.json');

  /* ─────────────────── 启动前探测（P0-3b） ─────────────────── */

  /**
   * 起 Hub 之前先看看这个组是不是**已经有一个 Hub 在跑**。
   *
   * 探测不到就**不拦**：本来就没 Hub（最常见）、地址填错了、对方关机 —— 这三种都该允许
   * 本机起来，否则「第一次用」永远过不去。探到了才拒绝，除非调用方显式 force。
   */
  if (opts.probeUrl && opts.force !== true) {
    const probe = String(opts.probeUrl).replace(/\/+$/, '');
    try {
      const res = await fetch(`${probe}/collab/v1/info`, { signal: AbortSignal.timeout(5000) });
      const payload = await res.json();
      const info = payload && payload.data;
      if (info && info.groupId === groupId) {
        throw Object.assign(
          new Error(`这个组已经有 Hub 在跑：${probe}（epoch ${info.epoch}，head ${info.headSeq}）`),
          { code: 'already-running', httpStatus: 409 },
        );
      }
      log('info', `启动探测：${probe} 上的 Hub 不是本组（groupId 不同），继续起`);
    } catch (e) {
      if (e && e.code === 'already-running') throw e;
      log('info', `启动探测没探到东西（不拦）：${e && e.message}`);
    }
  }

  /* ─────────────────── 文件存储（§6.7） ─────────────────── */

  const FILES_DIR = join(dir, 'hub-files');
  mkdirSync(FILES_DIR, { recursive: true });
  /** 配额：默认 1 GB。下限 1 KB（够测试和极端小配额用），不是 1 MB。 */
  const MAX_STORE_BYTES = Number.isFinite(Number(opts.maxStoreBytes))
    ? Math.max(1024, Number(opts.maxStoreBytes))
    : 1024 * 1024 * 1024;
  /** 单个文件上限 64 MB（base64 传输，再大就该分块了 —— 分块是 v3）。 */
  const MAX_FILE_BYTES = 64 * 1024 * 1024;

  /** fileId = sha256 前 32 位：内容寻址，同一份文件传两次只存一份（去重）。 */
  function filePathOf(fileId) {
    return join(FILES_DIR, String(fileId).replace(/[^0-9a-f]/g, '').slice(0, 32));
  }

  function storeBytes() {
    let total = 0;
    try {
      for (const name of readdirSync(FILES_DIR)) {
        try { total += statSync(join(FILES_DIR, name)).size; } catch { /* 刚被删 */ }
      }
    } catch { /* 目录还没建 */ }
    return total;
  }

  function fileExists(fileId) {
    try { return existsSync(filePathOf(fileId)); } catch { return false; }
  }

  /**
   * 配额满了就裁旧文件（§17，决策 5：**裁之前必须检查 artifact 引用**）。
   *
   * 按最后访问时间从旧到新裁，但**正在被 artifact 引用的一个都不碰** ——
   * 裁掉正在用的文件是数据丢失，多查一次索引不值得省。
   * 裁完还不够就返回 507，让调用方去删或扩配额，而不是悄悄失败。
   */
  function gcFiles(needBytes) {
    const referenced = new Set();
    for (const ev of events) {
      if (ev && ev.kind === 'artifact' && ev.transfer && ev.transfer.fileId) {
        referenced.add(String(ev.transfer.fileId));
      }
    }
    let rows = [];
    try {
      rows = readdirSync(FILES_DIR).map((name) => {
        const p = join(FILES_DIR, name);
        let st;
        try { st = statSync(p); } catch { return null; }
        return { name, size: st.size, at: st.atimeMs || st.mtimeMs || 0 };
      }).filter(Boolean);
    } catch {
      return 0;
    }
    rows.sort((a, b) => a.at - b.at);
    let freed = 0;
    for (const row of rows) {
      if (freed >= needBytes) break;
      if (referenced.has(row.name)) continue; // 引用检查
      try {
        unlinkSync(join(FILES_DIR, row.name));
        freed += row.size;
        log('info', `配额裁剪：删掉未被引用的文件 ${row.name}（${row.size} 字节）`);
      } catch { /* 删不掉就试下一个 */ }
    }
    return freed;
  }


  /* ─────────────────── 状态 ─────────────────── */

  /** 全组事件（内存映出日志）。 */
  let events = [];
  /** taskId → 最新的那条 task 事件（按 (epoch,seq,id) 取最大）。 */
  let tasks = new Map();
  /** token → { origin, name, capabilities, status, lastSeen } */
  let members = new Map();
  /** capability → Set<origin>（从 member 事件重建，§28） */
  let capIndex = new Map();
  /** claimId → { taskId, origin, seq, at }（持久化最近 1000 条，§14） */
  let claims = new Map();
  /** 依赖索引：taskId → Set<taskId>（谁依赖我）。崩溃从日志重建（§15）。 */
  let dependents = new Map();

  let epoch = 1;
  let headSeq = 0;
  /** 认领串行化：所有 claim 走同一条 Promise 链，天然 CAS。 */
  let claimChain = Promise.resolve();
  /**
   * 系统写入熔断（§6.10.3）。
   *
   * 系统事件写不进去时**不能反复重试**（只会刷日志），所以置熔断位；
   * `/system/recover` 是唯一恢复途径 —— 再试一次，写进去才清。
   * 普通成员写的错误不影响它：熔断只描述「系统自己还能不能留痕」。
   */
  let fuse = { broken: false, since: null, lastError: '' };

  /* ─────────────────── 从日志恢复 ─────────────────── */

  function readLog() {
    if (!existsSync(LOG_FILE)) return [];
    let text = '';
    try {
      text = readFileSync(LOG_FILE, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t === '') continue;
      try {
        const e = JSON.parse(t);
        if (e && typeof e === 'object') out.push(e);
      } catch {
        /* 半行跳过 —— 一行坏 JSON 不该弄死 Hub */
      }
    }
    return out;
  }

  /** 重建任务表 / 能力索引 / 幂等表。顺序：按权威序逐条应用。 */
  function rebuild() {
    tasks = new Map();
    capIndex = new Map();
    dependents = new Map();
    for (const ev of events) applyIndex(ev);
  }

  function applyIndex(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'task' && ev.taskId) {
      const prev = tasks.get(ev.taskId);
      if (!prev || compareEvents(ev, prev) > 0) {
        tasks.set(ev.taskId, ev);
        // 依赖索引：这条任务依赖谁，就登记到「谁被依赖」上
        for (const dep of Array.isArray(ev.dependsOn) ? ev.dependsOn : []) {
          if (!dependents.has(dep)) dependents.set(dep, new Set());
          dependents.get(dep).add(ev.taskId);
        }
      }
    }
    if (ev.kind === 'member' && ev.origin && ev.action !== 'leave') {
      for (const cap of Array.isArray(ev.capabilities) ? ev.capabilities : []) {
        if (!capIndex.has(cap)) capIndex.set(cap, new Set());
        capIndex.get(cap).add(ev.origin);
      }
    }
  }

  /**
   * 依赖环检测（§6.9）：创建 / 更新任务时 DFS，有环直接拒（`cycle`）。
   *
   * 不给用户留自锁的机会 —— 一条自环的任务永远是 `blocked`，谁都解不开，
   * 界面上看起来只是「一直阻塞着」，很难查。
   */
  function hasCycle(taskId, dependsOn) {
    const seen = new Set();
    const stack = [...(Array.isArray(dependsOn) ? dependsOn : [])];
    while (stack.length) {
      const id = stack.pop();
      if (id === taskId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const t = tasks.get(id);
      if (t && Array.isArray(t.dependsOn)) stack.push(...t.dependsOn);
    }
    return false;
  }

  /**
   * 依赖解锁（§6.10.2）—— 三个条件 + per-task 重入锁，判定表照抄。
   *
   * **只在 `appendEvent()` 成功之后、且只对本请求带进来的新事件调用**。
   * 日志重放 / 索引重建 / 启动补写一律不触发，否则每重启一次就多一对 `task` + `note`。
   */
  const unlocking = new Set();

  function unlockDependents(doneTaskId, doneStatus) {
    const targets = dependents.get(doneTaskId);
    if (!targets || targets.size === 0) return [];
    const unlocked = [];
    for (const targetId of [...targets]) {
      if (unlocking.has(targetId)) continue;
      unlocking.add(targetId);
      try {
        const target = tasks.get(targetId);
        // 判定表最后一行：目标不存在只写 note 提示，不写 task
        if (!target) {
          systemWrite({
            kind: 'note',
            level: 'warn',
            text: `${targetId} 依赖了不存在的任务，跳过解锁`,
          });
          continue;
        }
        // 条件二：只有 blocked 才继续，其余状态一律不动
        if (target.status !== 'blocked') continue;
        // 条件三：全部依赖都 done / cancelled 才写
        const deps = Array.isArray(target.dependsOn) ? target.dependsOn : [];
        const allDone = deps.every((d) => {
          const dep = tasks.get(d);
          return dep && (dep.status === 'done' || dep.status === 'cancelled');
        });
        if (!allDone) continue;

        // task 事件是「后写覆盖」，少带字段就等于把它们删了 —— 必须带全
        systemWrite({
          kind: 'task',
          taskId: target.taskId,
          title: target.title,
          owner: target.owner,
          status: 'pending',
          detail: target.detail,
          dependsOn: target.dependsOn,
          requiredCapabilities: target.requiredCapabilities,
          priority: target.priority,
          tags: target.tags,
          dueAt: target.dueAt,
          archived: target.archived,
        });
        systemWrite({
          kind: 'note',
          level: 'info',
          text: `${doneTaskId} ${doneStatus === 'cancelled' ? '已取消' : '已完成'}，${target.taskId} 的依赖已满足，退回待认领`,
        });
        unlocked.push(targetId);
        log('info', `依赖解锁：${doneTaskId} → ${target.taskId}`);
      } catch {
        // 系统写入熔断时解锁失败：熔断了本来就不该继续写，别把错吞成别的
      } finally {
        unlocking.delete(targetId);
      }
    }
    return unlocked;
  }

  /** 这批新事件里，task 状态变成 done / cancelled 的，触发一次解锁。 */
  function afterAppended(events) {
    for (const ev of events) {
      if (!ev || ev.kind !== 'task' || !ev.taskId) continue;
      if (ev.status !== 'done' && ev.status !== 'cancelled') continue;
      unlockDependents(ev.taskId, ev.status);
    }
  }

  /* ─────────────────── 编号 ─────────────────── */

  /**
   * 分配 seq。同步递增内存，异步 flush 到 hub.json（§7.5 的内存单调 + 异步落盘）。
   *
   * flush 落后于日志是允许的：启动时用 `max(hub.json.headSeq, 日志当前 epoch 最大 seq)`
   * 兜回来（P0-1d）。所以这里丢一次 flush 不会让 seq 倒退。
   */
  let flushTimer = null;
  function scheduleStateFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushState();
    }, 200);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function flushState() {
    try {
      writeAtomic(
        STATE_FILE,
        JSON.stringify({
          epoch,
          headSeq,
          groupId,
          startedAt: startedAt,
          claims: [...claims.entries()].slice(-1000).map(([id, v]) => ({ id, ...v })),
        }) + '\n',
      );
    } catch {
      /* 落盘失败不阻塞写事件；下次启动用日志兜 */
    }
  }

  function nextSeq() {
    headSeq += 1;
    scheduleStateFlush();
    return headSeq;
  }

  /* ─────────────────── 落盘 ─────────────────── */

  function appendEvent(ev) {
    appendFileSync(LOG_FILE, JSON.stringify(ev) + '\n', 'utf8');
    events.push(ev);
    applyIndex(ev);
    return ev;
  }

  /**
   * 系统事件校验器（§6.10.4）—— 比普通事件紧。**只在 systemWrite 里调**。
   *
   * 为什么这么严：系统 origin 能绕过鉴权，如果它还能改 `title` / 把 `owner` 写成别人，
   * 那就等于开了一条「不用 token 也能改任何任务」的后门。所以只留两个动作：
   * 改 `status`、把 `owner` 清空（租约到期要用）。
   */
  function validateSystemEvent(ev) {
    const allowed = ['task', 'note', 'hub'];
    if (!allowed.includes(ev.kind)) throw new Error(`系统事件不允许 kind=${String(ev.kind)}`);
    if (ev.origin !== SYSTEM_ORIGIN) throw new Error('系统事件 origin 必须全 0');
    if (ev.name !== '系统') throw new Error('系统事件 name 必须是「系统」');
    if (eventBytes(ev) > 16 * 1024) throw new Error('系统事件超过 16 KB');

    if (ev.kind === 'task') {
      const cur = tasks.get(ev.taskId);
      if (!cur) throw new Error(`系统事件改的任务不存在：${String(ev.taskId)}`);
      // owner 只许清空，不许写成别人（否则能绕过认领的原子性）
      if (ev.owner !== undefined && ev.owner !== '' && ev.owner !== cur.owner) {
        throw new Error('系统事件不许把 owner 写成别人');
      }
      // 除了 status / owner，其余字段一律不许动
      const frozen = ['title', 'detail', 'dependsOn', 'priority', 'tags', 'dueAt', 'archived', 'requiredCapabilities'];
      for (const f of frozen) {
        if (ev[f] === undefined) continue;
        const a = JSON.stringify(ev[f] ?? null);
        const b = JSON.stringify(cur[f] ?? null);
        if (a !== b) throw new Error(`系统事件不许改 ${f}`);
      }
    }
    return ev;
  }

  /** Hub 内部写一条系统事件：绕过鉴权，但照样过校验器（§6.10.4）。 */
  function systemWrite(partial) {
    const ev = {
      // 调用方的字段先展开，**信封字段后写** —— 顺序反了就会被 partial 覆盖。
      // 之前 hub 启动事件把 Hub 的显示名塞进 `name`，正好盖掉「系统」，
      // 校验器一拦，整个系统写入当场进熔断。名字要记就放 `hubName`。
      ...partial,
      eventVersion: EVENT_VERSION,
      id: makeEventId(SYSTEM_ORIGIN),
      origin: SYSTEM_ORIGIN,
      name: '系统',
      ts: new Date().toISOString(),
      epoch,
      seq: nextSeq(),
    };
    try {
      validateSystemEvent(ev);
      const r = validateEvent(ev, { fromHub: true });
      if (!r.ok) throw new Error(`系统事件校验失败：${r.error.message}`);
      const written = appendEvent(r.event);
      fuse.broken = false;
      return written;
    } catch (e) {
      // 写不进去就置熔断：不再反复试，交给 /system/recover
      fuse.broken = true;
      fuse.since = fuse.since || new Date().toISOString();
      fuse.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /* ─────────────────── 启动恢复 ─────────────────── */

  const startedAt = new Date().toISOString();
  events = dedupeById(readLog().sort(compareEvents));

  // 启动顺序（§7.5，一步都不能省）
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    saved = null;
  }
  const logEpochs = events.map((e) => (Number.isFinite(e.epoch) ? e.epoch : 0));
  const maxLogEpoch = logEpochs.length ? Math.max(...logEpochs) : 0; // P0-1b：epoch 从不猜
  epoch = Math.max(maxLogEpoch, Number.isFinite(saved?.epoch) ? saved.epoch : 0, 1);
  // P0-1a：只取当前 epoch 下的最大 seq，跨 epoch 不可比
  const logMaxSeq = events
    .filter((e) => e.epoch === epoch && Number.isFinite(e.seq))
    .reduce((m, e) => Math.max(m, e.seq), 0);
  // P0-1d：hub.json 可能落后于日志，取大
  const savedHead = Number.isFinite(saved?.headSeq) && saved?.epoch === epoch ? saved.headSeq : 0;
  headSeq = Math.max(savedHead, logMaxSeq);

  if (Array.isArray(saved?.claims)) {
    for (const row of saved.claims) {
      if (row && typeof row.id === 'string') {
        const { id, ...rest } = row;
        claims.set(id, rest);
      }
    }
  }

  rebuild();

  /* ─────────────────── 成员 ─────────────────── */

  function memberList() {
    const now = Date.now();
    const out = [];
    for (const [token, m] of members) {
      out.push({
        origin: m.origin,
        name: m.name,
        capabilities: m.capabilities,
        status: m.status,
        lastSeen: m.lastSeen,
        online: now - m.lastSeen < OFFLINE_MS,
        token: token.slice(0, 8),
      });
    }
    return out;
  }

  function capabilitiesOf(origin) {
    for (const m of members.values()) {
      if (m.origin === origin) return m.capabilities;
    }
    // 成员不在线时退回到能力索引
    const out = [];
    for (const [cap, set] of capIndex) if (set.has(origin)) out.push(cap);
    return out;
  }

  /** §7.3：在线 + 具备任务要求的全部标签。只返回信息，不影响 claim 结果。 */
  function matchedMembersFor(task) {
    const need = Array.isArray(task?.requiredCapabilities) ? task.requiredCapabilities : [];
    if (need.length === 0) return [];
    const now = Date.now();
    const out = [];
    for (const m of members.values()) {
      if (now - m.lastSeen >= OFFLINE_MS) continue;
      const has = new Set(m.capabilities.map((c) => String(c).toLowerCase()));
      if (need.every((c) => has.has(String(c).toLowerCase()))) {
        out.push({ origin: m.origin, name: m.name, capabilities: m.capabilities });
      }
    }
    return out;
  }

  /** §7.3：warnings 顺序 = requiredCapabilities 原顺序。只比 requiredCapabilities。 */
  function warningsFor(task, claimerCaps) {
    const need = Array.isArray(task?.requiredCapabilities) ? task.requiredCapabilities : [];
    if (need.length === 0) return [];
    const has = new Set(claimerCaps.map((c) => String(c).toLowerCase()));
    const out = [];
    for (const cap of need) {
      if (!has.has(String(cap).toLowerCase())) out.push(`缺 ${cap}`);
    }
    return out;
  }

  /* ─────────────────── 租约 ─────────────────── */

  /**
   * 每 30 秒扫一次 running 任务：`claimedAt + leaseMs` 过了就退回 `pending`。
   *
   * 只动 `running` 且 `leaseMs > 0` 的（§27 幂等）：重复触发、重启重建都不会多写。
   */
  const leaseTimer = setInterval(() => {
    if (fuse.broken) return; // 写不进去就别再刷 —— 等 /system/recover
    const now = Date.now();
    for (const task of tasks.values()) {
      if (task.status !== 'running') continue;
      const lease = Number(task.leaseMs) || 0;
      if (lease <= 0 || !task.claimedAt) continue;
      const end = new Date(task.claimedAt).getTime() + lease;
      if (!Number.isFinite(end) || now < end) continue;
      try {
        systemWrite({
          kind: 'task',
          taskId: task.taskId,
          title: task.title,
          owner: '',
          status: 'pending',
          detail: task.detail,
          dependsOn: task.dependsOn,
          requiredCapabilities: task.requiredCapabilities,
          priority: task.priority,
          tags: task.tags,
          dueAt: task.dueAt,
          archived: task.archived,
        });
        log('warn', `租约到期，任务退回待认领：${task.taskId}`);
      } catch {
        /* 熔断了，下一轮开头会跳过 */
      }
    }
  }, 30000);
  if (typeof leaseTimer.unref === 'function') leaseTimer.unref();

  /* ─────────────────── 路由 ─────────────────── */

  function auth(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-collab-token'] || '');
    if (!token) return null;
    const m = members.get(token);
    if (!m) return null;
    m.lastSeen = Date.now();
    return { token, ...m };
  }

  function urlOf(req) {
    return new URL(req.url || '/', 'http://hub.local');
  }

  async function handle(req, res) {
    const u = urlOf(req);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    // 探活：不要鉴权，用来「确认原 Hub 死没死」（P0-3a）
    if (path === '/collab/v1/info' || path === '/info') {
      if (method !== 'GET') return fail(res, 405, 'bad-param', 'method');
      return ok(res, {
        wireProtocol: WIRE_PROTOCOL,
        eventVersion: EVENT_VERSION,
        epoch,
        headSeq,
        groupId,
        name: opts.name || 'Hub',
        needCode: code !== '',
        port: actualPort,
        startedAt,
        systemBroken: fuse.broken,
        systemBrokenSince: fuse.since,
      });
    }

    if (path === '/collab/v1/join' || path === '/join') {
      if (method !== 'POST') return fail(res, 405, 'bad-param', 'method');
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return fail(res, e.httpStatus || 400, e.code || 'bad-param', e.message);
      }
      if (Number(body.wireProtocol) !== WIRE_PROTOCOL) {
        return fail(res, 400, 'protocol', `wireProtocol 要是 ${WIRE_PROTOCOL}`);
      }
      if (code !== '' && String(body.code || '') !== code) {
        return fail(res, 401, 'bad-code', '口令不对');
      }
      const origin = String(body.origin || '');
      if (!/^[0-9a-f]{16}$/.test(origin)) {
        return fail(res, 400, 'bad-param', 'origin 要 16 位小写十六进制', { field: 'origin' });
      }
      const token = randomBytes(16).toString('hex');
      const name = String(body.name || '成员').slice(0, 64);
      const caps = Array.isArray(body.capabilities) ? body.capabilities.slice(0, 64) : [];
      members.set(token, { origin, name, capabilities: caps, status: 'idle', lastSeen: Date.now() });
      // 注意：**不在这里写 member 事件** —— §6.10.4 规定系统 origin 不许写 member
      // （系统不替人说话、不改成员名）。成员加入由成员自己在 join 成功后写一条。
      log('info', `成员加入：${name} (${origin.slice(0, 6)})`);
      return ok(res, { token, epoch, headSeq, groupId });
    }

    const me = auth(req);
    if (!me) {
      // 有 token 没对上 = 失效；没带 token = 没权限。都不告诉对方区别（防探测）
      return fail(res, 401, 'bad-token', 'token 无效或已失效');
    }

    if (path === '/collab/v1/heartbeat' || path === '/heartbeat') {
      if (method !== 'POST') return fail(res, 405, 'bad-param', 'method');
      let body = {};
      try {
        body = await readBody(req, 64 * 1024);
      } catch (e) {
        return fail(res, e.httpStatus || 400, e.code || 'bad-param', e.message);
      }
      const m = members.get(me.token);
      if (!m) return fail(res, 401, 'bad-token', 'token 无效');
      m.lastSeen = Date.now();
      if (body.status === 'busy' || body.status === 'idle') m.status = body.status;
      if (Array.isArray(body.capabilities)) m.capabilities = body.capabilities.slice(0, 64);
      return ok(res, { epoch, headSeq, online: memberList().filter((x) => x.online).length });
    }

    if (path === '/collab/v1/members' || path === '/members') {
      if (method !== 'GET') return fail(res, 405, 'bad-param', 'method');
      return ok(res, { members: memberList(), epoch });
    }

    // 增量拉
    if (path === '/collab/v1/events' || path === '/events') {
      if (method === 'GET') {
        const since = Number(u.searchParams.get('since') ?? 0);
        const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') ?? 200)));
        const rows = events
          .filter((e) => e.epoch === epoch && Number.isFinite(e.seq) && e.seq > (Number.isFinite(since) ? since : 0))
          .sort(compareEvents)
          .slice(0, limit);
        return ok(res, { events: rows, epoch, headSeq, hasMore: rows.length === limit });
      }

      if (method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(res, e.httpStatus || 400, e.code || 'bad-param', e.message);
        }
        const list = Array.isArray(body) ? body : body.events;
        const r = validateBatch(list, { expectedOrigin: me.origin });
        if (!r.ok) {
          const httpStatus = r.error.code === 'forbidden' ? 403 : r.error.code === 'too-large' ? 413 : 400;
          return fail(res, httpStatus, r.error.code, r.error.message, r.error.field ? { field: r.error.field } : {});
        }
        const accepted = [];
        const appended = [];
        for (const ev of r.events) {
          // 幂等：同 id 已经收过就不重复编号（重投不该让 seq 涨）
          const dup = events.some((e) => e.id === ev.id);
          if (dup) {
            accepted.push({ id: ev.id, duplicate: true });
            continue;
          }
          // 依赖环：写进去之前拦，别让自锁的任务落盘（§6.9）
          if (ev.kind === 'task' && Array.isArray(ev.dependsOn) && ev.dependsOn.length > 0) {
            if (hasCycle(ev.taskId, ev.dependsOn)) {
              return fail(res, 400, 'cycle', `依赖成环：${ev.taskId}`, { field: 'dependsOn' });
            }
          }
          const stamped = { ...ev, epoch, seq: nextSeq() };
          appendEvent(stamped);
          appended.push(stamped);
          accepted.push({ id: stamped.id, epoch: stamped.epoch, seq: stamped.seq });
        }
        // 条件一：解锁只对本请求带进来的新事件触发（重放 / 重建 / 重启都不触发）
        afterAppended(appended);
        return ok(res, { accepted, epoch, headSeq });
      }

      return fail(res, 405, 'bad-param', 'method');
    }

    // 认领：串行 CAS
    if (path === '/collab/v1/tasks/claim' || path === '/tasks/claim') {
      if (method !== 'POST') return fail(res, 405, 'bad-param', 'method');
      let body;
      try {
        body = await readBody(req, 64 * 1024);
      } catch (e) {
        return fail(res, e.httpStatus || 400, e.code || 'bad-param', e.message);
      }

      const taskId = String(body.taskId || '').trim();
      if (!taskId) return fail(res, 400, 'bad-param', '要有 taskId', { field: 'taskId' });

      // leaseMs：省略 = 用默认；0 = 这条任务不开租约；越界 = bad-param（§33）
      let leaseMs = DEFAULT_LEASE_MS;
      if (body.leaseMs !== undefined && body.leaseMs !== null) {
        const n = Number(body.leaseMs);
        if (!Number.isInteger(n) || n < 0 || n > MAX_LEASE_MS) {
          return fail(res, 400, 'bad-param', `leaseMs 必须在 0～${MAX_LEASE_MS}`, { field: 'leaseMs' });
        }
        leaseMs = n;
      }

      const claimId = String(body.claimId || '').trim();

      // 幂等：同一个 claimId 再来一次，返回上次结果，不重复写事件（§14）
      if (claimId && claims.has(claimId)) {
        const prev = claims.get(claimId);
        return ok(res, {
          taskId: prev.taskId,
          epoch: prev.epoch,
          seq: prev.seq,
          leaseMs: prev.leaseMs,
          warnings: prev.warnings || [],
          matchedMembers: [],
          idempotent: true,
        });
      }

      // 串行化：所有 claim 排成一条链，天然不会同时写
      const run = claimChain.then(async () => {
        const task = tasks.get(taskId);
        if (!task) return fail(res, 404, 'bad-param', '没有这条任务', { field: 'taskId' });

        if (task.status === 'cancelled') {
          return fail(res, 409, 'conflict', '任务已取消');
        }
        if (task.owner && task.owner !== me.origin) {
          const ownerName = [...members.values()].find((m) => m.origin === task.owner)?.name || task.owner.slice(0, 6);
          return fail(res, 409, 'conflict', `已被 ${ownerName} 认领`, { owner: task.owner });
        }
        if (task.status === 'done') {
          return fail(res, 409, 'conflict', '任务已完成');
        }

        /**
         * 已经是自己的、还在 running、租约没过 → **幂等返回，不写新事件**。
         *
         * 不加这道短路，重复调 claim 会一条一条往事件流里堆 `running`，
         * 每次 claimedAt 新一点 —— 看起来像「续租被写成了重新认领」。
         * 事件流被它撑大，历史里同一件事出现六七遍。
         * 租约真过期了才允许重认领（那才是续租）。
         */
        if (task.owner === me.origin && task.status === 'running') {
          const lease = Number(task.leaseMs) || 0;
          const end = lease > 0 && task.claimedAt ? new Date(task.claimedAt).getTime() + lease : 0;
          if (!end || end > Date.now()) {
            return ok(res, {
              taskId,
              epoch: Number.isFinite(task.epoch) ? task.epoch : epoch,
              seq: Number.isFinite(task.seq) ? task.seq : headSeq,
              leaseMs: lease,
              warnings: [],
              matchedMembers: [],
              idempotent: true,
              ownedByMe: true,
            });
          }
        }

        // 依赖未完成 → blocked（和 conflict 分开，前端提示不同）
        const blockedBy = (Array.isArray(task.dependsOn) ? task.dependsOn : []).filter((dep) => {
          const d = tasks.get(dep);
          return !d || (d.status !== 'done' && d.status !== 'cancelled');
        });
        if (blockedBy.length) {
          return fail(res, 409, 'blocked', `依赖 ${blockedBy.join('、')} 未完成`, { blockedBy });
        }

        // warnings：请求里的 capabilities 优先，空数组等同不传
        const reqCaps = Array.isArray(body.capabilities) && body.capabilities.length
          ? body.capabilities.slice(0, 64)
          : capabilitiesOf(me.origin);
        const warnings = warningsFor(task, reqCaps);
        const matched = matchedMembersFor(task);

        const ev = {
          eventVersion: EVENT_VERSION,
          id: makeEventId(me.origin),
          origin: me.origin,
          name: me.name,
          ts: new Date().toISOString(),
          epoch,
          seq: nextSeq(),
          kind: 'task',
          taskId,
          title: task.title,
          owner: me.origin,
          status: 'running',
          detail: task.detail,
          dependsOn: task.dependsOn,
          requiredCapabilities: task.requiredCapabilities,
          priority: task.priority,
          tags: task.tags,
          archived: task.archived,
          // 只有 Hub 能写这两个（§6.3）：服务器时间，不信客户端
          claimedAt: new Date().toISOString(),
          leaseMs,
        };
        appendEvent(ev);

        if (claimId) {
          claims.set(claimId, {
            taskId,
            origin: me.origin,
            epoch: ev.epoch,
            seq: ev.seq,
            leaseMs,
            warnings,
            at: Date.now(),
          });
          if (claims.size > 1000) claims.delete(claims.keys().next().value);
          scheduleStateFlush();
        }

        log('info', `${me.name} 认领 ${taskId}（租约 ${leaseMs ? Math.round(leaseMs / 60000) + ' 分钟' : '关'}）`);
        return ok(res, {
          taskId,
          epoch: ev.epoch,
          seq: ev.seq,
          leaseMs,
          warnings,
          matchedMembers: matched,
        });
      });

      // 链断了也要让后面的 claim 继续跑
      claimChain = run.catch(() => {});
      return run;
    }

    // 上传文件（§7.2 POST /files）：JSON + base64。sha256 两端各校验一次。
    if (path === '/collab/v1/files' || path === '/files') {
      if (method !== 'POST') return fail(res, 405, 'bad-param', 'method');
      let body;
      try {
        body = await readBody(req, Math.ceil(MAX_FILE_BYTES * 1.4) + 1024 * 1024);
      } catch (e) {
        return fail(res, e.httpStatus || 400, e.code || 'too-large', e.message);
      }
      const name = String(body?.name || '').slice(0, 200);
      const sha = String(body?.sha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha)) {
        return fail(res, 400, 'bad-param', 'sha256 要 64 位小写十六进制', { field: 'sha256' });
      }
      let buf;
      try {
        buf = Buffer.from(String(body?.data || ''), 'base64');
      } catch {
        return fail(res, 400, 'bad-param', 'data 不是合法 base64', { field: 'data' });
      }
      if (buf.length === 0) return fail(res, 400, 'bad-param', 'data 是空的', { field: 'data' });
      if (buf.length > MAX_FILE_BYTES) {
        return fail(res, 413, 'too-large', `单个文件最多 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
      }
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== sha) {
        return fail(res, 422, 'hash-mismatch', 'sha256 不符，文件可能在路上坏了');
      }
      const fileId = sha.slice(0, 32);
      const dest = filePathOf(fileId);
      const existed = existsSync(dest);
      if (!existed) {
        if (storeBytes() + buf.length > MAX_STORE_BYTES) {
          // 先按引用裁旧文件，裁完还放不下才拒（别直接 507）
          const need = storeBytes() + buf.length - MAX_STORE_BYTES;
          gcFiles(need);
        }
        if (storeBytes() + buf.length > MAX_STORE_BYTES) {
          return fail(res, 507, 'insufficient-storage', 'Hub 存储配额满了（剩下的文件都被任务引用着，没得裁）');
        }
        const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, buf);
        renameSync(tmp, dest);
      }
      log('info', `收到文件 ${name || fileId}（${buf.length} 字节${existed ? '，已存在' : ''}）`);
      return ok(res, { fileId, size: buf.length, name, deduped: existed });
    }

    // 下载（GET /files/:id）。二进制流，不是 JSON —— agent 拿它落成真路径喂给工具。
    const fileMatch = path.match(/^\/(?:collab\/v1\/)?files\/([0-9a-f]{32})$/);
    if (fileMatch) {
      if (method !== 'GET') return fail(res, 405, 'bad-param', 'method');
      const p = filePathOf(fileMatch[1]);
      if (!existsSync(p)) return fail(res, 404, 'bad-param', '没有这个文件');
      let size = 0;
      try { size = statSync(p).size; } catch { return fail(res, 500, 'internal', '读不了文件'); }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(size));
      res.setHeader('x-collab-file-id', fileMatch[1]);
      res.setHeader('cache-control', 'no-store');
      await new Promise((resolve) => {
        const stream = createReadStream(p);
        stream.on('error', () => { try { res.end(); } catch { /* 已经断了 */ } resolve(); });
        stream.on('end', resolve);
        stream.pipe(res);
      });
      return;
    }

    // 熔断恢复：再试写一条系统事件，写进去 = 恢复（§32）
    if (path === '/collab/v1/system/recover' || path === '/system/recover') {
      if (method !== 'POST') return fail(res, 405, 'bad-param', 'method');
      // 没熔断就直接返回 —— 不制造噪音，也让按钮可以无脑点
      if (!fuse.broken) return ok(res, { recovered: true });
      try {
        systemWrite({ kind: 'note', text: '系统写入已恢复', level: 'info' });
        return ok(res, { recovered: true });
      } catch (e) {
        return fail(res, 500, 'system-write-failed', e.message || '系统事件仍无法写入');
      }
    }

    return fail(res, 404, 'bad-param', '没有这个端点');
  }

  /* ─────────────────── 监听 ─────────────────── */

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('warn', `请求出错：${err?.message || err}`);
      if (!res.headersSent) fail(res, 500, 'internal', String(err?.message || err));
      else res.end();
    });
  });

  const wantPort = Number.isInteger(Number(opts.port)) ? Number(opts.port) : 48910;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, '0.0.0.0', resolve);
  });
  const actualPort = server.address().port;

  /* ─────────────────── 发现与双 Hub 告警（§8 / §12.4.1） ─────────────────── */

  /** 检测到第二个 Hub 时记在这里。`null` = 没有分叉。 */
  let fork = null;
  let discovery = null;
  let watchRef = null;

  // watch 无论开不开 UDP 都建：测试要能直接喂广播，不开 socket 也能验告警链路
  const watch = createHubWatch({
    threshold: opts.watchThreshold,
    minDurationMs: opts.watchMinDurationMs,
    onFork: (info) => {
      fork = { ...info, at: new Date().toISOString() };
      try {
        systemWrite({
          kind: 'note',
          level: 'warn',
          text:
            `原 Hub 复活了（origin=${String(info.origin).slice(0, 6)}，${info.host}:${info.port}）。`
            + '两个 Hub 并存中，序号可能重复、事件流已分叉，需要人工决定谁是权威 Hub。',
        });
      } catch { /* 熔断中写不进去也没关系，状态还在 */ }
    },
    log,
  });
  watchRef = watch;

  if (opts.noDiscovery !== true) {
    try {
      discovery = await createDiscovery({
        groupId,
        origin: selfOrigin,
        name: opts.name || 'Hub',
        port: actualPort,
        needCode: code !== '',
        epoch,
        code,
        discoveryPort: opts.discoveryPort,
        quiet: opts.noBroadcast === true,
        onPeer: (info) => watch.observe(info),
        log,
      });
      log('info', `UDP 发现已开：端口 ${discovery.port}`);
    } catch (e) {
      // 发现是增强能力，起不来不该让 Hub 也起不来
      log('warn', `UDP 发现起不来（协作照常，只是发现不到别的 Hub）：${e.message}`);
      discovery = null;
    }
  }

  // 起 Hub 这件事本身要留痕，不然别人不知道这个组换过任期
  try {
    systemWrite({
      kind: 'hub',
      // 注意字段名是 hubName 不是 name —— 信封的 name 是保留字段（必须「系统」）
      hubName: opts.name || 'Hub',
      host: '0.0.0.0',
      port: actualPort,
      needCode: code !== '',
      groupId,
    });
  } catch {
    /* 写不进去也要让 Hub 起来 —— 服务比一条日志重要 */
  }

  const controller = {
    info: () => ({
      wireProtocol: WIRE_PROTOCOL,
      epoch,
      headSeq,
      groupId,
      port: actualPort,
      needCode: code !== '',
      members: memberList().length,
      events: events.length,
      startedAt,
      systemBroken: fuse.broken,
      systemBrokenSince: fuse.since,
      files: { count: readdirSync(FILES_DIR).length, bytes: storeBytes() },
      fork,
      peers: discovery ? discovery.livePeers() : [],
    }),
    members: memberList,
    tasks: () => [...tasks.values()],
    systemWrite,
    fork: () => fork,
    peers: () => (discovery ? discovery.livePeers() : []),
    clearFork: () => { fork = null; },
    /** 仅供测试：直接喂一条「别的 Hub 在广播」，跳过 UDP。 */
    observePeer: (info, now) => (watchRef ? watchRef.observe(info, now) : null),
    close: async () => {
      clearInterval(leaseTimer);
      if (flushTimer) clearTimeout(flushTimer);
      flushState();
      if (discovery) {
        try { await discovery.close(); } catch { /* 关不掉也别卡住 */ }
        discovery = null;
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };

  log('info', `Hub 已启动：端口 ${actualPort}，epoch ${epoch}，日志 ${events.length} 条，groupId ${groupId.slice(0, 6)}`);

  return { info: controller.info(), controller };
}
