/**
 * 协作看板 · 「这张卡刚被叫过」的判重表（`wakes.json`）
 *
 * 解决的是「同一张卡被叫两次」：
 *   - 依赖解锁会发一条 msg（hub.mjs 的 systemWrite），那条本来就会唤醒；
 *   - 自动认领又会排一条唤醒。
 *   两条落在同一张卡上，第二条醒来时活可能已经干完了。
 *
 * 为什么不放进 `inflight.json`：
 *   1. 投递账本和判重表是两件事，坏一个不该连坐 —— `createDelivery.load()`
 *      的 catch 是「坏了当空的」，放一起等于把判重表也拖进那个兜底；
 *   2. `inflight.json` 的 `load()` 是 `state = { version, items, done }`
 *      **重建对象**，未知字段直接丢掉，写进去也存不住；
 *   3. 它的 `done` 是 `string[]`（只有 eventId、500 条上限、FIFO 截断），
 *      拿它当「这张卡最近叫过没」会随聊天量漂移。
 *
 * 判据只有一条：`now - wakes[taskId] < wakeCooldownMs` 算「刚叫过」。
 * **读的时候比时间戳，不能只看键在不在** —— 写入时才清过期，长时间没有新写入
 * 表里会留老条目，只判「在不在」会把半小时前叫过当成刚叫过，那张卡就再也不叫了。
 *
 * 写入时机：投递**成功**之后（`onDelivered`）。宁可漏记不可早记 ——
 * 漏记的代价是多叫一次，早记的代价是这卡再也不叫。
 *
 * @module dsh-collab-board/host/wakes
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from './http-util.mjs';

/** 表里最多留多少张卡。只比冷却窗略大就行，它不是历史。 */
export const WAKES_LIMIT = 200;

/**
 * 认领唤醒该通知哪些卡：`claimed − 账上已有待投项的卡 − 冷却窗内刚叫过的卡`。
 *
 * **用差集，不是交集。** 「有交集就不排」会把没被叫过的卡一起漏掉：
 * 账上待投有 A、本轮认了 A+B，按交集整条不排 —— B 就再也没有唤醒了。
 * 反过来，待投有 A、本轮只认了 A，差集是空，也自然不会重排（不刷屏）。
 *
 * 抽成纯函数是为了能直接测：这条判据在 0.11.26 的讨论里被改过两次。
 *
 * @param {string[]} claimed           本轮认领的卡
 * @param {object} ctx
 * @param {string[]} [ctx.queued]      账上已有待投唤醒项涉及的卡
 * @param {(id:string)=>boolean} [ctx.recent] 这张卡是不是冷却窗内刚叫过
 * @returns {string[]} 需要排进唤醒的卡（去重、保序）
 */
export function freshClaimWake(claimed, { queued = [], recent = () => false } = {}) {
  const queuedSet = new Set(Array.isArray(queued) ? queued : []);
  const out = [];
  for (const raw of Array.isArray(claimed) ? claimed : []) {
    const id = typeof raw === 'string' ? raw : '';
    if (id === '' || out.includes(id)) continue;
    if (queuedSet.has(id)) continue;
    if (recent(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.file                  wakes.json 绝对路径
 * @param {()=>number|number} [opts.windowMs] 冷却窗，运行时读设置（`wakeCooldownMs`）
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export function createWakes({ file, windowMs = () => 300000, log = () => {} } = {}) {
  /** @type {{version:number, wakes:Record<string, number>}} */
  let state = { version: 1, wakes: {} };

  function windowNow() {
    const n = Number(typeof windowMs === 'function' ? windowMs() : windowMs);
    return Number.isFinite(n) && n > 0 ? n : 300000;
  }

  function sanitize(raw) {
    const out = {};
    const src = raw && typeof raw === 'object' && raw.wakes && typeof raw.wakes === 'object'
      ? raw.wakes
      : {};
    for (const [k, v] of Object.entries(src)) {
      if (typeof k !== 'string' || k === '') continue;
      const ts = Number(v);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      out[k] = ts;
    }
    return out;
  }

  function load() {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      state = { version: 1, wakes: sanitize(raw) };
    } catch {
      // 坏了当空表：后果是多叫一次，不是丢活
      state = { version: 1, wakes: {} };
    }
  }

  function persist() {
    if (!file) return;
    try {
      writeAtomic(file, JSON.stringify(state));
    } catch (e) {
      // 写失败吞掉：后果同样只是多叫一次，别拖垮投递
      log('warn', `唤醒判重表写盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 清过期条目。只在写的时候做，读的时候靠比时间戳。 */
  function prune(now) {
    const win = windowNow();
    for (const [k, ts] of Object.entries(state.wakes)) {
      if (now - ts >= win) delete state.wakes[k];
    }
  }

  /** 这张卡在冷却窗内被叫过吗？**比时间戳，不看键在不在。** */
  function recent(taskId, now = Date.now()) {
    const id = typeof taskId === 'string' ? taskId : '';
    if (!id) return false;
    const ts = Number(state.wakes[id]) || 0;
    if (!ts) return false;
    return now - ts < windowNow();
  }

  /** 投递成功后记一笔。传数组就整批记（多卡唤醒）。 */
  function mark(taskIds, now = Date.now()) {
    const list = Array.isArray(taskIds) ? taskIds : [taskIds];
    let n = 0;
    for (const raw of list) {
      const id = typeof raw === 'string' ? raw : '';
      if (!id) continue;
      state.wakes[id] = now;
      n += 1;
    }
    if (n === 0) return 0;
    prune(now);
    // 兜底上限：留时间最近的
    const keys = Object.keys(state.wakes);
    if (keys.length > WAKES_LIMIT) {
      keys.sort((a, b) => (state.wakes[a] || 0) - (state.wakes[b] || 0));
      for (const k of keys.slice(0, keys.length - WAKES_LIMIT)) delete state.wakes[k];
    }
    persist();
    return n;
  }

  function snapshot() {
    return { size: Object.keys(state.wakes).length };
  }

  load();

  return { recent, mark, snapshot, state: () => state };
}
