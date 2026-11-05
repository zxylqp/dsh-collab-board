/**
 * 协作看板 · 「这条该不该叫醒本机 agent」的唯一判据
 *
 * 为什么要单独一个文件：2026-11-05 真机上，一条 2026-11-03 21:26 的旧消息
 * （seq 13，t2）被 Hub 重放回本机，`onPulled` 按「本机没有这个 id」当成了新消息，
 * 叫醒一轮、标签还挂在 t2 上，两边都在查「谁发了新消息」。
 *
 * 判据改过两次，两次都被汐汐驳回（她两次都对）：
 *   1. 按 ts 年龄（超过 10 分钟不叫）—— 离线几小时的真消息 ts 也老了，变成静默不叫；
 *      而且那版测试是假绿，关掉过滤照样全过。
 *   2. 只按 seq —— seq 不是全局单调，是**每 epoch 内**单调。Hub 换代后 seq 从 1 重来，
 *      新消息全都不大于本机已见 → 全判成历史，整台机器再也收不到唤醒，而且没痕迹。
 *
 * 现在按 `(epoch, seq)` 字典序：
 *   - epoch 更大 → 新一代，整批算新的，不看 seq
 *   - epoch 更小 → 旧一代，历史
 *   - epoch 相同 → 比 seq，大于本机已见才叫
 *
 * 离线期间的真消息：本机从没见过它的 (epoch, seq)，一定更大 → 叫。
 *
 * @module dsh-collab-board/host/wake
 */

/** 不叫醒的原因，用来落日志/说明为什么没叫。 */
export const WAKE_SKIP = {
  NOT_MSG: 'not-msg',
  SELF: 'self',
  NO_SEQ: 'no-seq',
  HISTORY: 'history',
};

/**
 * @param {object} ev      Hub 拉回来的一条事件
 * @param {object} ctx
 * @param {string} ctx.selfOrigin  本机 origin
 * @param {number} ctx.maxEpoch    本机见过的最大 epoch
 * @param {number} ctx.maxSeq      在本机见过的最大 epoch 里的最大 seq
 * @returns {{wake: boolean, reason: string}}
 */
export function shouldWake(ev, { selfOrigin, maxEpoch = 0, maxSeq = 0 }) {
  if (!ev || ev.kind !== 'msg') return { wake: false, reason: WAKE_SKIP.NOT_MSG };
  if (typeof ev.origin !== 'string' || ev.origin === selfOrigin) {
    return { wake: false, reason: WAKE_SKIP.SELF };
  }
  const seq = Number(ev.seq);
  if (!Number.isFinite(seq) || seq <= 0) return { wake: false, reason: WAKE_SKIP.NO_SEQ };

  const epoch = Number(ev.epoch);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    // 老数据没有 epoch：只能按 seq 比，宁可不叫也别瞎叫
    return seq > maxSeq ? { wake: true, reason: '' } : { wake: false, reason: WAKE_SKIP.HISTORY };
  }
  if (epoch > maxEpoch) return { wake: true, reason: '' };
  if (epoch < maxEpoch) return { wake: false, reason: WAKE_SKIP.HISTORY };
  return seq > maxSeq ? { wake: true, reason: '' } : { wake: false, reason: WAKE_SKIP.HISTORY };
}

/**
 * 本机已见的最高 (epoch, seq)。
 *
 * 本机自己写的、还没推上去的事件没有 epoch/seq，跳过 —— 它们不参与「见过没见过」。
 * 返回的是**字典序最大**的那条，不是各自最大：epoch 2 的 seq 3 比 epoch 1 的 seq 900 新。
 */
export function maxSeenOf(events) {
  let epoch = 0;
  let seq = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    const e = Number(ev && ev.epoch);
    const s = Number(ev && ev.seq);
    if (!Number.isFinite(s) || s <= 0) continue;
    if (!Number.isFinite(e) || e <= 0) {
      if (epoch === 0 && s > seq) seq = s;
      continue;
    }
    if (e > epoch) {
      epoch = e;
      seq = s;
    } else if (e === epoch && s > seq) {
      seq = s;
    }
  }
  return { epoch, seq };
}
