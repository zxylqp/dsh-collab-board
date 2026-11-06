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
  HUB_ONLY_FIELDS,
  compareEvents,
  dedupeById,
  eventBytes,
  makeEventId,
  validateBatch,
  validateEvent,
} from './events.mjs';
import { SYSTEM_ORIGIN, isOrigin } from './identity.mjs';
import { createDiscovery, createHubWatch } from './discovery.mjs';
import { json, readBody, writeAtomic } from './http-util.mjs';
import { ownerTransitionError, isTaskActivity } from './selectable.mjs';
import { verifyHubCode } from './settings.mjs';

/** 心跳 15 秒一次，45 秒无响应视为离线（§13 成员态）。 */
export const HEARTBEAT_MS = 15000;
export const OFFLINE_MS = 45000;
/** 租约默认 10 分钟；`claim` 不传 `leaseMs` 时用它（§6.11）。 */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
export const MAX_LEASE_MS = 86400000;
/**
 * 续约上限：从认领那一刻算，最多撑到 `4 × leaseMs`。
 *
 * 没有上限的续约等于「谁一直发进度谁就永久占卡」——一个空转的 agent
 * 能靠每 5 分钟发一条进度把卡锁死，别人永远认领不到。有上限至少保证
 * 每 40 分钟必须重新认领一次，卡不会烂在死人手里。
 */
export const LEASE_MAX_FACTOR = 4;
/** 剩余租约掉到这个比例时发一条 warn note，提醒「快到期了」，每条租约只发一次。 */
export const LEASE_WARN_FRACTION = 0.25;

/**
 * 一条任务此刻的租约终点（毫秒时间戳）：认领时算出的终点、续约水印，取大。
 *
 * 纯函数：`hub.json` 里恢复、定时器扫描、续约判定都走它，免得三处算法各写一遍。
 */
export function leaseEndAt({ claimedAt, leaseMs, renewedUntil } = {}) {
  const lease = Number(leaseMs) || 0;
  const t = claimedAt ? new Date(claimedAt).getTime() : NaN;
  if (lease <= 0 || !Number.isFinite(t)) return 0;
  return Math.max(t + lease, Number(renewedUntil) || 0);
}

/**
 * 这次续约能推到哪（毫秒时间戳）。`now + leaseMs`，但绝不越过
 * `claimedAt + leaseMs × LEASE_MAX_FACTOR`。
 */
export function leaseRenewAt({ claimedAt, leaseMs, now } = {}) {
  const lease = Number(leaseMs) || 0;
  const t = claimedAt ? new Date(claimedAt).getTime() : NaN;
  const n = Number(now);
  if (lease <= 0 || !Number.isFinite(t) || !Number.isFinite(n)) return 0;
  return Math.min(t + lease * LEASE_MAX_FACTOR, n + lease);
}

/** Hub 的响应外壳：成功带 `data`，失败带 `error` —— 和面板侧的平铺响应不是一回事。 */
function fail(res, httpStatus, code, message, extra = {}) {
  json(res, httpStatus, { ok: false, error: { code, message, ...extra } });
}

function ok(res, data) {
  json(res, 200, { ok: true, data });
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
  /**
   * 租约扫描间隔。默认 30 秒；测试里传小值，不然验一次「到期释放」要等半分钟。
   * 调小只影响判断频率，不改变租约时长本身。
   */
  const leaseTickMs = Number.isFinite(Number(opts.leaseTickMs)) && Number(opts.leaseTickMs) >= 10
    ? Number(opts.leaseTickMs)
    : 30000;

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
  /**
   * taskId → 创建者 origin（第一条 task 事件的 origin）。
   *
   * 为什么要有它：taskId 是各机器本地生成的，两台机器可能发出同一个 id。
   * 只按 taskId 折叠的话，后到的那条会把别人的卡整条覆盖（R5 真机撞号）。
   * 有了 creator 才能把「认领 / 完成」和「整条改写」分开判。
   */
  let creators = new Map();
  /**
   * taskId → 折叠后的任务视图（缺省字段沿用上一版）。
   *
   * `tasks` 存的是「最新那条原始事件」，认领 / 完成这类事件不带 title/detail，
   * 直接拿原始事件比字段会把「没带」误判成「改了」。撞号检查要的是语义变更，
   * 所以单开一份折叠视图。
   */
  let folded = new Map();
  /** token → { origin, name, status, lastSeen } */
  let members = new Map();
  /** claimId → { taskId, origin, seq, at }（持久化最近 1000 条，§14） */
  let claims = new Map();
  /**
   * taskId → { until, warnedFor }（续约水印，持久化到 hub.json）。
   *
   * 为什么必须落盘：任务本身是日志重放出来的，`claimedAt + leaseMs` 是唯一
   * 算得出来的租约终点；续约是**内存里的事件**，不写盘的话 Hub 一重启，
   * 一个已经续到 35 分钟的长任务会被当成只剩 10 分钟。
   */
  let leases = new Map();
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

  /** 重建任务表 / 幂等表。顺序：按权威序逐条应用。 */
  function rebuild() {
    tasks = new Map();
    creators = new Map();
    folded = new Map();
    dependents = new Map();
    for (const ev of events) applyIndex(ev);
  }

  function applyIndex(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'task' && ev.taskId) {
      // 第一条落盘的 task 事件定创建者；后面的认领 / 完成 / 评论都归它管。
      if (!creators.has(ev.taskId)) creators.set(ev.taskId, ev.origin);
      /**
       * 墓碑（0.10.14）：折叠成只剩 id 的空壳。
       * 正文在**所有机器**上都不再从这张卡里读出来 —— 日志行还在（同步不能断），
       * 但标题/描述/标签/负责人一律当空。
       */
      if (ev.deleted === true) {
        const shell = {
          ...ev,
          title: '',
          detail: '',
          owner: '',
          tags: [],
          dependsOn: [],
          requiredCapabilities: [],
          dueAt: '',
          archived: false,
          status: 'cancelled',
        };
        folded.set(ev.taskId, shell);
        tasks.set(ev.taskId, shell);
        return;
      }
      const prevF = folded.get(ev.taskId) || {};
      folded.set(ev.taskId, {
        ...prevF,
        ...ev,
        title: 'title' in ev ? ev.title : prevF.title,
        detail: 'detail' in ev ? ev.detail : prevF.detail,
        dependsOn: 'dependsOn' in ev ? ev.dependsOn : prevF.dependsOn,
      });
      const prev = tasks.get(ev.taskId);
      if (!prev || compareEvents(ev, prev) > 0) {
        /**
         * Hub 专属字段（`claimedAt` / `leaseMs`）**不会被成员带上来**
         * （`HUB_ONLY_FIELDS` 拦着）。折叠时如果不从上一版继承，任何一条普通
         * task 事件（改标题、标进度）都会把它们抹掉 —— 租约终点当场变 0，
         * 卡永远不过期，也不再被扫描释放。这是「改个标题把租约丢了」的真身。
         * 换 owner 时不继承：那是重新认领，claimedAt 必须换新的。
         */
        const next = { ...ev };
        if (prev && (next.owner === undefined || next.owner === prev.owner)) {
          for (const f of HUB_ONLY_FIELDS) {
            if (next[f] === undefined && prev[f] !== undefined) next[f] = prev[f];
          }
        }
        tasks.set(ev.taskId, next);
        // 依赖索引：这条任务依赖谁，就登记到「谁被依赖」上
        for (const dep of Array.isArray(ev.dependsOn) ? ev.dependsOn : []) {
          if (!dependents.has(dep)) dependents.set(dep, new Set());
          dependents.get(dep).add(ev.taskId);
        }
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
        /**
         * 解锁要真的把人叫醒，不能只把卡退回 pending（§6.10.2）。
         *
         * 原来这里只写 task 事件 —— 对端 `shouldWake` 只认 msg，于是卡变回
         * 待认领，但没有任何机器知道「该开工了」。autoClaim 会认领，可认领
         * 不唤醒，卡就停在 running 上没人动。
         *
         * 收件人优先级：当前 owner → 创建者。blocked 的卡通常没有 owner
         * （认领被 blocked 拒掉时不会记 owner），所以创建者是实际能接的人。
         * 两个都没有就不发 —— 宁可不叫，也不要广播叫醒所有人。
         */
        const to = target.owner || creators.get(target.taskId) || '';
        // 日志裁过之后，creator 可能被算成系统 origin（重建时第一条就是系统写的
        // pending 事件）—— 发给全 0 等于没人收，不如不发。
        if (isOrigin(to) && to !== SYSTEM_ORIGIN) {
          systemWrite({
            kind: 'msg',
            from: '系统',
            taskId: target.taskId,
            to,
            text: `${doneTaskId} ${doneStatus === 'cancelled' ? '已取消' : '已完成'}，`
              + `${target.taskId}「${target.title}」的依赖已经满足，可以开始了。`,
          });
        }
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
          /** 续约水印也跟着任务量截断：一万条 running 卡不该把 hub.json 撑爆。 */
          leases: [...leases.entries()].slice(-2000).map(([taskId, v]) => ({ taskId, ...v })),
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
   * 擦掉某张卡在日志里的正文（墓碑落地时调一次）。
   *
   * **只改内容，不动 id / seq / 顺序** —— 改顺序等于重造历史，别的机器对不上账。
   * 不同步的只有本机这一份：别的机器收到的是墓碑事件，它们收到后各自擦自己的日志。
   */
  function scrubTaskBody(taskId) {
    let hit = 0;
    for (const e of events) {
      if (e.kind !== 'task' || e.taskId !== taskId) continue;
      if (e.deleted === true) continue; // 墓碑本身要留 deleted / deletedAt
      e.title = '';
      e.detail = '';
      e.owner = '';
      e.tags = [];
      e.dependsOn = [];
      e.requiredCapabilities = [];
      e.dueAt = '';
      hit += 1;
    }
    if (hit === 0) return 0;
    try {
      writeAtomic(LOG_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch {
      /* 写不动就先只在内存里擦；下次收到墓碑再试 */
    }
    return hit;
  }

  /**
   * 系统事件校验器（§6.10.4）—— 比普通事件紧。**只在 systemWrite 里调**。
   *
   * 为什么这么严：系统 origin 能绕过鉴权，如果它还能改 `title` / 把 `owner` 写成别人，
   * 那就等于开了一条「不用 token 也能改任何任务」的后门。所以只留两个动作：
   * 改 `status`、把 `owner` 清空（租约到期要用）。
   */
  function validateSystemEvent(ev) {
    const allowed = ['task', 'note', 'hub', 'msg'];
    if (!allowed.includes(ev.kind)) throw new Error(`系统事件不允许 kind=${String(ev.kind)}`);
    if (ev.origin !== SYSTEM_ORIGIN) throw new Error('系统事件 origin 必须全 0');
    if (ev.name !== '系统') throw new Error('系统事件 name 必须是「系统」');
    if (eventBytes(ev) > 16 * 1024) throw new Error('系统事件超过 16 KB');

    /**
     * 系统 msg：只当「叫醒某一个人」用，不是广播通道（§6.10.2）。
     *
     * 为什么要放开它：依赖解锁写的是 `task` 事件，对端 `shouldWake` 判
     * not-msg —— 卡退回 pending 了，却没有一台机器被叫醒，链就停在那儿。
     * 为什么不干脆放开广播：一张卡解锁会把所有开着 wakeOnMessage 的机器
     * 都点醒一轮，每轮都是一整轮 token。所以必须点名 `to`、必须挂一张真卡。
     */
    if (ev.kind === 'msg') {
      if (typeof ev.taskId !== 'string' || ev.taskId.trim() === '') {
        throw new Error('系统 msg 必须挂一张任务');
      }
      if (!tasks.has(String(ev.taskId))) throw new Error(`系统 msg 挂的任务不存在：${String(ev.taskId)}`);
      if (!isOrigin(ev.to)) throw new Error('系统 msg 必须带 to（成员 origin）');
      if (typeof ev.text !== 'string' || ev.text.trim() === '' || ev.text.length > 1024) {
        throw new Error('系统 msg 文本为空或超过 1024 字');
      }
      for (const f of ['status', 'owner', 'title', 'detail', 'dependsOn', 'archived']) {
        if (ev[f] !== undefined) throw new Error(`系统 msg 不许带 ${f}`);
      }
    }

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
  if (Array.isArray(saved?.leases)) {
    for (const row of saved.leases) {
      if (!row || typeof row.taskId !== 'string') continue;
      const until = Number(row.until);
      if (!Number.isFinite(until) || until <= Date.now()) continue;
      leases.set(row.taskId, { until, warnedFor: Number(row.warnedFor) || 0 });
    }
  }

  rebuild();

  /* ─────────────────── 成员 ─────────────────── */

  /**
   * 成员列表：**按 origin 去重**，同一个人的旧 token 不重复出现。
   *
   * 为什么要去重：每次重连（重启、断线）都发一个新 token，旧 token 不会自己消失。
   * 不去重的话接口里同一个人会出现好几条，内存也一直涨，看起来像「怎么越连人越多」。
   */
  function memberList() {
    const now = Date.now();
    const byOrigin = new Map();
    for (const [token, m] of members) {
      const prev = byOrigin.get(m.origin);
      if (!prev || (Number(m.lastSeen) || 0) > (Number(prev.lastSeen) || 0)) {
        byOrigin.set(m.origin, {
          origin: m.origin,
          name: m.name,
          status: m.status,
          lastSeen: m.lastSeen,
          online: now - m.lastSeen < OFFLINE_MS,
          token: token.slice(0, 8),
        });
      }
    }
    return [...byOrigin.values()];
  }

  /* ─────────────────── 租约 ─────────────────── */

  /** 这条任务此刻的租约终点：认领时算出来的，和续约水印取大。 */
  function leaseEndOf(task) {
    return leaseEndAt({
      claimedAt: task?.claimedAt,
      leaseMs: task?.leaseMs,
      renewedUntil: leases.get(String(task?.taskId || ''))?.until,
    });
  }

  /**
   * 进度续约：owner 往自己认领的卡上写「活动」，就把租约往后推。
   *
   * 为什么按事件而不是按定时器：定时续约等于永不过期 —— 机器断电了 Hub
   * 还在替它续。**只有真在干活才算数**。
   *
   * 「活动」的判据只有一份，在 `selectable.mjs` 的 `isTaskActivity`：
   * progress / artifact / 带 status 或 owner 的 task。`note` **不算**
   * （事件模型里没有「progress 类 note」，想续约就写 progress）。
   *
   * 上限 `LEASE_MAX_FACTOR × leaseMs`，从 claimedAt 起算；延长不到 5 秒就不动，
   * 免得每写一条进度都刷一次 hub.json。续到上限时记 `exhausted`，
   * 到期释放时据此写不同的 note —— 「续到顶了」和「压根没干」不是一回事。
   */
  function renewLease(ev) {
    const taskId = String(ev?.taskId || '').trim();
    if (!taskId) return;
    const task = tasks.get(taskId);
    if (!task || task.status !== 'running' || !task.owner) return;
    if (!isTaskActivity(ev, task)) return;
    const lease = Number(task.leaseMs) || 0;
    if (lease <= 0 || !task.claimedAt) return;
    const cap = new Date(task.claimedAt).getTime() + lease * LEASE_MAX_FACTOR;
    const next = leaseRenewAt({ claimedAt: task.claimedAt, leaseMs: lease, now: Date.now() });
    // 延长的还不到「租约的 5%」（最长 5 秒）就不写盘：短租约也能正常续，长租约不会每条进度都刷一次
    if (next <= leaseEndOf(task) + Math.min(5000, lease * 0.05)) return;
    // 续约后终点变了，之前那条「快到期」提醒作废：新终点前再提醒一次
    leases.set(taskId, { until: next, warnedFor: 0, ...(Number.isFinite(cap) && next >= cap - 1 ? { exhausted: true } : {}) });
    scheduleStateFlush();
  }

  /**
   * 每 30 秒扫一次 running 任务：`claimedAt + leaseMs` 过了就退回 `pending`。
   *
   * 只动 `running` 且 `leaseMs > 0` 的（§27 幂等）：重复触发、重启重建都不会多写。
   * 剩余不足 1/4 时先发一条 warn note —— 「被释放」比「没叫醒」更难查，
   * 至少让看板上有一句话，而不是到点卡自己变回待认领。
   */
  const leaseTimer = setInterval(() => {
    if (fuse.broken) return; // 写不进去就别再刷 —— 等 /system/recover
    const now = Date.now();
    for (const task of tasks.values()) {
      const taskId = String(task.taskId || '');
      if (task.status !== 'running') {
        // 卡已经不在自己手里了（完成 / 取消 / 被释放），续约水印留着没意义
        if (leases.has(taskId)) { leases.delete(taskId); scheduleStateFlush(); }
        continue;
      }
      const lease = Number(task.leaseMs) || 0;
      if (lease <= 0 || !task.claimedAt) continue;
      const end = leaseEndOf(task);
      if (!Number.isFinite(end) || end <= 0) continue;

      // 快到期：先说话，别让它静默地变回待认领
      if (now < end) {
        const left = end - now;
        const warned = Number(leases.get(taskId)?.warnedFor) || 0;
        if (left <= lease * LEASE_WARN_FRACTION && warned !== end) {
          const row = leases.get(taskId) || {};
          leases.set(taskId, { ...row, until: Number(row.until) || end, warnedFor: end });
          scheduleStateFlush();
          try {
            systemWrite({
              kind: 'note',
              level: 'warn',
              text: `任务 ${taskId} 的租约还剩 ${Math.max(1, Math.round(left / 60000))} 分钟，`
                + `到期会退回待认领。还在干就写一条 progress（会自动续约），干完了就改 done。`,
            });
            log('warn', `租约快到期：${taskId}（剩 ${Math.max(1, Math.round(left / 60000))} 分钟）`);
          } catch { /* 熔断了，下一轮开头会跳过 */ }
        }
        continue;
      }

      /**
       * 到期释放先说清楚是哪种到期（lease-exhausted）：
       * 续约已经到 4× 上限 → 「用尽了」；否则 → 「期间没写进度」。
       * 两种在看板上原来都是同一条 `task → pending`，分不出来谁该被催。
       */
      const leaseRow = leases.get(taskId);
      try {
        systemWrite({
          kind: 'note',
          level: leaseRow?.exhausted ? 'warn' : 'info',
          text: leaseRow?.exhausted
            ? `任务 ${taskId} 的续约已到上限（${LEASE_MAX_FACTOR}× 租约），到期退回待认领 —— `
              + '不是「没干活」，是租约用尽了；要继续就重新认领。'
            : `任务 ${taskId} 的租约到期，期间没有写入 progress / artifact，退回待认领。`,
        });
      } catch { /* 熔断了：下面的 task 也写不进去，交给下一轮 */ }

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
        leases.delete(taskId);
        scheduleStateFlush();
        log('warn', `租约到期，任务退回待认领：${task.taskId}`);
      } catch {
        /* 熔断了，下一轮开头会跳过 */
      }
    }
  }, leaseTickMs);
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

  /**
   * 普通写路径的 owner 迁移规则 —— 认领 CAS 的补口（§6.3）。
   *
   * 认领本来走 `/tasks/claim` 的串行 CAS，谁也抢不走。但成员还能直接推一条
   * `kind:task` 的普通事件，把 `owner` 改成自己 —— 那就等于从旁边绕过 CAS。
   * `HUB_ONLY_FIELDS` 只拦了 `claimedAt` / `leaseMs`，拦不住 `owner`。
   *
   * 允许三种迁移，其余一律 403：
   *   1. 不变（改标题 / 状态 / 标签，owner 跟着走）
   *   2. 空 → 自己（接手一张没人认领的卡）
   *   3. 自己 → 空（主动释放）
   *
   * 「空 → 自己」不走 CAS，严格说仍是并发窗口；但空卡本来就没有归属可抢，
   * 两个人的最后一条谁先落盘谁赢，和直接 claim 的结果一致。要真正原子认领
   * 还是得调 `/tasks/claim`。
   */
  function checkOwnerWrite(ev, writer) {
    const prev = tasks.get(ev.taskId);
    // 规则本体在 selectable.mjs —— 宿主本地预检用的也是同一份，别在这儿再抄一遍。
    const err = ownerTransitionError({
      nextOwner: ev.owner,
      prevOwner: prev ? prev.owner : '',
      writer,
      hasTask: Boolean(prev),
    });
    if (!err) return null;
    const cur = typeof prev?.owner === 'string' ? prev.owner : '';
    if (!cur) return err;
    const ownerName = [...members.values()].find((m) => m.origin === cur)?.name || `${cur.slice(0, 6)}…`;
    return { message: `不能改别人认领的任务（当前是 ${ownerName}）；要抢先用 /tasks/claim` };
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
      /**
       * 口令校验（0.10.16 起 `code` 是哈希）。
       * 三种输入都认：本机存的哈希（成员重启后只能拿这个）、人输入的明文、
       * 升级前的明文存储。盐是本组 groupId —— 两台机器算出来必须一样。
       */
      if (code !== '' && !verifyHubCode(code, String(body.code || ''), groupId)) {
        return fail(res, 401, 'bad-code', '口令不对');
      }
      const origin = String(body.origin || '');
      if (!/^[0-9a-f]{16}$/.test(origin)) {
        return fail(res, 400, 'bad-param', 'origin 要 16 位小写十六进制', { field: 'origin' });
      }
      const token = randomBytes(16).toString('hex');
      const name = String(body.name || '成员').slice(0, 64);
      members.set(token, { origin, name, status: 'idle', lastSeen: Date.now() });
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
        /**
         * owner 继承：改标题时不该被迫把 owner 一起带上，更不该因为没带就被
         * 当成「释放」。**没显式给 owner 就沿用当前值**；显式给了（包括空串）
         * 才按 checkOwnerWrite 的迁移规则判。
         */
        const prepped = Array.isArray(list)
          ? list.map((raw) => {
            if (!raw || raw.kind !== 'task') return raw;
            const id = String(raw.taskId || raw.id || '').trim();
            const prev = id ? tasks.get(id) : null;
            if (prev && !('owner' in raw)) return { ...raw, owner: prev.owner };
            return raw;
          })
          : list;
        const r = validateBatch(prepped, { expectedOrigin: me.origin });
        if (!r.ok) {
          const httpStatus = r.error.code === 'forbidden' ? 403 : r.error.code === 'too-large' ? 413 : 400;
          return fail(res, httpStatus, r.error.code, r.error.message, r.error.field ? { field: r.error.field } : {});
        }
        const accepted = [];
        const appended = [];
        for (const ev of r.events) {
          // 幂等：同 id 已经收过就不重复编号（重投不该让 seq 涨）。
          // **但要把已存在的 epoch/seq 一起回给客户端** —— 否则对方拿不到序号，
          // 在它本地的 sidecar 里这条永远算「没同步」，面板永久显示待同步（R10 真机实测）。
          const dup = events.find((e) => e.id === ev.id);
          if (dup) {
            accepted.push({ id: ev.id, duplicate: true, epoch: dup.epoch, seq: dup.seq });
            continue;
          }
          // 身份撞号：taskId 归创建者。别人可以认领 / 完成 / 评论，但不能把
          // 标题、描述、依赖整条改写 —— 那正是 R5 真机撞号的样子：两张本地编号
          // 相同的卡被折叠成一张，后推的赢，前一张凭空消失。
          //
          // 墓碑是唯一例外：删除就是把正文擦空，不豁免的话「删别人的卡」永远 409。
          const isTombstone = ev.kind === 'task' && ev.deleted === true;
          if (ev.kind === 'task' && !isTombstone) {
            const creator = creators.get(ev.taskId);
            const prevTask = folded.get(ev.taskId);
            if (prevTask && creator && ev.origin !== creator) {
              // detail 只比「有内容的变更」：validateBatch 会把缺省字段归一成空串，
              // 认领 / 完成这类事件本来就不带 detail，空串 ≠ 改描述。
              const changed = ('title' in ev && ev.title !== prevTask.title)
                || ('detail' in ev && ev.detail !== '' && ev.detail !== prevTask.detail)
                || ('dependsOn' in ev
                  && JSON.stringify(ev.dependsOn || []) !== JSON.stringify(prevTask.dependsOn || []));
              if (changed) {
                return fail(res, 409, 'conflict',
                  `任务 ${ev.taskId} 是 ${creator.slice(0, 6)}… 创建的，别的成员不能改标题/描述/依赖；认领走 /tasks/claim，完成改 status`,
                  { field: 'taskId' });
              }
            }
          }
          // owner 迁移：普通写路径不许抢别人已认领的卡（CAS 的补口）。墓碑同理豁免。
          if (ev.kind === 'task' && !isTombstone) {
            const blocked = checkOwnerWrite(ev, me.origin);
            if (blocked) return fail(res, 403, 'forbidden', blocked.message, { field: 'owner' });
          }
          // 依赖环：写进去之前拦，别让自锁的任务落盘（§6.9）
          if (ev.kind === 'task' && Array.isArray(ev.dependsOn) && ev.dependsOn.length > 0) {
            if (hasCycle(ev.taskId, ev.dependsOn)) {
              return fail(res, 400, 'cycle', `依赖成环：${ev.taskId}`, { field: 'dependsOn' });
            }
          }
          const stamped = { ...ev, epoch, seq: nextSeq() };
          appendEvent(stamped);
          // 干活就有租约：progress / artifact 推上来时顺手续掉，别让人手动续
          renewLease(stamped);
          // 墓碑落地：把这张卡的历史正文从日志里擦掉，然后按擦干净的事件重建索引
          if (stamped.kind === 'task' && stamped.deleted === true) {
            scrubTaskBody(stamped.taskId);
            leases.delete(String(stamped.taskId));
            rebuild();
            scheduleStateFlush();
            log('info', `墓碑：${stamped.taskId} 正文已擦除`);
          }
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
      /**
       * 认领时可以带一句「为什么接 / 打算怎么做」。只写进 running 事件，
       * 不参与任何判定 —— 是给人（和下一轮读看板的 agent）看的观测字段。
       */
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
      const plan = typeof body.plan === 'string' ? body.plan.trim().slice(0, 500) : '';

      // 幂等：同一个 claimId 再来一次，返回上次结果，不重复写事件（§14）
      if (claimId && claims.has(claimId)) {
        const prev = claims.get(claimId);
        return ok(res, {
          taskId: prev.taskId,
          epoch: prev.epoch,
          seq: prev.seq,
          leaseMs: prev.leaseMs,
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
          ...(reason ? { reason } : {}),
          ...(plan ? { plan } : {}),
        };
        appendEvent(ev);

        if (claimId) {
          claims.set(claimId, {
            taskId,
            origin: me.origin,
            epoch: ev.epoch,
            seq: ev.seq,
            leaseMs,
            at: Date.now(),
          });
          if (claims.size > 1000) claims.delete(claims.keys().next().value);
          scheduleStateFlush();
        }

        log('info', `${me.name} 认领 ${taskId}（租约 ${leaseMs ? Math.round(leaseMs / 60000) + ' 分钟' : '关'}）`);
        // 新认领 = 新的租约起点，旧的续约水印作废（否则重认领后会带着上一次的延长）
        if (leases.delete(taskId)) scheduleStateFlush();
        return ok(res, {
          taskId,
          epoch: ev.epoch,
          seq: ev.seq,
          leaseMs,
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
