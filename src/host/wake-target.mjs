/**
 * 协作看板 · 唤醒该推到哪个会话（换新 or 复用）的唯一判据
 *
 * 为什么需要它：`pickWakeSession()` 按 `updatedAt` 取最新会话，也就是**人正在聊的那个**。
 * 唤醒消息一条条往里推进去，长会话越推越长 —— 一次唤醒的 prompt 中位数 159k、
 * 最大 663k（占 1M 窗口 63%）。要解决的是「别把会话推到撑爆」，不是「少叫几次」：
 * 唤醒是业务动作，频率不能降，只能改**推到哪儿**。
 *
 * 判据的输入**全部来自 `sessionController.list()` 已经返回的那份 summary**
 * （`item.projections.values`），所以这个文件是纯函数、零 I/O、零超时：
 *   - `contextPressure`  → `projectedTokens`（下一次请求的 prompt 估算）/ `pressureTokens` / `contextWindow`
 *   - `tokenUsage`       → 累计 `cacheReadTokens / (uncached + cacheRead + cacheWrite)`
 *
 * 三条都不成立就复用 —— **量不到不等于该换**。换新会话的代价是「把人正在看的对话切成两半」，
 * 宁可多花 token，也不能因为字段缺失误开一堆会话。
 *
 * 口径来源（2026-11-08 核 `@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js`）：
 *   pressureTokens  = inputTokens + cacheReadTokens + cacheWriteTokens   （prompt 侧，不含输出）
 *   projectedTokens = pressureTokens + surfaceTokens - sampledSurfaceTokens（按最后一次采样之后的增量外推）
 *   `inputTokens` **只是没命中缓存的那部分**，单独拿它当 prompt 会少算 99% —— 这是踩过的坑。
 *
 * @module dsh-collab-board/host/wake-target
 */

/** 不换的原因 / 换的原因，落日志和 `/version` 里给人看。 */
export const ROTATE_REASON = {
  OFF: 'off',
  NO_METRICS: 'no-metrics',
  HARD_LIMIT: 'hard-limit',
  SOFT_LIMIT: 'soft-limit',
  BACKOFF: 'backoff',
  REUSE: 'reuse',
};

/** 默认参数（和 settings.mjs 的 SETTINGS_SPEC 保持一致）。 */
export const ROTATE_DEFAULTS = {
  /** 总开关。关掉 = 退回 0.11.29 的行为（永远推最新会话）。 */
  enabled: true,
  /** 软条件（缓存冷了）是否生效。硬上限不看这个开关。 */
  soft: true,
  /** 硬上限：窗口占比，百分数（60 = 0.6）。 */
  hardPct: 60,
  /** 硬上限：绝对 token 数，和占比取**小**。 */
  hardAbs: 600000,
  /** 软条件：低于这个绝对长度不触发（短会话就算缓存冷也懒得换）。 */
  softAbs: 100000,
  /** 软条件：累计缓存命中率低于这个百分数才换。 */
  hitPct: 85,
  /** 刚换进去的会话，这段时间内不再因为软条件换出来（防缓存真坏时一天长出一堆会话）。 */
  backoffMs: 6 * 3600 * 1000,
};

/** 从 settings 里取一份路由参数，缺项/坏值一律落到默认值。 */
export function rotateConfigOf(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const int = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  return {
    enabled: s.wakeRotateEnabled !== false,
    soft: s.wakeRotateSoft !== false,
    hardPct: int(s.wakeHardLimitPct, ROTATE_DEFAULTS.hardPct),
    hardAbs: int(s.wakeHardLimitAbs, ROTATE_DEFAULTS.hardAbs),
    softAbs: int(s.wakeSoftLimitAbs, ROTATE_DEFAULTS.softAbs),
    hitPct: int(s.wakeCacheHitPct, ROTATE_DEFAULTS.hitPct),
    backoffMs: int(s.wakeRotateBackoffMs, ROTATE_DEFAULTS.backoffMs),
  };
}

/** 把 `projections.values` 里的一个键读成对象（不存在/形状不对 → 空对象）。 */
function rowValues(values, key) {
  const v = values && typeof values === 'object' ? values[key] : undefined;
  return v && typeof v === 'object' ? v : {};
}

/** 正有限数，否则 null。 */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 从一条 `SessionSummary` 里读出路由要用的三个数。
 *
 * @param {object} summary `sessionController.list()` 里的一条
 * @returns {{sessionId:string, running:boolean, blank:boolean,
 *            promptTokens:number|null, windowSize:number|null, cacheHitRate:number|null}}
 */
export function readWakeMetrics(summary) {
  const values = summary?.projections?.values;
  const pressure = rowValues(values, 'contextPressure');
  const usage = rowValues(values, 'tokenUsage');

  /**
   * 优先 `projectedTokens`：它把「最后一次采样之后又长出来的那截」算进去了，
   * 是**下一次请求**的估算，正是「现在推一条进去要付多少」。
   * 老一点的数据只有 `pressureTokens`（上一次请求实际花的），用它兜底。
   */
  const promptTokens = posNum(pressure.projectedTokens) ?? posNum(pressure.pressureTokens);
  const windowSize = posNum(pressure.contextWindow);

  const read = Number(usage.cacheReadTokens) || 0;
  const uncached = Number(usage.uncachedInputTokens) || 0;
  const write = Number(usage.cacheWriteTokens) || 0;
  const total = read + uncached + write;
  const cacheHitRate = total > 0 ? read / total : null;

  return {
    sessionId: typeof summary?.sessionId === 'string' ? summary.sessionId : '',
    running: summary?.running === true,
    blank: summary?.blank === true,
    promptTokens,
    windowSize,
    cacheHitRate,
  };
}

/**
 * 硬上限 = min(窗口 × 占比, 绝对上限)。
 *
 * 为什么两个都要：占比防止换小窗口模型后 600k 直接超过窗口；绝对上限防止
 * 超大窗口（1M）下 60% = 629k 太晚 —— 到那时每轮唤醒都在为「已经过长的上下文」
 * 付钱，而且模型质量开始掉。窗口量不到 → null（这时硬上限不判，见 decideRotation）。
 */
export function hardLimitOf(windowSize, hardPct, hardAbs) {
  const win = Number(windowSize);
  if (!Number.isFinite(win) || win <= 0) return null;
  const byRatio = win * (Math.max(1, Number(hardPct) || ROTATE_DEFAULTS.hardPct) / 100);
  const abs = Math.max(1, Number(hardAbs) || ROTATE_DEFAULTS.hardAbs);
  return Math.min(byRatio, abs);
}

/**
 * 该不该换一个新会话。
 *
 * 判据顺序（前一条成立就不再往下看）：
 *   1. 总开关关 → 复用
 *   2. prompt 量不到 → 复用（宁可多花，不能因缺字段乱开）
 *   3. 硬上限：prompt ≥ min(窗口×占比, 绝对上限) → 换【无条件】。窗口量不到就不判这条。
 *   4. 软条件：刚进制防抖窗口内 → 不换；否则 prompt ≥ 软限 且 累计命中率 < 阈值 → 换
 *   5. 其余 → 复用
 *
 * 为什么软条件看**累计**命中率、不看「最近一次」：宿主只把 `tokenUsage.totals`
 * 挂上 wire（`last` 留在投影 state 里，`projections()` 拿不到）。实测本机 89 个会话
 * 最近一次命中率最低 0.91、累计命中率低的 3 个都只有 1 轮且不到 60k ——
 * 有 `softAbs` 这道门槛，累计口径不会把新会话误判成「缓存坏了」。
 *
 * @param {object} metrics readWakeMetrics 的结果
 * @param {object} cfg     rotateConfigOf 的结果
 * @param {{recentlyRotated?:boolean}} [ctx] 这个会话是不是刚从轮换里建出来的
 * @returns {{rotate:boolean, reason:string, detail?:object}}
 */
export function decideRotation(metrics, cfg = ROTATE_DEFAULTS, ctx = {}) {
  const c = { ...ROTATE_DEFAULTS, ...(cfg || {}) };
  const m = metrics || {};

  if (c.enabled === false) return { rotate: false, reason: ROTATE_REASON.OFF };
  if (m.promptTokens == null) return { rotate: false, reason: ROTATE_REASON.NO_METRICS };

  const limit = hardLimitOf(m.windowSize, c.hardPct, c.hardAbs);
  if (limit != null && m.promptTokens >= limit) {
    return {
      rotate: true,
      reason: ROTATE_REASON.HARD_LIMIT,
      detail: { promptTokens: m.promptTokens, limit: Math.round(limit), windowSize: m.windowSize },
    };
  }

  if (c.soft !== false) {
    const softFires = m.promptTokens >= c.softAbs
      && m.cacheHitRate != null
      && m.cacheHitRate < c.hitPct / 100;
    if (softFires) {
      if (ctx && ctx.recentlyRotated) return { rotate: false, reason: ROTATE_REASON.BACKOFF };
      return {
        rotate: true,
        reason: ROTATE_REASON.SOFT_LIMIT,
        detail: { promptTokens: m.promptTokens, cacheHitRate: Number(m.cacheHitRate.toFixed(4)), hitPct: c.hitPct },
      };
    }
  }

  return { rotate: false, reason: ROTATE_REASON.REUSE };
}

/**
 * 在 `list()` 的结果里挑这次要推的会话。
 *
 * 优先级：设置里指定的 `wakeSessionId`（换过一次就写死在那儿）→ 最新的可用会话。
 *
 * **配置的那个会话允许 `agentAvailable === false`**：冷会话 `prompt()` 会把它唤醒，
 * 而`pickWakeSession` 的「可用」过滤本来是为了别推给一个已经没了的会话。
 * 如果只认 `agentAvailable`，一次重启就会把唤醒流量全赶回人正在聊的那个会话 ——
 * 这正是要避免的事。
 */
export function pickTargetSummary(items, preferredId, fallback) {
  const list = Array.isArray(items) ? items : [];
  const want = typeof preferredId === 'string' ? preferredId.trim() : '';
  if (want) {
    const hit = list.find((s) => s && s.sessionId === want);
    if (hit) return hit;
  }
  return fallback || null;
}

/** 换会话的原因写成人话，给日志 / note / 面板用。 */
export function rotateReasonText(route) {
  const r = route || {};
  if (r.reason === ROTATE_REASON.HARD_LIMIT) {
    const d = r.detail || {};
    return `上下文 ${d.promptTokens} 已到硬上限 ${d.limit}（窗口 ${d.windowSize}）`;
  }
  if (r.reason === ROTATE_REASON.SOFT_LIMIT) {
    const d = r.detail || {};
    return `缓存命中率 ${d.cacheHitRate} 低于 ${d.hitPct}%，而上下文已有 ${d.promptTokens}`;
  }
  return r.reason || '';
}

/**
 * 挑这次要推给哪个会话（唤醒入口用的那一步）。
 *
 * `alive` 是「宿主里已经有 agent 的」那些会话 —— DSH 刚起来时人没打开过的会话
 * 都是冷的（`agentAvailable === false`），会被整批刷掉。这时候如果设置里指定了
 * 工作会话，就必须认它（`prompt()` 会把冷会话拉起来）；否则重启后唤醒会一直
 * 报「找不到可唤醒的会话」，指定的工作会话也白配。
 *
 * @param {object} arg
 * @param {object[]} arg.items        `list()` 的全部 summary
 * @param {object[]} arg.alive        过滤后还能推的会话（按 updatedAt 降序）
 * @param {string}   [arg.configuredId] 设置里的 `wakeSessionId`
 * @returns {{picked:object|null, configuredSummary:object|null, subject:object|null, error:string}}
 */
export function resolveWakeSubject({ items, alive, configuredId } = {}) {
  const picked = (Array.isArray(alive) && alive[0]) || null;
  const want = typeof configuredId === 'string' ? configuredId.trim() : '';
  const configuredSummary = want
    ? ((Array.isArray(items) ? items : []).find((s) => s && s.sessionId === want) || null)
    : null;
  const subject = picked || configuredSummary;
  return {
    picked,
    configuredSummary,
    subject,
    error: subject ? '' : '找不到可唤醒的会话',
  };
}

/**
 * 建一个「唤醒推到哪儿」的路由器。
 *
 * 判据是纯的（`decideRotation`），副作用集中在这里，且全部可注入 ——
 * `create()` / 写回设置 / 记 note 都能在测试里换成假的，不用起宿主、不用等投递。
 *
 * 三个副作用，缺一条都会留坑：
 *   1. `create()` 失败或没返回 id → **降级复用**当前会话（唤醒不能因为路由卡住）
 *   2. `create()` 成功 → **必须把新 id 写回设置**，否则下次又挑回人正在聊的那个，
 *      换会话只生效一次
 *   3. 写一条 note 说明为什么换（人只会看到「回复跑到另一个会话里了」）
 *
 * @param {object} deps
 * @param {()=>object}  deps.getSettings    读设置
 * @param {(patch:object)=>void} deps.patchSettings 写设置（写回 wakeSessionId）
 * @param {(level:string,msg:string)=>void} [deps.log]
 * @param {(route:object, metrics:object)=>void} [deps.onRotate] 换成功后的回调（写 note）
 * @param {()=>number} [deps.now]
 */
export function createWakeRouter({ getSettings, patchSettings, log = () => {}, onRotate = () => {}, now = () => Date.now() } = {}) {
  /** 轮换建出来的会话（id → 建成时间）。只给软条件做防抖，重启清零是对的。 */
  const rotatedAt = new Map();
  /** 上一次的决定。换会话会改变回复出现在哪个对话里，事后要能查出原因。 */
  let last = { at: 0, sessionId: '', rotated: false, reason: '', detail: null, error: '' };

  /**
   * @param {object} arg
   * @param {object} arg.svc    sessionController（要有 prompt；create 可缺）
   * @param {object[]} arg.items `list()` 的全部 summary
   * @param {object} arg.picked 「最近活跃」那条（兜底目标）
   * @returns {Promise<{sessionId:string, rotated:boolean, reason:string,
   *          detail:object|null, target:object|null, error:string}>}
   */
  async function resolve({ svc, items, picked }) {
    const settings = typeof getSettings === 'function' ? (getSettings() || {}) : {};
    const cfg = rotateConfigOf(settings);
    const target = pickTargetSummary(items, settings.wakeSessionId, picked);
    const metrics = readWakeMetrics(target);
    const stamp = rotatedAt.get(metrics.sessionId) || 0;
    const recentlyRotated = stamp > 0 && now() - stamp < cfg.backoffMs;
    const decision = decideRotation(metrics, cfg, { recentlyRotated });

    const base = {
      sessionId: metrics.sessionId,
      rotated: false,
      reason: decision.reason,
      detail: decision.detail || null,
      target,
      error: '',
    };
    if (!decision.rotate) {
      last = { ...base, at: now() };
      return base;
    }
    if (!svc || typeof svc.create !== 'function') {
      const out = { ...base, reason: ROTATE_REASON.REUSE, error: '宿主没有 sessionController.create' };
      last = { ...out, at: now() };
      return out;
    }

    try {
      const request = {};
      if (typeof target?.cwd === 'string' && target.cwd) request.cwd = target.cwd;
      const preset = target?.projections?.values?.agentPreset;
      if (typeof preset === 'string' && preset) request.agentPreset = preset;
      const created = await svc.create(request);
      const newId = created && typeof created.sessionId === 'string' ? created.sessionId : '';
      if (!newId) throw new Error('create 没返回 sessionId');
      rotatedAt.set(newId, now());

      let error = '';
      try {
        patchSettings({ wakeSessionId: newId });
      } catch (e) {
        // 写不回去也认这条新会话（这一次投对了），只是下次可能又挑回旧的
        error = `写回 wakeSessionId 失败：${e instanceof Error ? e.message : String(e)}`;
        log('warn', error);
      }

      const out = { ...base, sessionId: newId, rotated: true, target: null, error };
      last = { ...out, at: now() };
      try { onRotate(out, metrics); } catch { /* 记 note 失败不该影响唤醒 */ }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('warn', `换新会话失败，沿用当前会话：${msg}`);
      const out = { ...base, reason: ROTATE_REASON.REUSE, error: msg };
      last = { ...out, at: now() };
      return out;
    }
  }

  return { resolve, last: () => last, rotatedAt };
}
