/**
 * 协作看板 · 事件信封 / 校验 / 排序
 *
 * 这一份是全链路的唯一实现：写日志、Hub 落盘、成员合并、UI 排序都调这里。
 * 写两处就一定会有一天对不上（DESIGN §6.4 的教训）。
 *
 * 三个概念别混（§6.4 的警告）：
 *   - `(epoch, seq)`  是 Hub 分配的**权威顺序**
 *   - `id`            是唯一稳定末位键，只在两个 Hub 并存、seq 撞了时才起作用
 *   - `ts`            只显示，**不排序**（各机器时钟不一样）
 *
 * @module dsh-collab-board/host/events
 */

/** 协议版本号。握手时对不上就拒（§7）。 */
export const WIRE_PROTOCOL = 1;
export const EVENT_VERSION = 2;

/** 单条上限（§6.6）。 */
export const MAX_SINGLE_BYTES = 64 * 1024;
/** `artifact` + `transfer.mode === 'inline'` 的单条特例。 */
export const MAX_INLINE_BYTES = 96 * 1024;
/** 批量上限（§6.6）：先算字节、再算条数。 */
export const MAX_BATCH_BYTES = 1024 * 1024;
export const MAX_BATCH_COUNT = 100;

/** kind 白名单（§6.2）。 */
export const KINDS = ['msg', 'task', 'progress', 'artifact', 'note', 'member', 'hub'];

/** 只许 Hub 写的字段（§6.3 硬规则）。成员带了就 403。 */
export const HUB_ONLY_FIELDS = ['claimedAt', 'leaseMs'];

export const TASK_STATUS = ['pending', 'running', 'blocked', 'done', 'cancelled'];

const HEX16 = /^[0-9a-f]{16}$/;
const ID_RE = /^ev_[0-9a-f]{6}_[0-9a-z]+_[0-9a-z]{3}$/;

/* ───────────────────────────── id ───────────────────────────── */

let idCounter = 0;

/**
 * 生成事件 id：`ev_<origin前6位>_<毫秒36进制><进程内计数器4位>_<随机3位>`。
 *
 * 计数器保证同毫秒内不撞；随机 3 位是为了两台机器同一毫秒同一 origin（几乎不可能，
 * 但测试里会构造）也还能分开。超 9999 回绕 —— 4 位是文档定的，够用。
 */
export function makeEventId(origin, now = Date.now()) {
  const head = String(origin || '').slice(0, 6).padEnd(6, '0');
  const ms36 = now.toString(36);
  idCounter = (idCounter + 1) % 10000;
  const counter = String(idCounter).padStart(4, '0');
  const rand = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0');
  return `ev_${head}_${ms36}${counter}_${rand}`;
}

export function isEventId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

/* ───────────────────────────── 排序 ───────────────────────────── */

/**
 * 权威顺序 `(epoch, seq, id)` 升序。**全链路只此一份。**
 *
 * 注意不能用 localeCompare、不能拼字符串：`seq=10` 会被排到 `seq=9` 前面。
 * 未同步事件（没有 epoch/seq）排末尾，由调用方决定是否先过滤掉。
 */
export function compareEvents(a, b) {
  const ae = Number.isFinite(a?.epoch) ? a.epoch : Number.MAX_SAFE_INTEGER;
  const be = Number.isFinite(b?.epoch) ? b.epoch : Number.MAX_SAFE_INTEGER;
  if (ae !== be) return ae < be ? -1 : 1;
  const as = Number.isFinite(a?.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
  const bs = Number.isFinite(b?.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
  if (as !== bs) return as < bs ? -1 : 1;
  const ai = String(a?.id ?? '');
  const bi = String(b?.id ?? '');
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** 有没有拿到 Hub 分配的序号（= 已同步）。UI 的灰点就是这个。 */
export function hasSyncStamp(ev) {
  return Number.isFinite(ev?.epoch) && Number.isFinite(ev?.seq);
}

/**
 * 同一 id 只留 `(epoch, seq, id)` 最小的那条（§6.5）。
 * 保留原数组顺序的稳定排序，避免把 UI 上「最后一条」搞乱。
 */
export function dedupeById(list) {
  const best = new Map();
  const order = [];
  for (const ev of list) {
    const id = ev && ev.id;
    if (!id) continue;
    const prev = best.get(id);
    if (!prev) {
      best.set(id, ev);
      order.push(id);
    } else if (compareEvents(ev, prev) < 0) {
      best.set(id, ev);
    }
  }
  return order.map((id) => best.get(id)).filter(Boolean);
}

/* ───────────────────────────── 大小 ───────────────────────────── */

export function eventBytes(ev) {
  try {
    return Buffer.byteLength(JSON.stringify(ev), 'utf8');
  } catch {
    return Infinity;
  }
}

function isInlineArtifact(ev) {
  const t = ev && ev.transfer;
  return ev?.kind === 'artifact' && t && t.mode === 'inline';
}

/* ───────────────────────────── 校验 ───────────────────────────── */

function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function textOf(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

function strList(v, max, eachMax) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (!isText(item)) continue;
    const s = String(item).trim().slice(0, eachMax);
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 校验失败的统一形状。`field` 用于诊断，别丢（§7.4）。 */
function bad(code, message, field) {
  return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

/**
 * 校验一条事件。
 *
 * @param {object} raw
 * @param {object} [opts]
 * @param {string} [opts.origin]       这条事件声明的 origin（HTTP 层用它比对 token）
 * @param {string} [opts.expectedOrigin] token 对应的 origin
 * @param {boolean} [opts.fromHub]     true = Hub 内部写入（跳过 origin 比对）
 * @param {boolean} [opts.localWrite]  true = 本机首次写入（允许没有 epoch/seq）
 */
export function validateEvent(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('bad-param', '事件要是个对象');
  }
  const kind = raw.kind;
  if (!KINDS.includes(kind)) {
    return bad('bad-param', `kind 不认识：${String(kind)}`, 'kind');
  }

  const origin = raw.origin;
  if (!opts.localWrite) {
    if (typeof origin !== 'string' || !HEX16.test(origin)) {
      return bad('bad-param', 'origin 要 16 位小写十六进制', 'origin');
    }
  }
  if (opts.expectedOrigin && origin && origin !== opts.expectedOrigin && !opts.fromHub) {
    return bad('forbidden', '事件 origin 与 token 不符', 'origin');
  }

  // 成员不许写 Hub 专属字段（§6.3）：能写就能伪造「我刚认领」，租约永远不过期
  if (!opts.fromHub) {
    for (const f of HUB_ONLY_FIELDS) {
      if (raw[f] !== undefined) {
        return bad('forbidden', `${f} 只有 Hub 能写`, f);
      }
    }
  }

  // 大小（先把 inline 特例挑出来，否则 60 KB 那一档必定被拒）
  const limit = isInlineArtifact(raw) ? MAX_INLINE_BYTES : MAX_SINGLE_BYTES;
  if (eventBytes(raw) > limit) {
    return bad('too-large', `单条超过 ${Math.round(limit / 1024)} KB`);
  }

  switch (kind) {
    case 'msg': {
      const text = textOf(raw.text, 8192);
      if (text.trim() === '') return bad('bad-param', 'msg 要有 text', 'text');
      /**
       * `to`：定向消息 —— 只叫醒这几个人（§6.10.2 依赖解锁用；@ 也用同一套）。
       *
       * 为什么需要它：msg 本来是广播的，唤醒也就跟着广播 —— 一次依赖解锁
       * 会把所有开着 wakeOnMessage 的机器都点醒一轮。给了 `to`，
       * 别的机器照常收事件、照常显示，但**不为此烧一轮 token**。
       *
       * 可以是单个 origin，也可以是 origin 数组（一次 @ 好几个人）。
       * 可省：老消息没有这个字段，行为不变。
       */
      if (raw.to !== undefined && raw.to !== null && raw.to !== '') {
        const list = Array.isArray(raw.to) ? raw.to : [raw.to];
        const clean = [];
        for (const one of list) {
          if (typeof one !== 'string' || !HEX16.test(one)) {
            return bad('bad-param', 'to 要 16 位小写十六进制 origin（或它的数组）', 'to');
          }
          if (!clean.includes(one)) clean.push(one);
          if (clean.length >= 16) break;
        }
        if (clean.length === 0) return bad('bad-param', 'to 不能是空数组', 'to');
        return {
          ok: true,
          event: { ...raw, text, to: clean.length === 1 ? clean[0] : clean },
        };
      }
      return { ok: true, event: { ...raw, text } };
    }
    case 'task': {
      const taskId = isText(raw.taskId) ? raw.taskId.trim() : (isText(raw.id) ? raw.id.trim() : '');
      if (!taskId) return bad('bad-param', 'task 要有 taskId', 'taskId');
      // 墓碑不带标题（正是要擦掉它），所以只对普通任务卡要求 title
      const tombstone = raw.deleted === true;
      if (!tombstone && !isText(raw.title)) return bad('bad-param', 'task 要有 title', 'title');
      const status = TASK_STATUS.includes(raw.status) ? raw.status : (tombstone ? 'cancelled' : 'pending');
      const priority = ['high', 'normal', 'low'].includes(raw.priority) ? raw.priority : 'normal';
      return {
        ok: true,
        event: {
          ...raw,
          taskId,
          title: textOf(raw.title, 200),
          status,
          priority,
          owner: isText(raw.owner) ? raw.owner.trim().slice(0, 64) : '',
          detail: textOf(raw.detail, 8192),
          dependsOn: strList(raw.dependsOn, 32, 64),
          requiredCapabilities: strList(raw.requiredCapabilities, 32, 32),
          tags: strList(raw.tags, 32, 32),
          archived: raw.archived === true,
          /**
           * 墓碑（0.10.14）：删除一张卡 = 写一条 `deleted: true` 的 task 事件。
           * **不删日志行** —— 两台机器靠事件流同步，删行会让对方以为没发生过、seq 还会断层。
           * 折叠时把正文擦空，视图里只剩一个「已删除」的壳。
           */
          deleted: raw.deleted === true,
          deletedAt: raw.deleted === true ? textOf(raw.deletedAt, 40) : '',
        },
      };
    }
    case 'progress': {
      if (!isText(raw.taskId)) return bad('bad-param', 'progress 要有 taskId', 'taskId');
      const done = Number(raw.done);
      const total = Number(raw.total);
      if (!Number.isInteger(done) || done < 0) return bad('bad-param', 'done 要是非负整数', 'done');
      if (!Number.isInteger(total) || total < 0) return bad('bad-param', 'total 要是非负整数', 'total');
      if (done > total) return bad('bad-param', 'done 不能大于 total', 'done');
      return { ok: true, event: { ...raw, done, total, note: textOf(raw.note, 500) } };
    }
    case 'artifact': {
      const path = textOf(raw.path, 1024);
      if (path.trim() === '' && !isText(raw.name)) {
        return bad('bad-param', 'artifact 要有 path 或 name', 'path');
      }
      return { ok: true, event: { ...raw, path, note: textOf(raw.note, 500) } };
    }
    case 'note': {
      const text = textOf(raw.text, 4096);
      if (text.trim() === '') return bad('bad-param', 'note 要有 text', 'text');
      return {
        ok: true,
        event: { ...raw, text, level: raw.level === 'warn' ? 'warn' : 'info' },
      };
    }
    case 'member': {
      const action = ['join', 'leave', 'rename', 'update'].includes(raw.action) ? raw.action : 'update';
      return {
        ok: true,
        event: {
          ...raw,
          action,
          name: isText(raw.name) ? textOf(raw.name, 64) : '',
          target: isText(raw.target) ? String(raw.target).trim() : '',
          capabilities: strList(raw.capabilities, 64, 32),
          status: raw.status === 'busy' ? 'busy' : 'idle',
        },
      };
    }
    case 'hub': {
      // Hub 的显示名走 `hubName`；`name` 是信封保留字段（系统事件必须是「系统」），
      // 老数据可能把 Hub 名塞在 `name` 里，这里兼容着读出来。
      const display = isText(raw.hubName) ? raw.hubName : (isText(raw.name) && raw.name !== '系统' ? raw.name : '');
      return {
        ok: true,
        event: {
          ...raw,
          hubName: textOf(display, 64),
          host: textOf(raw.host, 128),
          port: Number.isInteger(Number(raw.port)) ? Number(raw.port) : 0,
        },
      };
    }
    default:
      return bad('bad-param', 'kind 不认识', 'kind');
  }
}

/**
 * 批量校验（§6.6）。**顺序不能反**：先逐条、再总字节、最后条数。
 * 反了会把「单条太大」和「整批太大」混成同一个 too-large，客户端不知道该拆批还是拆文件。
 */
export function validateBatch(list, opts = {}) {
  if (!Array.isArray(list)) return bad('bad-param', '批量要是个数组');
  if (list.length > MAX_BATCH_COUNT) {
    return bad('too-large', `一批最多 ${MAX_BATCH_COUNT} 条`, 'count');
  }
  const out = [];
  for (const raw of list) {
    const r = validateEvent(raw, opts);
    if (!r.ok) return r;
    out.push(r.event);
  }
  let bytes = 0;
  for (const ev of out) bytes += eventBytes(ev);
  if (bytes > MAX_BATCH_BYTES) {
    return bad('too-large', `整批超过 ${Math.round(MAX_BATCH_BYTES / 1024)} KB`, 'bytes');
  }
  return { ok: true, events: out };
}

/** 补齐本机首次写入的信封（没有 epoch/seq —— 那是 Hub 的活）。 */
export function stampLocal(ev, { origin, name, now = new Date() }) {
  return {
    eventVersion: EVENT_VERSION,
    id: ev.id || makeEventId(origin, now.getTime()),
    origin,
    name: name || '',
    ts: ev.ts || now.toISOString(),
    kind: ev.kind,
    ...ev,
  };
}

/**
 * 一条 note 说的是哪张卡（0.11.5）。返回空串 = 全局提示，不属于任何卡。
 *
 * 为什么要它：动态流要按「挂在已删卡上的提示跟着卡一起消失」过滤，自动认领要
 * 「一张卡只写一条提示」—— 两处都得先知道这条 note 属于谁。
 *
 * 判据分两档，原则是**认不出来就当全局**：宁可多留一条，也不能猜错卡，
 * 把不相干的记录一起藏掉。
 *   1. 读字段：0.11.5 起插件写提示会带 `taskId`
 *   2. 读文案：老数据没字段，只能反解 —— **只认我们自己生成的那两种格式**，
 *      格式由生成端保证（index.mjs 的「自动认领：」和「一条事件被 Hub 拒了（task …）」）。
 *      客户端有一份同样的实现（src/client/index.js 的 `noteTaskIdOf`），改格式要一起改。
 */
export function noteTaskIdOf(ev, text) {
  const direct = typeof (ev && ev.taskId) === 'string' ? ev.taskId.trim()
    : (typeof (ev && ev.task) === 'string' ? ev.task.trim() : '');
  if (direct) return direct;
  const src = typeof text === 'string' ? text : String(text == null ? '' : text);
  const auto = /^自动认领：(\S+)/.exec(src);
  if (auto) return auto[1];
  const rejected = /被 Hub 拒了（task (\S+?)）/.exec(src);
  if (rejected) return rejected[1];
  return '';
}
