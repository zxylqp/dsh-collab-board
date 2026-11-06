/**
 * 协作看板 · `/join` 失败限流（0.11.2）
 *
 * 为什么需要：`/join` 是**唯一不需要 token**的入口，也就是唯一的外部攻击面。
 * 之前口令错了就回 401，不计数、不延迟、不并发限制 —— 局域网内一个脚本每秒能做
 * 上千次尝试，4~6 位口令几分钟见底。
 *
 * 三条取舍，写清楚免得以后有人「顺手优化」掉：
 *
 *   1. **退避期内不比对口令**。不能「先比对、错了再退避」：那等于给攻击者一个免费
 *      的 oracle，他照样能无限试，只是慢一点。退避期里连正确的口令都拒 —— 这是
 *      「防爆破」的本义。误伤成本很低（500ms 起，指数退避，封顶 60s）。
 *   2. **不永久封禁**。局域网 IP 会 DHCP 换，封禁会误伤自己人；而且这台 Hub 的
 *      可信边界本来就是「同网段」，不是公网。
 *   3. **只记失败次数，不记成功次数**。成功一次直接清零 —— 正常成员不会触发它。
 *
 * 状态全在内存：Hub 重启清零，这是可接受的（重启后攻击者得从头攒失败次数）。
 *
 * @module dsh-collab-board/host/ratelimit
 */

/** 连错几次开始退避。 */
export const JOIN_MAX_FAILURES = 5;
/** 第一次退避时长，之后翻倍。 */
export const JOIN_BASE_DELAY_MS = 500;
/** 退避上限：再错也只让人等一分钟，不无限长。 */
export const JOIN_MAX_DELAY_MS = 60_000;
/**
 * 最多跟多少个 IP。纯防内存被撑爆：同网段伪造源 IP 的成本极低，
 * 没有上限时一个扫描脚本就能让这张表一直涨。
 */
export const JOIN_MAX_TRACKED = 1024;

/**
 * 从请求里取一个稳定的客户端标识。
 *
 * 用 `socket.remoteAddress` 而不是 `x-forwarded-for`：这个 Hub 直连局域网、前面没有
 * 代理，那个头是**攻击者可写的**，拿它当 key 等于让攻击者自定义限流桶。
 * IPv4-mapped IPv6（`::ffff:127.0.0.1`）要归一化，不然同一台机器会记成两个桶。
 *
 * @param {{socket?: {remoteAddress?: string}, connection?: {remoteAddress?: string}}} req
 * @returns {string}
 */
export function clientKey(req) {
  const raw = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const s = String(raw).trim();
  if (s === '') return 'unknown';
  return s.replace(/^::ffff:/i, '');
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxFailures] 连错几次开始退避
 * @param {number} [opts.baseDelayMs] 首次退避
 * @param {number} [opts.maxDelayMs]  退避上限
 * @param {number} [opts.maxTracked]  记忆多少个 IP
 */
export function createJoinLimiter(opts = {}) {
  const maxFailures = Number.isFinite(Number(opts.maxFailures))
    ? Math.max(1, Math.floor(Number(opts.maxFailures)))
    : JOIN_MAX_FAILURES;
  const baseDelayMs = Number.isFinite(Number(opts.baseDelayMs))
    ? Math.max(0, Math.floor(Number(opts.baseDelayMs)))
    : JOIN_BASE_DELAY_MS;
  const maxDelayMs = Number.isFinite(Number(opts.maxDelayMs))
    ? Math.max(baseDelayMs, Math.floor(Number(opts.maxDelayMs)))
    : JOIN_MAX_DELAY_MS;
  const maxTracked = Number.isFinite(Number(opts.maxTracked))
    ? Math.max(1, Math.floor(Number(opts.maxTracked)))
    : JOIN_MAX_TRACKED;

  /** key → { fails, until, lastAt } */
  const rows = new Map();

  /** 超出上限时按 lastAt 淘汰最老的 —— 不淘汰正在退避的也没关系，它下次失败还会回来。 */
  function trim(now) {
    if (rows.size <= maxTracked) return;
    const oldest = [...rows.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0));
    let drop = rows.size - maxTracked;
    for (const [k] of oldest) {
      if (drop <= 0) break;
      rows.delete(k);
      drop -= 1;
    }
    void now;
  }

  return {
    /**
     * 现在还能不能试。返回 0 = 可以；>0 = 还要等多少毫秒。
     * @param {string} key
     * @param {number} [now]
     */
    waitMs(key, now = Date.now()) {
      const r = rows.get(key);
      if (!r) return 0;
      const left = Number(r.until || 0) - now;
      return left > 0 ? left : 0;
    },

    /**
     * 记一次口令失败。返回这次该让攻击者等多久（0 = 还没到阈值）。
     * @param {string} key
     * @param {number} [now]
     * @returns {number}
     */
    fail(key, now = Date.now()) {
      const r = rows.get(key) || { fails: 0, until: 0, lastAt: now };
      r.fails += 1;
      r.lastAt = now;
      let delay = 0;
      if (r.fails >= maxFailures) {
        // 2^(超阈次数) 翻倍，封顶；指数上限 16 次防溢出
        const exp = Math.min(r.fails - maxFailures, 16);
        delay = Math.min(maxDelayMs, baseDelayMs * 2 ** exp);
        r.until = now + delay;
      }
      rows.set(key, r);
      trim(now);
      return delay;
    },

    /** 一次成功：整个桶清掉，不留「之前错过几次」的尾巴。 */
    ok(key) {
      rows.delete(key);
    },

    /** 测试 / 诊断用。 */
    stats() {
      const now = Date.now();
      const blocked = [...rows.values()].filter((r) => Number(r.until || 0) > now).length;
      return { tracked: rows.size, blocked, maxFailures, baseDelayMs, maxDelayMs };
    },

    reset() {
      rows.clear();
    },
  };
}
