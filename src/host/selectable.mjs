/**
 * 协作看板 · 「哪些活该我接」的唯一判据
 *
 * 为什么要有这个文件：这条判据原来在五处各写了一遍 ——
 *   - 自动认领 `pickClaimable`（index.mjs）
 *   - 待办提醒 `scan`（index.mjs）
 *   - `readBoard` 的 pending 池（index.mjs）
 *   - Hub 侧的 `matchedMembersFor` / `warningsFor`（hub.mjs）
 *   - 客户端任务详情的 `missingCaps` / `unmet`（client/index.js）
 *
 * 已经分叉了：自动认领排除「自己建的卡」，待办提醒没排除 ——
 * 同一张卡，一个信号说「我不接」，另一个喊「有人接一下」。
 *
 * 这里只留一份。三处宿主消费方都调 `claimableTasks()`，
 * 客户端那份因为手写 bundle 不能 import，只能继续重复，
 * 但判据以这里为准，改这里时记得同步 client/index.js 的 `taskClaimBlocked()`。
 *
 * @module dsh-collab-board/host/selectable
 */
import { compareEvents } from './events.mjs';

/** taskId → 最新那条 task 事件（按 (epoch, seq, id) 取最大）。 */
export function latestTasks(events) {
  const out = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.kind !== 'task' || !ev.taskId) continue;
    const prev = out.get(ev.taskId);
    if (!prev || compareEvents(ev, prev) > 0) out.set(ev.taskId, ev);
  }
  return out;
}

/**
 * 折成「可认领判定」列表。
 *
 * @param {any[]} events
 * @param {object} opts
 * @param {string}   [opts.selfOrigin]    本机 origin（判「自己建的」）
 * @param {string[]} [opts.capabilities]  本机能力标签
 * @param {boolean}  [opts.excludeOwn]    true = 自己建的卡不算可接（默认 true）
 * @param {boolean}  [opts.includeArchived] true = 归档的也返回（只用于展示）
 * @returns {Array<{ task: any, ok: boolean, reason: string }>}
 *   reason: '' | 'not-pending' | 'owned' | 'archived' | 'own' | 'deps' | 'caps'
 */
export function claimableTasks(events, opts = {}) {
  const selfOrigin = typeof opts.selfOrigin === 'string' ? opts.selfOrigin : '';
  const excludeOwn = opts.excludeOwn !== false;
  const includeArchived = opts.includeArchived === true;
  const mine = new Set(
    (Array.isArray(opts.capabilities) ? opts.capabilities : []).map((c) => String(c).toLowerCase()),
  );

  const tasks = latestTasks(events);
  const creators = earliestByTask(events);
  const out = [];

  for (const task of tasks.values()) {
    if (task.archived && !includeArchived) {
      out.push({ task, ok: false, reason: 'archived' });
      continue;
    }
    if (task.status !== 'pending') {
      out.push({ task, ok: false, reason: 'not-pending' });
      continue;
    }
    if (task.owner) {
      out.push({ task, ok: false, reason: 'owned' });
      continue;
    }
    if (excludeOwn && selfOrigin && creators.get(task.taskId) === selfOrigin) {
      out.push({ task, ok: false, reason: 'own' });
      continue;
    }
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const depsOk = deps.every((d) => {
      const dep = tasks.get(d);
      return dep && (dep.status === 'done' || dep.status === 'cancelled');
    });
    if (!depsOk) {
      out.push({ task, ok: false, reason: 'deps' });
      continue;
    }
    const caps = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [];
    const capsOk = caps.every((c) => mine.has(String(c).toLowerCase()));
    if (!capsOk) {
      out.push({ task, ok: false, reason: 'caps' });
      continue;
    }
    out.push({ task, ok: true, reason: '' });
  }
  return out;
}

/** 只留能接的，返回任务事件本身（调用方常用的形状）。 */
export function claimableOnly(events, opts = {}) {
  return claimableTasks(events, opts).filter((x) => x.ok).map((x) => x.task);
}

/**
 * taskId → 最早那条 task 事件（真正的「建卡那条」）。
 *
 * 两遍：先把每个 taskId 的所有版本收起来，再按权威顺序挑最小 ——
 * 不能拿数组下标，日志 append 顺序不等于事件顺序（Hub 拉回来的会更晚落盘）。
 */
export function earliestByTask(events) {
  const versions = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.kind !== 'task' || !ev.taskId) continue;
    const list = versions.get(ev.taskId);
    if (list) list.push(ev);
    else versions.set(ev.taskId, [ev]);
  }
  const out = new Map();
  for (const [taskId, list] of versions) {
    let first = list[0];
    for (const ev of list) {
      if (compareEvents(ev, first) < 0) first = ev;
    }
    out.set(taskId, typeof first.origin === 'string' ? first.origin : '');
  }
  return out;
}

/**
 * 缺哪些能力标签。给「缺 xx」提示用，和 claimableTasks 同一套大小写规则。
 * @returns {string[]} 缺的标签（原样返回任务里写的那个拼法）
 */
export function missingCapabilities(task, capabilities) {
  const mine = new Set(
    (Array.isArray(capabilities) ? capabilities : []).map((c) => String(c).toLowerCase()),
  );
  const need = Array.isArray(task?.requiredCapabilities) ? task.requiredCapabilities : [];
  return need.filter((c) => !mine.has(String(c).toLowerCase()));
}

/** 依赖里还没完成/取消的那些。 */
export function unmetDependencies(task, tasks) {
  const table = tasks instanceof Map ? tasks : latestTasks(tasks);
  const deps = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
  return deps.filter((d) => {
    const dep = table.get(d);
    return !dep || (dep.status !== 'done' && dep.status !== 'cancelled');
  });
}

/**
 * `owner` 迁移规则 —— Hub（权威）和宿主（本地预检）共用这一份。
 *
 * 认领本来走 `/tasks/claim` 的串行 CAS，但普通 `task` 事件也能写 owner。
 * 不管就只有一种结果：谁都能推一条事件把别人的卡抢走。
 *
 * 允许三种迁移，其余一律拒：
 *   1. 不变（改标题 / 状态 / 标签，owner 跟着走）
 *   2. 空 → 自己（接手一张没人认领的卡）
 *   3. 自己 → 空（主动释放）
 *
 * **为什么本地也要查**：Hub 拒一条事件时，客户端是整批推、整批失败。
 * 脏事件留在本地日志里会一直重推，把后面的合法事件全堵住。
 * 所以在写进日志之前先挡一道 —— 本地视图可能落后，这里放过、Hub 拒掉的，
 * 由客户端逐条降级兜底（hub-client 的 pushOnce）。
 *
 * @returns {null|{message: string}} null = 允许
 */
export function ownerTransitionError({ nextOwner, prevOwner, writer, hasTask }) {
  const next = typeof nextOwner === 'string' ? nextOwner : '';
  const cur = typeof prevOwner === 'string' ? prevOwner : '';
  const me = typeof writer === 'string' ? writer : '';

  if (!hasTask) {
    // 新建：不许一出生就写着别人的 owner
    if (next && next !== me) {
      return { message: `新建任务不能把 owner 写成别人（${next.slice(0, 8)}…）` };
    }
    return null;
  }
  if (next === cur) return null;
  if (cur === '' && next === me) return null;
  if (cur === me && next === '') return null;
  if (!cur) {
    return { message: `不能把 owner 写成别人（${next.slice(0, 8)}…）—— 要么写自己，要么走 /tasks/claim` };
  }
  return {
    message: cur
      ? `不能改别人认领的任务（当前是 ${cur.slice(0, 8)}…）；要抢先用 /tasks/claim`
      : 'owner 只能按「不变 / 空→自己 / 自己→空」迁移',
  };
}
