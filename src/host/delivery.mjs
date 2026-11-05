/**
 * 协作看板 · 投递账本（inflight.json）
 *
 * 解决的是「叫醒这件事没有账」：
 *   - 唤醒失败（宿主没会话、会话正忙、进程退出）以前只落一条日志，消息还在看板上，
 *     但没有人记得「这条还没送到」，下一轮也不会再试。
 *   - 重启把内存里的状态全忘了，`wakeState.busy` 一归零，同一条消息可能再叫一次，
 *     也可能永远不叫。
 *
 * 账本只做三件事：
 *   1. **先记账，再投递** —— 投递前写盘；投失败留在账上，重启后补投一次。
 *   2. **幂等** —— 同一个 eventId 只投一次；投成功进 done 列表，重启也不翻倍。
 *   3. **有上限地重试** —— 次数由 `wakeRetries` 控制；超了放弃并落一条 warn note，
 *      不堵住后面的消息、不无限刷日志。
 *
 * 和 DS Bot 的 resume.js 学的正是第 1、3 条（它叫 inflight.json，我们同名）。
 * 区别：它的「投递」是进程内 session 投递，我们的是跨机唤醒，所以账本必须自己落盘。
 *
 * @module dsh-collab-board/host/delivery
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from './http-util.mjs';

/** 默认重试次数。设置项 `wakeRetries` 覆盖它。 */
export const DEFAULT_RETRIES = 3;
/** 两次重试之间等多久。测试会传小值。 */
export const RETRY_DELAY_MS = 30000;
/** done 列表留多少条。它是幂等凭据，不是历史，不需要无界增长。 */
export const DONE_LIMIT = 500;

/**
 * @param {object} opts
 * @param {string} opts.file           inflight.json 绝对路径
 * @param {(item:object)=>Promise<any>} opts.send       真正投递；抛错 = 没送到
 * @param {()=>number} [opts.retries]  最多试几次（含第一次），运行时读设置
 * @param {number} [opts.delayMs]      重试间隔
 * @param {(item:object)=>void} [opts.onGiveUp]  放弃时回调（写 warn note）
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export function createDelivery({
  file,
  send,
  retries = () => DEFAULT_RETRIES,
  delayMs = RETRY_DELAY_MS,
  onGiveUp = () => {},
  log = () => {},
  doneLimit = DONE_LIMIT,
} = {}) {
  /** @type {{version:number, items:object[], done:string[]}} */
  let state = { version: 1, items: [], done: [] };
  let pumping = false;
  let timer = null;
  let closed = false;
  let lastAt = '';
  let lastError = '';

  function load() {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      const items = Array.isArray(raw.items) ? raw.items : [];
      const done = Array.isArray(raw.done) ? raw.done : [];
      state = {
        version: 1,
        items: items.filter((it) => it && typeof it.eventId === 'string' && it.eventId !== ''),
        done: done.filter((id) => typeof id === 'string' && id !== ''),
      };
      if (state.items.length > 0) {
        log('info', `待补投 ${state.items.length} 条（上次没送到的）`);
      }
    } catch {
      // 账本坏了就当空的：最坏是补投一次重复，比整份文件弄死插件好。
      state = { version: 1, items: [], done: [] };
    }
  }

  function persist() {
    if (!file) return;
    try {
      writeAtomic(file, JSON.stringify(state));
    } catch (e) {
      log('warn', `账本写盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const maxAttempts = () => {
    const n = typeof retries === 'function' ? Number(retries()) : Number(retries);
    return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : DEFAULT_RETRIES;
  };

  function rememberDone(eventId) {
    state.done.push(eventId);
    if (state.done.length > doneLimit) state.done = state.done.slice(-doneLimit);
  }

  /**
   * 记一条待投递。返回 false 表示「已经在账上或已投过」，调用方不用再管。
   * **先写盘再返回**：进程在这之后被杀，重启还能捡回来。
   *
   * 两个 0.10.10 的补充：
   *   - `item.notBefore`：最早什么时候投（绝对时间戳）。冷却期里的唤醒不再丢弃，
   *     改成「延后到冷却结束再投」。
   *   - 同一个 `taskId` 已经在账上时**合并成一条**：冷却的 5 分钟里可能来五六条，
   *     全排队会变成 5 分钟后连叫五六轮。合并后只叫一次，让 agent 读增量。
   */
  function offer(item) {
    if (!item || typeof item.eventId !== 'string' || item.eventId === '') return false;
    if (state.done.includes(item.eventId)) return false;
    if (state.items.some((it) => it.eventId === item.eventId)) return false;

    const notBefore = Number(item.notBefore) || 0;
    const taskId = typeof item.taskId === 'string' ? item.taskId : '';
    const same = taskId
      ? state.items.find((it) => it.taskId === taskId && it.eventId !== item.eventId)
      : undefined;

    if (same) {
      // 旧的触发事件算处理过：它的唤醒被并进新这条了，以后别再单独投它
      rememberDone(same.eventId);
      same.eventId = item.eventId;
      same.text = typeof item.text === 'string' ? item.text : same.text;
      same.from = typeof item.from === 'string' ? item.from : same.from;
      same.deferred = item.deferred === true || same.deferred === true;
      same.at = Date.now();
      // 只往晚里推，不往早里拉：合并不能让一条还得重试的项插队
      if (notBefore > 0 && (Number(same.nextAt) || 0) < notBefore) same.nextAt = notBefore;
      persist();
      kick();
      return true;
    }

    state.items.push({
      eventId: item.eventId,
      taskId,
      from: typeof item.from === 'string' ? item.from : '',
      text: typeof item.text === 'string' ? item.text : '',
      deferred: item.deferred === true,
      attempts: 0,
      at: Date.now(),
      nextAt: notBefore,
      lastError: '',
    });
    persist();
    kick();
    return true;
  }

  function schedule(ms) {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, Math.max(10, ms));
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 找最早该重试的那条，安排下一次。 */
  function scheduleNext() {
    if (closed || timer || state.items.length === 0) return;
    const now = Date.now();
    let next = Infinity;
    for (const it of state.items) {
      const at = Number(it.nextAt) || 0;
      if (at < next) next = at;
    }
    if (!Number.isFinite(next)) return;
    schedule(Math.max(10, next - now));
  }

  /**
   * 串行把账上该投的投完。
   *
   * **按项独立重试，不按队头重试**：失败的项设 `nextAt`、留在原地，这一轮
   * 继续找下一条能投的。否则一条投不出去的消息卡在队头，后面全部轮不到 ——
   * 那还是「丢消息」，只是换了个地方丢。
   */
  async function run() {
    while (!closed) {
      const now = Date.now();
      const item = state.items.find((it) => (Number(it.nextAt) || 0) <= now);
      if (!item) break;
      item.attempts += 1;
      lastAt = new Date().toISOString();
      // 先记这次尝试，再投。投的过程崩了，attempts 已经落盘。
      persist();
      try {
        await send(item);
        state.items = state.items.filter((it) => it !== item);
        rememberDone(item.eventId);
        lastError = '';
        persist();
      } catch (e) {
        item.lastError = e instanceof Error ? e.message : String(e);
        lastError = item.lastError;
        const max = maxAttempts();
        if (item.attempts >= max) {
          state.items = state.items.filter((it) => it !== item);
          rememberDone(item.eventId);
          persist();
          try {
            onGiveUp({ ...item, max });
          } catch { /* 回调自己炸了不影响投下一条 */ }
          log('warn', `投递放弃：${item.eventId}（${item.attempts} 次都没送到：${item.lastError}）`);
        } else {
          item.nextAt = Date.now() + delayMs;
          persist();
          log('warn', `投递失败，${Math.round(delayMs / 1000)} 秒后重试：${item.lastError}`);
        }
      }
    }
    scheduleNext();
  }

  function kick() {
    if (closed || pumping) return;
    if (state.items.length === 0) return;
    pumping = true;
    Promise.resolve()
      .then(run)
      .catch((e) => log('warn', `投递循环自己炸了：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { pumping = false; });
  }

  function snapshot() {
    return {
      queued: state.items.length,
      attempts: state.items.reduce((m, it) => Math.max(m, it.attempts), 0),
      lastAt,
      lastError,
      pending: state.items[0]?.eventId ?? '',
      delivered: state.done.length,
    };
  }

  function close() {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  load();

  return { offer, kick, snapshot, close, hasPending: () => state.items.length > 0, state: () => state };
}
