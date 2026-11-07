/**
 * 协作看板 · 宿主半边
 *
 * 三件事：
 *   1. 守着 `events.jsonl`（唯一事实源，只追加）
 *   2. 起 / 连 Hub，把本机事件推上去、把别人的拉下来
 *   3. 给面板和 agent 各开一条写入口（HTTP 路由 + collab_post 工具）
 *
 * 为什么要有这个插件：之前是几个散装脚本 + 一个自己起的 7788 端口，
 * 会话一关全停。长出插件的意义是——**DSH 活着它就活着**。
 *
 * @module dsh-collab-board
 */
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { loadIdentity } from './identity.mjs';
import { createHubClient } from './hub-client.mjs';
import { startHub } from './hub.mjs';
import {
  claimableOnly,
  claimableTasks,
  latestTasks,
  ownerTransitionError,
} from './selectable.mjs';

export const name = 'collab-board';
/** 不依赖任何服务就能活；webServer / tools 都是有了才注册。 */
export const inject = [];

/** 面板与数据接口的根路径。改它要同步改 src/client/index.js 的 API。 */
const PANEL_BASE = '/collab-board';


/**
 * 宿主包版本：启动时从 package.json 读一次。
 *
 * 为什么不手写常量：客户端那串 `v0.10.6 · b19` 是浏览器加载的 bundle，
 * 页面不刷新就一直是旧的；宿主进程又是启动时加载的。两者都可能落后。
 * 面板要判「宿主到底加载了哪版」，只能问宿主自己 —— 这个常量就是回答。
 */
const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

/** 本地时间的 ISO 串，带 +08:00 这类偏移 —— 看板直接显示，不用再换算。 */
function localIso(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${String(date.getFullYear())}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/**
 * HTTP 小工具在 http-util.mjs，和 Hub 半边共用一份。
 * 面板侧历史上把它叫 `jsonReply`，这里就保留这个别名，省得改 50 多处调用。
 */
import { json as jsonReply, readBody, writeAtomic } from './http-util.mjs';
import { createSettings, hashCode, isHashedCode, publicSettings } from './settings.mjs';
import { createStore } from './store.mjs';
import { createDelivery } from './delivery.mjs';
import { shouldWake, maxSeenOf, newerSeen, resumeSeq, directedAway, WAKE_SKIP } from './wake.mjs';
import { validateEvent, noteTaskIdOf } from './events.mjs';

export function apply(ctx, rawConfig = {}) {
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const home = (process.env['DSH_HOME'] || '').trim() || join(homedir(), '.dsh');
  const custom = typeof cfg.dataDir === 'string' ? cfg.dataDir.trim() : '';
  const dataDir = custom === '' ? join(home, 'collab') : resolve(custom);
  const LOG = join(dataDir, 'events.jsonl');

  const maxEvents = Number.isFinite(Number(cfg.maxEvents))
    ? Math.max(100, Number(cfg.maxEvents))
    : 5000;

  mkdirSync(dataDir, { recursive: true });

  /* ───────────────────── 设置（settings.json） ───────────────────── */

  const SETTINGS_FILE = join(dataDir, 'settings.json');
  // 设置项定义、校验、读写都在 settings.mjs；这里只拿到需要的那几个。
  // 口令哈希的盐用本组 groupId：两台机器算出同一个哈希，重启后也能互认。
  const {
    SETTINGS_SPEC, getSettings, patchSettings, migrateHubCode,
  } = createSettings({
    file: SETTINGS_FILE,
    maxEventsDefault: maxEvents,
    saltOf: () => identity.groupId,
  });

  /* ───────────────────── 本地事件库 ───────────────────── */

  /**
   * 事件读写全在 store.mjs。`origin` 用 getter 传：identity 在它之后建
   * （恢复 groupId 要读日志，而日志在 store 里 —— 互相引用只能延迟求值）。
   */
  const store = createStore({
    logPath: LOG,
    seqFile: join(dataDir, '.synced.json'),
    rejectedFile: join(dataDir, '.rejected.json'),
    origin: () => identity.origin,
    nameOf: () => getSettings().selfName || '',
    maxEventsOf: () => getSettings().maxEvents,
    localIso,
  });
  const { readEvents, appendEvent, pendingEvents, markSynced, invalidate, markRejected } = store;

  /* ───────────────────── 身份与 Hub ───────────────────── */

  /**
   * 身份：`origin` 生成一次永不变；`groupId` 走四级恢复（identity.json → Hub /info →
   * 本地 hub 事件 → 新生成）。groupId 换了等于换了个组，界面上看不出来，只会「又连不上」。
   */
  const identity = loadIdentity({ dir: dataDir, logPath: LOG, readLog: () => readEvents() });

  /**
   * 口令迁移：升级前落的是明文，这里一次性换成 `v1$<sha256(groupId + code)>`。
   * 必须等 identity 建好（盐是 groupId）；换过之后旧版就读不懂这个字段了，
   * 所以升级顺序是「先升 Hub，再升成员」—— Hub 端两种格式都能校验，反过来不行。
   */
  try {
    if (migrateHubCode()) {
      ctx.logger?.info?.('[collab] 口令已从明文迁移为哈希（重启 Hub 后生效）');
    }
  } catch { /* 迁移失败不该让插件起不来；下次启动再试 */ }

  /** Hub 运行态。`role` 跟着 settings 走，但真正起没起看 server/client。 */
  const hubRuntime = { role: 'solo', server: null, client: null, error: '', startedAt: '' };

  /* ───────────────────── 自动唤醒（有新消息时叫醒本机 agent） ───────────────────── */

  /**
   * 收到别人的消息 → 调 `sessionController.prompt` 把本机 agent 叫起来。
   *
   * 接口形状是从宿主包里核出来的，不是猜的（`cordis_inspect_query` → Service
   * `sessionController`，2026-11-05 核）：
   *     prompt(request: SessionPromptRequest, signal: AbortSignal)
   *     → { accepted: true }
   *
   * **两个参数都要传**。0.10.6 只传了 request，宿主内部 `signal.throwIfAborted()`
   * 读到 undefined，报 `Cannot read properties of undefined (reading 'throwIfAborted')`。
   * 表现是「叫不醒但也不报错」：`wake.on=true` 而 `lastAt` 永远是空串 —— R10 真机实测到。
   *
   * 三条护栏，缺一条都不干：
   *   1. 只认**别人发的** `msg`（自己发的不算、note 不算）
   *   2. 同一个 `taskId` / `global` 在冷却期内最多唤醒一次
   *   3. 唤醒请求全部进**投递账本**，串行投、失败重试、重启补投 ——
   *      0.10.8 以前这里是 `busy` 时不叠加、直接 return，那条消息就永远没人叫了。
   *      账本在 delivery.mjs，和 DS Bot 的 inflight.json 是同一个思路。
   *
   * **代价说清楚**：它会往对话里插一条真实消息，而且会等 agent 干完才返回。
   * 所以默认关，内容里也明写「协作看板自动触发」，不让人以为是凭空冒出来的话。
   */
  const wakeState = { lastAt: new Map() };

  /** 自动续跑撞上「会话在跑」时抛它：delivery 认 `postponeMs`，不消耗重试次数。 */
  class WakePostponed extends Error {
    constructor(message, postponeMs) {
      super(message);
      this.postponeMs = postponeMs;
    }
  }
  /** 延后多久再看一眼。会话跑完一轮的时长不可控，60 秒是「别太密、也别太迟」的折中。 */
  const WAKE_POSTPONE_MS = 60000;

  /**
   * 挑一个能唤醒的会话。返回整条 summary（不只是 id）——
   * `running` 是 0.11.21 新增的用途：自动续跑不能往一个正在跑一轮的会话里塞消息。
   */
  async function pickWakeSession() {
    const svc = typeof ctx.get === 'function' ? ctx.get('sessionController') : null;
    if (!svc || typeof svc.list !== 'function') return null;
    const out = await svc.list();
    const items = Array.isArray(out?.items) ? out.items : [];
    const alive = items.filter((s) => s && typeof s.sessionId === 'string' && s.agentAvailable !== false);
    alive.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return alive[0] || null;
  }

  /**
   * 叫醒本机 agent。
   *
   * @param {string} text
   * @param {{kind?:string}} [item] 账本里那条。只有 `kind === 'self'` 会走「会话在跑就延后」：
   *   别人发的消息该排队（人就在等回话），自动续跑是插件自己的空转，不该插进正在跑的轮次里。
   */
  async function wakeAgent(text, item) {
    const svc = typeof ctx.get === 'function' ? ctx.get('sessionController') : null;
    if (!svc || typeof svc.prompt !== 'function') throw new Error('宿主没有 sessionController.prompt');
    const picked = await pickWakeSession();
    if (!picked) throw new Error('找不到可唤醒的会话');
    const sessionId = picked.sessionId;
    /**
     * 0.11.21：自动续跑不往正在跑的会话里塞。
     *
     * 原来只有一个来源：`mode: 'queue'`，宿主会把消息排进那一轮后面 —— 于是
     * 「会话在干活」和「续跑又推了一条」撞在一起，agent 干完手头的活还要再回一条
     * 插件自己排的空转消息，越跑越多。延后不算失败：账留在原处，60 秒后再看。
     */
    if (item && item.kind === 'self' && picked.running === true) {
      throw new WakePostponed(`会话 ${String(sessionId).slice(0, 8)}… 正在跑一轮，自动续跑延后`, WAKE_POSTPONE_MS);
    }
    // requestId 是必填（SessionRequestId），mode 显式给 queue：看板消息不该打断正在跑的轮次。
    const request = {
      requestId: `collab-wake-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    };
    // 第二个参数必须是真的 AbortSignal：宿主会拿它做 throwIfAborted 前置检查。
    const r = await svc.prompt(request, new AbortController().signal);
    return { sessionId, stopReason: (r && r.stopReason) || '' };
  }

  /**
   * 唤醒文本（0.11.6 压成一行）。
   *
   * 原来是一整段三行说明，每次唤醒都往对话里糊一遍，连着七八条很吵。
   * 现在只留「谁 · 在哪 · 干什么」，一行完事。补叫 / 重试 / 合并
   * 用极短后缀标出来，不展开讲理由。该怎么做靠 agent 自己的规矩。
   */
  function wakeText(meta, attempt = 1, deferred = false) {
    const cards = Array.isArray(meta.cardIds) && meta.cardIds.length
      ? meta.cardIds.filter(Boolean)
      : (meta.taskId ? [meta.taskId] : []);
    const where = cards.length ? cards.join('、') : '全局';
    const bits = [];
    if (meta.reason === 'mention') bits.push('@你');
    if (attempt > 1) bits.push(`第 ${attempt} 次`);
    if (deferred) bits.push('补');
    const count = Math.max(1, Number(meta.coalescedCount) || 1);
    if (count > 1) bits.push(`×${count}`);
    const tag = bits.length ? ` ${bits.join(' ')}` : '';
    return `【看板】${meta.from || '对方'} ${where}${tag} · 读增量，回完停`;
  }

  function considerWake(events) {
    const s = getSettings();
    if (s.wakeOnMessage !== true) return;

    const fresh = (Array.isArray(events) ? events : []).filter(
      (ev) => ev && ev.kind === 'msg' && typeof ev.origin === 'string' && ev.origin !== identity.origin
        // 定向消息：`to` 不是我（单个或数组），就别叫 —— 依赖解锁 / @ 别人的消息走这条路
        && !directedAway(ev, identity.origin),
    );
    if (fresh.length === 0) return;

    const cooldown = Math.max(1000, Number(s.wakeCooldownMs) || 300000);
    const now = Date.now();
    let called = 0;

    for (const ev of fresh) {
      const taskId = ev.taskId || '';
      const key = taskId || 'global';
      const last = wakeState.lastAt.get(key) || 0;
      const wait = Math.max(0, cooldown - (now - last));
      /**
       * 唤醒 payload 结构化（和纯文本一起走）：
       *   - reason          为什么叫（mention / card / global）
       *   - cardIds         这一波涉及哪几张卡
       *   - coalescedCount  合并了几条（账本合并时累加）
       *   - directed        是不是点名发给我的（转让清账时不误删）
       */
      const meta = {
        taskId,
        from: ev.from || ev.name || '',
        reason: ev.to ? 'mention' : (taskId ? 'card' : 'global'),
        cardIds: taskId ? [taskId] : [],
        coalescedCount: 1,
        directed: Boolean(ev.to),
      };

      /**
       * 冷却期里**不再直接丢**。
       *
       * 0.10.9 以前这里 `return` 掉：对方 19:39:39 刚被叫醒，我 19:39:53 回一句，
       * 差 14 秒 < 5 分钟冷却 —— 那条回复就永远没人读，看板上只剩「她不回」。
       * 现在改成延后到冷却结束再投；同一个 taskId 在账本里合并成一条。
       * 一批里已经叫过一个的，后面的缓一分钟，别一口气叫好几轮。
       */
      const deferFor = wait > 0 ? wait : (called > 0 ? Math.min(cooldown, 60000) : 0);
      if (deferFor > 0) {
        delivery.offer({
          eventId: ev.id,
          ...meta,
          text: wakeText(meta, 1, true),
          // 必须显式传：delivery 的 send 会拿 item.deferred 重新生成唤醒文本，
          // 少了这行账本里就是 false，真正投出去时不带「补叫」标记。
          deferred: true,
          notBefore: now + deferFor,
        });
        continue;
      }

      called += 1;
      // 先占住冷却位；真正投出去之后 send 会用完成时刻再刷一次
      wakeState.lastAt.set(key, now);
      delivery.offer({
        eventId: ev.id,
        ...meta,
        text: wakeText(meta, 1, false),
      });
    }
  }

  /* ───────────────────── 自动续跑 ───────────────────── */

  /**
   * 任务没完成就自己再排一次（`wakeSelfContinue`，默认关）。
   *
   * 唤醒在此之前只有一个来源：别人发了消息。于是「最后一条没人回」= 链断在那儿，
   * 任务卡还挂在 running 上，没有任何人再来推它一把 —— 姐妹之间要「自己转下去」，
   * 缺的就是这一环。
   *
   * 补法：一次投递结束、账上这张卡已经空了、任务还是 running，就排下一条唤醒，
   * 到冷却结束再叫自己接着干。
   *
   * 四道刹车，缺一条都可能变成自己刷自己：
   *   1. 开关默认关，不点着不转（每转一轮都是一整轮 token）
   *   2. 只续**自己名下**的 running 卡；别人的、done、cancelled、blocked 都不续
   *   3. 账上这张卡还有待投的项就不排 —— 别人已经在叫了，别叠第二条
   *   4. 同一张卡最多连续 `wakeSelfContinueMax` 次，到了写一条 warn note 停手
   *
   * 判据一律读事件流（`latestTasks`），不另存状态：重启后看到的任务状态就是真的。
   * 只有「连了几次」放内存 —— 重启清零是对的，重启后本来就该重新给一次机会。
   */
  const selfRunCount = new Map();

  function selfContinueText(task, n, max) {
    return `【协作看板自动触发（自动续跑 ${n}/${max}）】任务 ${task.taskId}「${task.title}」`
      + `还是 ${task.status}，而且没有新消息 —— 这条是插件自己排的，不是谁在跟你说话。`
      + '先调 collab_state 读增量，接着把它干完；干完就标成 done，标完这条链自己会停。'
      + '不许为了不断链而空转：没有实际进展就标 blocked，写一条 note 说清卡在哪。';
  }

  function maybeSelfContinue(item) {
    const s = getSettings();
    if (s.wakeSelfContinue !== true) return;
    const taskId = typeof item.taskId === 'string' ? item.taskId : '';
    if (!taskId) return;

    const task = latestTasks(viewEvents()).get(taskId);
    const stop = () => { selfRunCount.delete(taskId); };
    if (!task || task.archived) return stop();
    if (task.status !== 'running') return stop();
    if (task.owner !== identity.origin) return stop();

    const max = Math.max(1, Number(s.wakeSelfContinueMax) || 8);
    const n = (selfRunCount.get(taskId) || 0) + 1;
    if (n > max) {
      stop();
      const note = buildEvent({
        kind: 'note',
        level: 'warn',
        taskId,
        text: `自动续跑 ${taskId} 连续 ${max} 次还是 ${task.status}，停了。`
          + '要么它其实干完了没标 done，要么它卡住了 —— 人工看一眼再决定。',
      });
      if (note) appendEvent(note);
      return;
    }

    // 账上这张卡还有**别的**待投项就不排 —— 别人已经在叫了，别叠第二条。
    // 必须排除正在投的这一条：send 成功回调里，这一条还没从账上摘掉。
    if (delivery.state().items.some((it) => it.taskId === taskId && it.eventId !== item.eventId)) return;

    selfRunCount.set(taskId, n);
    const cooldown = Math.max(60000, Number(s.wakeCooldownMs) || 300000);
    delivery.offer({
      eventId: `ev_self_${taskId}_${Date.now().toString(36)}_${n}`,
      taskId,
      from: displayName(),
      kind: 'self',
      text: selfContinueText(task, n, max),
      notBefore: Date.now() + cooldown,
      deferred: false,
    });
  }

  /* ───────────────────── Hub 生命周期 ───────────────────── */

  const hubLog = (level, msg) => {
    if (level === 'warn') ctx.logger?.warn?.(`[collab-hub] ${msg}`);
    else ctx.logger?.info?.(`[collab-hub] ${msg}`);
  };

  /* ───────────────────── 投递账本 ───────────────────── */

  /**
   * 唤醒请求的落盘账本（inflight.json）。
   *
   * 以前唤醒是「试一次，成功与否只写日志」：失败没人重试，重启全忘，
   * 正在唤醒时来的消息直接丢。现在先记账再投、失败按 `wakeRetries` 重试、
   * 重启后补投一次 —— 这一层是跟 DS Bot 的 resume.js 学的。
   * 投递目标不变：还是本机最近活跃的那个会话。
   */
  const delivery = createDelivery({
    file: join(dataDir, 'inflight.json'),
    retries: () => getSettings().wakeRetries,
    send: (item) => {
      // 续跑项的文本在 offer 时就算好了（要带任务标题和次数），直接用账里的那份；
      // 别人发的消息才按 attempts / deferred 现生成。
      const text = item.kind === 'self' && item.text
        ? item.text
        : wakeText({ taskId: item.taskId, from: item.from }, item.attempts, item.deferred);
      return wakeAgent(text, item).then((r) => {
        // 冷却从「真正投出去」那一刻算：投递可能等一整轮，别让它占发起时刻
        wakeState.lastAt.set(item.taskId || 'global', Date.now());
        return r;
      });
    },
    // 续跑要等这一条从账上摘掉、落了盘之后才排，否则会被合并逻辑并进本条（见 delivery.mjs）。
    onDelivered: (item) => {
      try { maybeSelfContinue(item); } catch (e) {
        hubLog('warn', `自动续跑排期失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    onGiveUp: (item) => {
      const note = buildEvent({
        kind: 'note',
        level: 'warn',
        taskId: item.taskId || '',
        text: `自动唤醒失败 ${item.max} 次，已放弃：${item.taskId || '全局'}（${item.lastError}）。`
          + '这条消息还在看板上，人工叫一次就行。',
      });
      if (note) appendEvent(note);
    },
    log: (level, msg) => hubLog(level, `投递：${msg}`),
  });

  /** 重启后补投：等 3 秒让宿主把会话都打开（DS Bot 用的是同一个值）。 */
  ctx.effect(() => {
    const boot = setTimeout(() => {
      // 开关关着就不补：账本留着，下次打开再补。别在人家关掉唤醒之后还去点会话。
      if (getSettings().wakeOnMessage !== true) return;
      const snap = delivery.snapshot();
      if (snap.queued > 0) hubLog('info', `重启补投 ${snap.queued} 条`);
      delivery.kick();
    }, 3000);
    if (typeof boot.unref === 'function') boot.unref();
    return () => {
      clearTimeout(boot);
      delivery.close();
    };
  });

  const displayName = () => getSettings().selfName || hostname();

  /** 推送成功：把 Hub 分的 `(epoch, seq)` 记进 sidecar，读取时补上。 */
  function onPushed(accepted) {
    markSynced(accepted);
  }

  /**
   * 墓碑落地后，把本机日志里这张卡的正文也擦掉（0.10.14）。
   *
   * Hub 那边擦的是它自己的 `hub-events.jsonl`；本机这份 `events.jsonl` 得自己擦，
   * 不然「删掉了」只是视图上说谎 —— 打开文件还看得见原文。
   * 只改内容，不动 id / seq / 顺序。
   */
  function scrubLocalTaskBody(taskId) {
    if (!taskId) return 0;
    const rows = readEvents();
    const kept = [];
    let hit = 0;
    for (const e of rows) {
      if (!e || e.kind !== 'task' || e.taskId !== taskId) { kept.push(e); continue; }
      if (e.deleted === true) { kept.push(e); continue; }
      /**
       * 还没推出去过的事件直接整行丢掉。
       *
       * 留着擦成空的反而更糟：`task` 事件要求有 title，擦空之后推上去会被 Hub 400 拒掉，
       * 从此卡在待同步队列里 —— 一条永远同步不了的残骸比没这条更坏。
       * 而「没推出去过」意味着别的机器从来没见过它，删掉不影响任何人的账。
       */
      const synced = Number.isFinite(e.epoch) && Number.isFinite(e.seq);
      if (!synced) { hit += 1; continue; }
      e.title = '';
      e.detail = '';
      e.owner = '';
      e.tags = [];
      e.dependsOn = [];
      e.requiredCapabilities = [];
      e.dueAt = '';
      kept.push(e);
      hit += 1;
    }
    if (hit === 0) return 0;
    try {
      // 擦正文也是全量重写：同样必须原子写，半截文件等于整份事件流没了
      writeAtomic(LOG, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
      invalidate();
    } catch { /* 写不动就先放着，下次再收到会重试 */ }
    return hit;
  }

  /**
   * 拉回来的事件：本机没有的就落盘，有的只补序号。
   *
   * **判据是「本机有没有这条 id」，不是 origin。** Hub 替本机写的事件（认领、
   * 租约释放）origin 也是本机，可本机日志里根本没有这一条 —— 按 origin 判就会
   * 把它整个丢掉，于是「我自己认领完，我看不见它变成 running」。
   */
  function onPulled(events, meta = {}) {
    const freshly = [];
    const synced = [];
    // 拉取**之前**本机见过的最高 (epoch, seq) —— 分「重放的历史」和「离线期间的真消息」。
    // 日志和 sidecar 各算一份取大：events.jsonl 会被 maxEvents 裁剪，裁过之后
    // 光看日志算出来的最大值偏小，补回来的历史就会被当新消息（真机中过，见 wake.mjs）。
    const maxSeen = newerSeen(maxSeenOf(readEvents()), store.maxSynced());
    const known = new Set(
      readEvents().map((e) => (e && typeof e.id === 'string' ? e.id : '')).filter(Boolean),
    );
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || !ev.id) continue;
      if (!known.has(ev.id)) {
        appendEvent(ev, { raw: true });
        known.add(ev.id);
        freshly.push(ev);
      }
      if (Number.isFinite(ev.epoch) && Number.isFinite(ev.seq)) synced.push(ev);
    }
    if (synced.length) markSynced(synced);
    // 收到的墓碑：正文在本机也擦掉，别让日志里还留着原文
    for (const t of freshly) {
      if (t.kind === 'task' && t.deleted === true) {
        scrubLocalTaskBody(String(t.taskId || ''));
        delivery.dropTask(String(t.taskId || ''));
        continue;
      }
      /**
       * 卡换主人 / 已经结束：账上「等当前 owner 决定」的唤醒作废。
       * 参与集只含 owner —— 别人认领了这张卡，再叫我就是叫错人。
       * 点名发给我的不在此列（`relayOnly`），@ 一次就该收到一次。
       */
      if (t.kind === 'task' && t.taskId
        && ((t.status === 'running' && t.owner && t.owner !== identity.origin)
          || t.status === 'done' || t.status === 'cancelled')) {
        delivery.dropTask(String(t.taskId), { relayOnly: true });
      }
    }
    invalidate();
    if (freshly.length === 0) return;

    /**
     * Hub 换代（epoch 变了）：seq 在新 epoch 里从 1 重来，判据不适用，
     * 整批当补历史、只落盘。否则要么全叫醒一遍，要么全判成历史、再也叫不醒。
     */
    if (meta.epochChanged) {
      noteBackfill(freshly.length);
      return;
    }

    /**
     * 首次同步（新装、或日志清空后第一次连上）：这批全是历史，只落盘不叫醒。
     * 新成员第一次看到看板，不该被几百条旧消息叫醒。之后 maxSeen 有了，
     * 客户端也只拉增量，不会再出现「历史 freshly」。
     */
    if (maxSeen.epoch === 0 && maxSeen.seq === 0) {
      noteBackfill(freshly.length);
      return;
    }

    /**
     * 新落盘 ≠ 该唤醒。
     *
     * 客户端重连时 `since = 0` 重拉全量，本机日志被清空过的那些旧消息会「本机没有」
     * 而被当成新事件 —— 2026-11-05 就是这样把一条 11-03 的 t2 消息叫醒的。
     * 判据在 wake.mjs：按 (epoch, seq) 字典序，不大于本机已见的一律算历史。
     */
    const hot = [];
    const history = [];
    for (const ev of freshly) {
      const verdict = shouldWake(ev, {
        selfOrigin: identity.origin,
        maxEpoch: maxSeen.epoch,
        maxSeq: maxSeen.seq,
      });
      if (verdict.wake) hot.push(ev);
      else if (verdict.reason === WAKE_SKIP.HISTORY) history.push(ev);
    }
    if (hot.length) considerWake(hot);
    if (history.length) noteHistorySkipped(history);
  }

  /** 被跳过唤醒的历史消息，5 分钟内最多落一条 note —— 别让每次重连都刷一条。 */
  const historyNote = { at: 0 };
  function noteHistorySkipped(list) {
    const now = Date.now();
    if (now - historyNote.at < 5 * 60 * 1000) return;
    historyNote.at = now;
    const note = buildEvent({
      kind: 'note',
      level: 'info',
      text: `补回 ${list.length} 条历史消息（seq 不大于本机已见），未唤醒 agent。`,
    });
    if (note) appendEvent(note);
  }

  /** 首次同步：整批历史落盘，不叫醒。同样 5 分钟限一条 note。 */
  function noteBackfill(count) {
    const now = Date.now();
    if (now - historyNote.at < 5 * 60 * 1000) return;
    historyNote.at = now;
    const note = buildEvent({
      kind: 'note',
      level: 'info',
      text: `首次同步 ${count} 条历史，未唤醒 agent。`,
    });
    if (note) appendEvent(note);
  }

  /**
   * 重连时从哪个 seq 往后拉（0.11.5）。
   *
   * 老规矩是「本机最大 seq 和 sidecar 取大」，为的是别把同步过的历史再拉一遍。
   * 毛病在于它只看**最大值**，看不见「中间缺了一段」：本机日志被清过
   * （`DELETE /events` 只留 member 事件）之后，本机最大 seq 还是 316，于是永远
   * 从 316 往后拉 —— 4–307 再也没人要过，缺口一形成就永久存在。
   *
   * 0.11.3 让 Hub 那台改读 Hub 全量绕过了它，但**成员机器没有全量可读**，
   * 同一个洞在那边照旧：已删的卡还当成活的显示，而且看不出来少了什么。
   * 判据和取舍写在 wake.mjs 的 `resumeSeq`。
   */
  function resumeSince() {
    const events = readEvents();
    const seq = resumeSeq(events, store.maxSynced());
    if (seq === 0) {
      hubLog('warn', `本机日志 seq 有断层（${events.length} 条），从 0 重拉一遍补缺`);
    }
    return seq;
  }

  /**
   * 挂一个 Hub 客户端。Hub 本机也走这条 —— **同步**一条路径，不分支。
   *
   * 注意「同步一条路径」不等于「读视图也只能读本机日志」：本机日志是这条增量路径的
   * 产物，seq 一旦断层就永久残缺（见本文件的 `viewEvents`，记了 2026-11-06 那次真机事故）。
   * 所以 `role === 'hub'` 时，面板和 agent 的读路径改读 Hub 内存里那份全量。
   */
  function attachClient(baseUrl, code) {
    if (hubRuntime.client) {
      try { hubRuntime.client.stop(); } catch { /* 停了就算了 */ }
    }
    const client = createHubClient({
      baseUrl,
      origin: identity.origin,
      name: displayName(),
            code: code || '',
      // 本机见过的最大 seq：重连只拉增量，不从 0 回放历史。
      // 但**日志有断层时例外**（0.11.5）—— 取 max 会永远跳过缺口，见 resumeSince。
      startSince: resumeSince(),
      pending: pendingEvents,
      onPushed,
      onEvents: onPulled,
      /**
       * Hub 明确拒了一条事件 → 写一条 warn note。
       *
       * **不能静默丢弃**：事件被跳过之后，面板上看不出「我刚写的那条没上去」，
       * agent 那边 collab_post 还返回 ok。人只会觉得数据莫名其妙少了一条。
       * 落一条 note，面板和 agent 都看得见。
       */
      onRejected: (ev, err) => {
        if (!ev || ev.kind === 'note') return; // note 自己不再生 note，防递归
        // 落盘拉黑：重启后不要再推一次、别再落一条一样的 note、别一直算在「待同步」里
        markRejected(ev.id);
        const what = ev.kind === 'task' && ev.taskId ? `task ${ev.taskId}` : String(ev.kind || '事件');
        const note = buildEvent({
          kind: 'note',
          level: 'warn',
          taskId: ev.kind === 'task' ? ev.taskId : '',
          text: `一条事件被 Hub 拒了（${what}）：${err && err.message ? err.message : '原因不明'}。`
            + '已跳过，不会堵住后面的同步；这条要补就重新发。',
        });
        if (note) appendEvent(note);
      },
      log: hubLog,
      status: () => 'idle',
      // 连上之后由**本机**写一条 member 事件：§6.10.4 禁止系统 origin 写 member
      onJoined: () => {
        const name = displayName();
        const already = readEvents().some(
          (e) => e && e.kind === 'member' && e.origin === identity.origin && e.action === 'join' && e.name === name,
        );
        if (already) return;
        const ev = buildEvent({ kind: 'member', action: 'join', name });
        if (ev) appendEvent(ev);
      },
    });
    hubRuntime.client = client;
    hubRuntime.error = '';
    client.start();
    return client;
  }

  /**
   * 口令统一成「落盘格式」再往外发：`v1$<sha256(groupId + code)>`。
   *
   * 面板/工具给的可能是明文（人刚输的），设置里存的已经是哈希（重启后没法还原明文）。
   * 两条路径都归到这里，免得 start 收明文、member 收哈希，比对时一边对不上。
   */
  function resolveHubCode(input, saltGroupId = identity.groupId) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (raw === '') return '';
    if (isHashedCode(raw)) return raw;
    const hashed = hashCode(raw, saltGroupId);
    // 本组的口令才落盘；跨组加入只在本轮内存里用另一个组的盐，别污染自己的设置
    if (saltGroupId === identity.groupId) {
      try { patchSettings({ hubCode: raw }); } catch { /* 存不下也先让它能连 */ }
    }
    return hashed;
  }

  /** 「我来当 Hub」。 */
  async function startHubRuntime(opts = {}) {
    if (hubRuntime.server) {
      return { ...hubRuntime.server.info(), already: true };
    }
    const s = getSettings();
    const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : Number(s.hubPort) || 48910;
    // 传了明文就按本组盐换成哈希（并落盘），否则用设置里已有的那份
    const code = typeof opts.code === 'string'
      ? resolveHubCode(opts.code)
      : (s.hubCode || '');
    // P0-3b：拿上次连过的地址先探一下，别让同一个组起出两个 Hub
    const probeUrl = typeof opts.probeUrl === 'string' ? opts.probeUrl : (s.hubAddress || '');
    /**
     * UDP 发现端口（0.10.13）。`createDiscovery` 一直支持传，只是面板这边
     * 从来没把它接出来 —— 于是 48911 被别的东西占了就只能关掉发现，
     * 和 TCP 端口能改的行为对不上。
     */
    const discoveryPort = Number.isFinite(Number(opts.discoveryPort))
      ? Number(opts.discoveryPort)
      : (Number(s.discoveryPort) || 48911);
    const started = await startHub({
      dir: dataDir,
      groupId: identity.groupId,
      origin: identity.origin,
      name: displayName(),
      port,
      code,
      log: hubLog,
      probeUrl,
      discoveryPort,
      force: opts.force === true,
    });
    hubRuntime.server = started.controller;
    hubRuntime.startedAt = new Date().toISOString();
    hubRuntime.role = 'hub';
    hubRuntime.error = '';
    attachClient(`http://127.0.0.1:${started.info.port}`, code);
    hubLog('info', `Hub 已起：端口 ${started.info.port}`);
    return started.controller.info();
  }

  /** 「停止 Hub」。只停服务，本机事件继续留在日志里。 */
  async function stopHubRuntime() {
    if (hubRuntime.client) {
      try { hubRuntime.client.stop(); } catch { /* ignore */ }
      hubRuntime.client = null;
    }
    if (!hubRuntime.server) {
      hubRuntime.role = hubRuntime.server ? 'hub' : 'solo';
      return { stopped: false, reason: '本来就没在当 Hub' };
    }
    const info = hubRuntime.server.info();
    try { await hubRuntime.server.close(); } catch { /* 关不掉也别卡住 */ }
    hubRuntime.server = null;
    hubRuntime.role = 'solo';
    hubLog('info', `Hub 已停（端口 ${info.port}）`);
    return { stopped: true, port: info.port };
  }

  /** 「加入别人的 Hub」。 */
  async function joinHubRemote(address, code) {
    const url = String(address || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new Error('地址要 http:// 开头，比如 http://192.168.1.5:48910');
    // 先探一下 /info：连不上就没必要挂客户端了，直接告诉人话
    let info = null;
    try {
      const res = await fetch(`${url}/collab/v1/info`, { signal: AbortSignal.timeout(5000) });
      const payload = await res.json();
      info = payload?.data || null;
    } catch (e) {
      throw new Error(`连不上 ${url}：${e.message}`);
    }
    if (!info) throw new Error(`${url} 不是协作看板的 Hub`);
    if (info.groupId && info.groupId !== identity.groupId) {
      // 不同组：加入就是加入别人的组，这个动作得显式做，不能悄悄改
      hubLog('warn', `目标 Hub 的 groupId(${info.groupId.slice(0, 6)}) 和本机(${identity.groupId.slice(0, 6)}) 不同`);
    }
    /**
     * 口令：面板传明文，设置里存哈希，加别人的 Hub 时还得按**对方组的盐**算。
     * 本组的就顺手落盘（下次重启自己连得上），跨组的只用这一轮，不覆盖本机口令。
     */
    const s = getSettings();
    const raw = typeof code === 'string' ? code.trim() : '';
    let resolved = s.hubCode || '';
    if (raw !== '') {
      resolved = isHashedCode(raw)
        ? raw
        : resolveHubCode(raw, info.groupId || identity.groupId);
    }
    if (raw !== '' && info.groupId && info.groupId !== identity.groupId) {
      hubLog('warn', '跨组加入：口令只在这次连接里用，本机设置里的口令没改；重启后要重新输入');
    }
    const client = attachClient(url, resolved);
    /**
     * **同步等一次 join**，失败就把错误抛给面板。
     *
     * 以前 attachClient 只启动后台循环、立刻返回：口令错了面板照样弹「已连上」，
     * 而实际一条都同步不了（后台每 10 秒 401 一轮，只在日志里留一行）。
     * 人看到的正是「口令好像没起作用，也看不出为什么」。
     */
    const joined = await client.join();
    if (!joined) {
      const why = String(client.state().lastError || '').trim() || '原因不明';
      detachHub();
      if (/口令/.test(why)) throw new Error('口令不对：Hub 那台设了口令，「成员」页的口令要填对才能加入');
      throw new Error(`连上了 ${url}，但加入失败：${why}`);
    }
    hubRuntime.role = 'member';
    return { address: url, epoch: info.epoch, groupId: info.groupId, needCode: info.needCode };
  }

  /**
   * 把设置里的口令（**哈希**）推给正在跑的 Hub，并让本机那个客户端用同一个口令重连。
   *
   * 这是「口令设了却没拦住人」的根因修复：`code` 原来在 startHub 里是 const，
   * 中途去设置里改口令，Hub 比对的还是启动那一刻的旧值。改了不生效，
   * 人只能怀疑「口令功能是假的」。
   */
  function applyHubCode(code) {
    if (!hubRuntime.server) return { applied: false, reason: '本机没在当 Hub' };
    const info = hubRuntime.server.info();
    try {
      hubRuntime.server.setCode(code || '');
    } catch (e) {
      return { applied: false, reason: e instanceof Error ? e.message : String(e) };
    }
    // 本机客户端连的是自己：不换的话下一轮心跳 401 → 重连时带旧口令 → 自己连不上自己
    attachClient(`http://127.0.0.1:${info.port}`, code || '');
    return { applied: true, needCode: (code || '') !== '' };
  }

  /** 断开当前 Hub（不一定停自己的服务）。 */
  function detachHub() {
    if (hubRuntime.client) {
      try { hubRuntime.client.stop(); } catch { /* ignore */ }
      hubRuntime.client = null;
    }
    if (!hubRuntime.server) hubRuntime.role = 'solo';
    return { ok: true };
  }

  function hubStatus() {
    const clientState = hubRuntime.client ? hubRuntime.client.state() : null;
    let serverInfo = null;
    try { serverInfo = hubRuntime.server ? hubRuntime.server.info() : null; } catch { serverInfo = null; }
    return {
      ok: true,
      role: hubRuntime.role,
      running: Boolean(hubRuntime.server),
      server: serverInfo,
      client: clientState,
      error: hubRuntime.error,
      groupId: identity.groupId,
      origin: identity.origin,
      pending: pendingEvents().length,
      startedAt: hubRuntime.startedAt,
      // 系统写入熔断：界面顶栏红条看这个（§32）
      systemBroken: Boolean(serverInfo?.systemBroken),
      files: serverInfo?.files || null,
      // 双 Hub 并存（§12.4.1）：界面黄条看这个
      fork: serverInfo?.fork || null,
      peers: serverInfo?.peers || [],
    };
  }

  /**
   * 认领。走当前挂着的 Hub 客户端 —— 谁连上 Hub 谁认领，本机和远端一样。
   * 没连 Hub 时明确报错，不假装成功。
   */
  async function claimTask(taskId, opts = {}) {
    if (!hubRuntime.client) throw new Error('还没连上 Hub，认领要 Hub 的串行通道');
    const out = await hubRuntime.client.claim(taskId, opts);
    /**
     * 认领成功 = 这张卡归我了：账上「等 owner 决定的卡上评论」可以清掉了
     * （点名发给我的不在此列，见 delivery.dropTask 的 relayOnly）。
     * 放在认领返回之后做，是因为 claimChain 里不能有 await —— 这里是宿主侧，不影响 Hub 的 CAS。
     */
    try { delivery.dropTask(String(taskId), { relayOnly: true }); } catch { /* 清账失败不影响认领结果 */ }
    return out;
  }

  /* ───────────────────── 面板数据 ───────────────────── */

  /**
   * 面板 / agent 看到的**视图事件流**（0.11.3）。
   *
   * 为什么不能只读本机 `events.jsonl`：那份是「增量同步的产物」，不是全量事实。
   * Hub 本机也挂着一个 client 走增量拉（`attachClient`），`startSince` 取
   * 「本地日志最大 seq」和 sidecar 的最大值 —— 本地日志一旦残缺（裁过、清过、
   * 或哪次同步没补齐），缺口就**永久**补不回来：从缺口末尾往后拉，缺口本身再没人要。
   *
   * 2026-11-06 真机就是这一条：本机 `events.jsonl` 只剩 16 条 member/hub/msg，
   * 全部 140 条 `task` 事件落在 seq 4–307 的缺口里，于是**任务列表空白、动态流正常**
   * （msg/note 恰好都是缺口之后的新消息）。而完整历史一直在 `hub-events.jsonl` 里躺着。
   *
   * 所以 `role === 'hub'` 时直接读 Hub 内存里那份全量 —— 它既是全量，也是权威序，
   * 面板没有理由绕一圈去读残缺的缓存。「一条路径不分支」说的是**同步**只有一条路，
   * 不是**读视图**也必须读同一份文件；同步缺陷不该让视图陪葬。
   *
   * 仍要并上本机独有的那些：刚写完还没推上去的（pending）、被 Hub 拒掉的
   * （`readEvents` 已滤掉，不进视图）。不并的话，发一条卡会先消失再出现。
   */
  function viewEvents() {
    const local = readEvents();
    if (hubRuntime.role !== 'hub' || !hubRuntime.server) return local;
    let hubEvents = [];
    try { hubEvents = hubRuntime.server.eventsSince(0) || []; } catch { return local; }
    if (!Array.isArray(hubEvents) || hubEvents.length === 0) return local;
    const seen = new Set();
    for (const e of hubEvents) if (e && typeof e.id === 'string' && e.id) seen.add(e.id);
    const extra = local.filter((e) => e && !(typeof e.id === 'string' && seen.has(e.id)));
    return extra.length ? hubEvents.concat(extra) : hubEvents;
  }

  function panelState(since = 0) {
    const all = viewEvents();
    return { ok: true, total: all.length, events: all.slice(since) };
  }

  /* ───────────────────── agent 读看板（增量游标） ───────────────────── */

  /**
   * 读游标：agent 读到哪了。
   *
   * 为什么要有它：agent 每轮读一遍全量事件是几千 token，而绝大多数轮次
   * 根本没有新消息。存一个游标，默认只给「上次之后」的增量，一轮几十 token。
   */
  const CURSOR_FILE = join(dataDir, '.read-cursor.json');
  let readCursor = 0;
  try {
    const raw = JSON.parse(readFileSync(CURSOR_FILE, 'utf8'));
    if (raw && Number.isFinite(Number(raw.seq))) readCursor = Number(raw.seq);
  } catch { readCursor = 0; }

  function saveCursor(seq) {
    if (!Number.isFinite(Number(seq))) return;
    readCursor = Math.max(readCursor, Number(seq));
    try { writeAtomic(CURSOR_FILE, JSON.stringify({ seq: readCursor })); } catch { /* 下次再写 */ }
  }

  /**
   * 把事件流折成 agent 要看的三块：归我的卡、待认领的卡、未读事件。
   *
   * 刻意**只返回摘要**（标题/状态/几百字正文），不返回全量原始事件 ——
   * 这是给 agent 省 token 的，不是给它做审计的。要全量去调 `/collab-board/state`。
   */
  function readBoard(opts = {}) {
    const all = viewEvents();
    const maxSeq = all.reduce((m, e) => (Number.isFinite(e.seq) ? Math.max(m, e.seq) : m), 0);
    const from = Number.isFinite(Number(opts.since))
      ? Number(opts.since)
      : (opts.full === true ? 0 : readCursor);
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));

    // 任务表：后写覆盖（判据在 selectable.mjs，别在这儿再写一遍）
    const tasks = latestTasks(all);
    const verdicts = new Map(
      claimableTasks(all, {
        selfOrigin: identity.origin,
                includeArchived: true,
      }).map((row) => [row.task.taskId, row]),
    );

    const mine = [];
    const pending = [];
    /** origin → 显示名（从 member 事件重建，不额外落盘）。 */
    const names = new Map();
    for (const ev of all) {
      if (ev && ev.kind === 'member' && typeof ev.name === 'string' && ev.name && typeof ev.target === 'string') {
        names.set(ev.target, ev.name);
      }
    }
    const watching = [];
    const others = [];
    for (const t of tasks.values()) {
      if (t.archived || t.deleted === true) continue;
      const brief = {
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        priority: t.priority || 'normal',
        ...(t.dueAt ? { dueAt: t.dueAt } : {}),
      };
      /**
       * 参与集只含 owner —— 所以「我在看的卡」= owner 是我的卡。
       * creator 不算：建 20 张卡的人不该被 20 张卡的评论各叫一次。
       */
      if (t.owner === identity.origin) {
        watching.push({ ...brief, owner: t.owner, ownerName: names.get(t.owner) || displayName() });
        if (t.status === 'running' || t.status === 'blocked') mine.push(brief);
      } else if (t.owner && t.status === 'running') {
        // 别人在跑的卡：带上 owner，agent 才知道该找谁，而不是以为「没人接」
        others.push({ ...brief, owner: t.owner, ownerName: names.get(t.owner) || '' });
      } else if (t.status === 'pending' && !t.owner) {
        // 待认领池：把它「为什么还不能接」一起给出去。
        // 只有 taskId 和标题的话，agent 会以为每张 pending 它都能接。
        const v = verdicts.get(t.taskId);
        pending.push({
          ...brief,
          claimable: Boolean(v && v.ok),
          ...(v && !v.ok && v.reason ? { blockedBy: v.reason } : {}),
        });
      }
    }

    const unread = [];
    for (const ev of all) {
      if (!ev || !Number.isFinite(ev.seq) || ev.seq <= from) continue;
      if (ev.kind === 'msg') {
        unread.push({
          seq: ev.seq,
          kind: 'msg',
          from: ev.from || ev.name || '?',
          ...(ev.taskId ? { taskId: ev.taskId } : {}),
          text: String(ev.text || '').slice(0, 500),
        });
      } else if (ev.kind === 'task') {
        /**
         * 缺省字段不写空串（0.11.16）。
         *
         * 以前 `owner: ev.owner || ''` —— 一条只带 status 的事件在投影里就变成
         * `owner: ""`，看着像「这张卡被释放了」，其实只是这条事件没带 owner。
         * 汐汐 2026-11-07 就是被这个投影骗过一次（她以为 claim 事件把 owner 冲掉了）。
         * 现在是「有才写」：缺键 = 这条事件没带，卡的当前状态看 mine/watching/pending。
         */
        unread.push({
          seq: ev.seq,
          kind: 'task',
          taskId: ev.taskId,
          ...(ev.title !== undefined ? { title: ev.title } : {}),
          ...(ev.status !== undefined ? { status: ev.status } : {}),
          ...(ev.owner !== undefined ? { owner: ev.owner } : {}),
        });
      } else if (ev.kind === 'artifact') {
        unread.push({
          seq: ev.seq,
          kind: 'artifact',
          ...(ev.taskId ? { taskId: ev.taskId } : {}),
          name: (ev.transfer && ev.transfer.name) || ev.path || '(文件)',
          ...(ev.transfer && ev.transfer.fileId ? { fileId: ev.transfer.fileId } : {}),
        });
      } else if (ev.kind === 'note') {
        unread.push({ seq: ev.seq, kind: 'note', text: String(ev.text || '').slice(0, 200) });
      }
    }
    unread.sort((a, b) => a.seq - b.seq);
    const shown = unread.slice(-limit);

    return {
      ok: true,
      me: { origin: identity.origin, name: displayName() },
      cursor: { from, to: maxSeq, unreadTotal: unread.length },
      mine,
      /** 参与集（我是 owner 的卡），含 done / cancelled —— 交接和验收要看。 */
      watching: watching.slice(0, 50),
      /** 别人正在跑的卡 + owner：知道该等谁、找谁，别以为没人接。 */
      others: others.slice(0, 50),
      pending,
      unread: shown,
      ...(unread.length > shown.length ? { truncated: unread.length - shown.length } : {}),
    };
  }

  /* ───────────────────── HTTP 路由 ───────────────────── */

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const routes = [
        {
          kind: 'exact',
          path: `${PANEL_BASE}/state`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'method' });
            const u = new URL(req.url ?? '/', 'http://panel.local');
            const since = Number(u.searchParams.get('since') ?? 0);
            return jsonReply(res, 200, panelState(Number.isFinite(since) && since > 0 ? since : 0));
          },
        },
        {
          /**
           * 宿主版本探针（0.10.6）。
           *
           * 存在的理由：面板标题那串 `v0.10.6 · b19` 是客户端常量，页面不刷新就一直
           * 是旧的；宿主体又是进程启动时加载的。两边都可能落后，光看数字判不出
           * 「宿主到底加载了哪版」。这个接口问的是宿主进程自己 —— 它报什么，
           * 就是它启动时加载的那份 package.json。
           */
          kind: 'exact',
          path: `${PANEL_BASE}/version`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'method' });
            let serverInfo = null;
            try { serverInfo = hubRuntime.server ? hubRuntime.server.info() : null; } catch { serverInfo = null; }
            const wake = delivery.snapshot();
            return jsonReply(res, 200, {
              ok: true,
              plugin: 'dsh-collab-board',
              version: PLUGIN_VERSION,
              role: hubRuntime.role,
              origin: identity.origin,
              name: displayName(),
              hostStartedAt: hubRuntime.startedAt || '',
              hubStartedAt: serverInfo?.startedAt || '',
              epoch: Number.isFinite(Number(serverInfo?.epoch)) ? Number(serverInfo.epoch) : null,
              headSeq: Number.isFinite(Number(serverInfo?.headSeq)) ? Number(serverInfo.headSeq) : null,
              /**
               * 唤醒链路状态。没有它，「没叫醒」就只能猜：是开关没开、
               * 没有活会话，还是 prompt 报错了 —— 三种都表现为「没反应」。
               * 报出来之后，另一台机器（或人）一眼能分出是哪一种。
               *
               * `queued` / `attempts` 是 0.10.9 加的：有账本之后，
               * 「没叫醒」还要分出「还在排队」「重试中」「已放弃」三种。
               */
              wake: {
                on: getSettings().wakeOnMessage === true,
                busy: wake.queued > 0,
                lastAt: wake.lastAt || '',
                lastError: wake.lastError || '',
                queued: wake.queued,
                attempts: wake.attempts,
                /** 队头那条的结构化理由（reason / cardIds / coalescedCount）。 */
                payload: wake.payload || null,
              },
              dataDir,
            });
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/post`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readBody(req);
              const ev = buildEvent(body);
              if (!ev) return jsonReply(res, 400, { ok: false, error: 'kind 不认识' });
              assertOwnerTransition(ev);
              appendEvent(ev);
              return jsonReply(res, 200, { ok: true, event: ev });
            } catch (err) {
              const status = err?.code === 'forbidden' ? 403 : 400;
              return jsonReply(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          /**
           * 删除任务卡（墓碑，0.10.14）。
           *
           * body: `{ taskId }` 删一张 ／ `{ allFinished: true }` 清掉所有已结束的卡。
           * **不删日志行** —— 事件流是两台机器同步的唯一依据，删行会让对方以为没发生过、
           * seq 还会断层。写一条 `deleted: true` 的墓碑，正文在所有机器上擦空。
           */
          kind: 'exact',
          path: `${PANEL_BASE}/tasks/delete`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readBody(req);
              const ids = [];
              if (body && body.allFinished === true) {
                for (const t of latestTasks(viewEvents()).values()) {
                  if (!t || t.deleted === true) continue;
                  if (t.status !== 'done' && t.status !== 'cancelled') continue;
                  ids.push(String(t.taskId));
                }
              } else if (body && typeof body.taskId === 'string' && body.taskId.trim()) {
                ids.push(body.taskId.trim());
              }
              if (ids.length === 0) return jsonReply(res, 400, { ok: false, error: '没有要删的卡' });
              // 已经删过的、根本不存在的都跳过：重复点不该再写一条墓碑
              const latest = latestTasks(viewEvents());
              const already = new Set(
                [...latest.values()].filter((t) => t.deleted === true).map((t) => t.taskId),
              );
              const pending = ids.filter((id) => latest.has(id) && !already.has(id));
              if (pending.length === 0) return jsonReply(res, 200, { ok: true, deleted: [], skipped: true });
              const deleted = [];
              for (const id of pending) {
                writeTombstone(id);
                deleted.push(id);
              }
              return jsonReply(res, 200, { ok: true, deleted });
            } catch (err) {
              return jsonReply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          /**
           * 成员在线态（0.10.13）。
           *
           * 事件流里的 `member` 事件只在 join 时写一次，之后再也不更新 ——
           * 所以面板上「在线」等于「加入那一刻在线」，关机了也不会变。
           * 在线态是 Hub 用 45 秒心跳窗口算出来的**瞬时值**，只能现问。
           */
          kind: 'exact',
          path: `${PANEL_BASE}/members`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'method' });
            if (!hubRuntime.client) {
              return jsonReply(res, 200, { ok: true, connected: false, members: [] });
            }
            try {
              const list = await hubRuntime.client.members();
              return jsonReply(res, 200, {
                ok: true,
                connected: Boolean(hubRuntime.client.state()?.online),
                members: list,
                online: list.filter((m) => m && m.online).length,
              });
            } catch (err) {
              // 拉不到在线态不是错：面板继续用事件流里的旧值，只是会标明「连不上」
              return jsonReply(res, 200, {
                ok: true,
                connected: false,
                members: [],
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/settings`,
          handler: async (req, res) => {
            if (req.method === 'GET') {
              return jsonReply(res, 200, {
                ok: true,
                /**
                 * **不回传口令**：以前这里把 `getSettings()` 整份吐出来，含 hubCode 原文。
                 * 现在只给 `hubCodeSet`（已设置 / 未设置），面板据此画「重设」。
                 */
                settings: publicSettings(getSettings()),
                spec: SETTINGS_SPEC,
                dataDir,
              });
            }
            if (req.method !== 'PATCH' && req.method !== 'POST') {
              return jsonReply(res, 405, { ok: false, error: 'method' });
            }
            try {
              const body = await readBody(req);
              const patch = body && typeof body === 'object' && body.patch ? body.patch : body;
              const out = patchSettings(patch);
              /**
               * 口令是热更新项（0.11.7）：Hub 正在跑就立刻换，不用停 Hub 重起。
               * 以前这里只写 settings.json，运行中的 Hub 仍拿旧的 code 比对 ——
               * 设置页写着「改完不用重启」，实际不重启就不生效。
               */
              let hubCode = null;
              if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'hubCode') && hubRuntime.server) {
                hubCode = applyHubCode(out.settings.hubCode || '');
              }
              return jsonReply(res, 200, {
                ok: true,
                settings: publicSettings(out.settings),
                ignored: out.ignored,
                dataDir,
                hubCode,
              });
            } catch (err) {
              return jsonReply(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/events`,
          handler: async (req, res) => {
            if (req.method !== 'DELETE') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              // **保留 member 事件**：成员是谁不该因为「清空聊天记录」一起没了。
              // 清掉的是任务、对话、进度这些内容；成员名单留着。
              const kept = readEvents().filter((e) => e && e.kind === 'member');
              // 清空 = 全量重写：原子写，别让断电留下半截日志
              writeAtomic(LOG, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
              invalidate();
              return jsonReply(res, 200, { ok: true, keptMembers: kept.length });
            } catch (err) {
              return jsonReply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'method' });
            return jsonReply(res, 200, hubStatus());
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub/start`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readBody(req);
              const info = await startHubRuntime(body || {});
              return jsonReply(res, 200, { ok: true, info, status: hubStatus() });
            } catch (err) {
              hubRuntime.error = err instanceof Error ? err.message : String(err);
              return jsonReply(res, 500, { ok: false, error: hubRuntime.error });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub/stop`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const out = await stopHubRuntime();
              return jsonReply(res, 200, { ok: true, ...out, status: hubStatus() });
            } catch (err) {
              return jsonReply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub/join`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readBody(req);
              const out = await joinHubRemote(body?.address, body?.code);
              // 记住这次成功连上的地址，下次启动能直接重连
              try { patchSettings({ hubAddress: String(body?.address || '') }); } catch { /* 存不进去也不影响本次 */ }
              return jsonReply(res, 200, { ok: true, ...out, status: hubStatus() });
            } catch (err) {
              return jsonReply(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub/leave`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            return jsonReply(res, 200, { ok: true, ...detachHub(), status: hubStatus() });
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub/yield`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            // 「断开我的 Hub，去连它」：停自己的 → 角色改成员 → 连对方（§12.4.1）
            let body = {};
            try { body = await readBody(req); } catch { body = {}; }
            const addr = String(body?.address || '').trim();
            if (!addr) return jsonReply(res, 400, { ok: false, error: '要给对方地址' });
            try {
              await stopHubRuntime();
              const out = await joinHubRemote(addr, body?.code || '');
              return jsonReply(res, 200, { ok: true, ...out, status: hubStatus() });
            } catch (err) {
              return jsonReply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/hub/dismiss-fork`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            // 只清这次运行内的提示；watch 的 warned 仍为 true，不会再刷屏（§12.4.1 幂等）
            try { hubRuntime.server?.clearFork?.(); } catch { /* 没有就算了 */ }
            return jsonReply(res, 200, { ok: true, status: hubStatus() });
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/probe`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'method' });
            const u = new URL(req.url ?? '/', 'http://panel.local');

            /**
             * `?call=服务名.方法名` —— 调一个**只读**方法，把结果原样返回。
             *
             * 为什么要有：光看方法名不知道参数形状（`schedule.list()` 返回什么、
             * `sessionController.list()` 里有没有 sessionId），瞎猜就是编。
             * **白名单只放只读方法**，`create` / `delete` / `prompt` 这些一律不放行 ——
             * 诊断接口不该成为能写数据的后门。
             */
            const call = u.searchParams.get('call');
            if (call) {
              const READONLY = new Set(['list', 'inspect', 'catalog', 'history', 'get', 'serialize']);
              const dot = call.lastIndexOf('.');
              const svcName = call.slice(0, dot);
              const method = call.slice(dot + 1);
              if (!svcName || !method) return jsonReply(res, 400, { ok: false, error: 'call 要写成 服务.方法' });
              if (!READONLY.has(method)) {
                return jsonReply(res, 400, { ok: false, error: `只放行只读方法：${[...READONLY].join(' / ')}` });
              }
              let svc = null;
              try { svc = typeof ctx.get === 'function' ? ctx.get(svcName) : null; } catch { svc = null; }
              if (!svc || typeof svc[method] !== 'function') {
                return jsonReply(res, 400, { ok: false, error: `没有 ${svcName}.${method}` });
              }
              try {
                const result = await svc[method]();
                return jsonReply(res, 200, { ok: true, call, result });
              } catch (e) {
                return jsonReply(res, 500, { ok: false, call, error: e instanceof Error ? e.message : String(e) });
              }
            }

            // 只读诊断：宿主里这些服务到底能不能拿到、暴露了哪些方法。
            // 用来确认「插件能不能主动唤醒 agent」这类事，**不凭猜测下结论**。
            const names = ['agents', 'sessionController', 'schedule', 'sessions', 'workspaceRegistry'];
            const out = {};
            for (const n of names) {
              let svc = null;
              try { svc = typeof ctx.get === 'function' ? ctx.get(n) : null; } catch { svc = null; }
              if (!svc) { out[n] = null; continue; }
              const methods = new Set();
              let proto = svc;
              for (let i = 0; i < 3 && proto && proto !== Object.prototype; i += 1) {
                for (const k of Object.getOwnPropertyNames(proto)) {
                  try {
                    if (typeof svc[k] === 'function') methods.add(k);
                  } catch { /* getter 可能抛 */ }
                }
                proto = Object.getPrototypeOf(proto);
              }
              out[n] = [...methods].sort();
            }
            return jsonReply(res, 200, { ok: true, services: out });
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/tasks/claim`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readBody(req, 64 * 1024);
              const out = await claimTask(String(body?.taskId || ''), body || {});
              return jsonReply(res, 200, { ok: true, ...out });
            } catch (err) {
              // Hub 的错误码原样透出来：conflict / blocked / bad-param 前端提示不同
              const code = err?.code || 'internal';
              const http = code === 'conflict' || code === 'blocked' ? 409 : code === 'bad-param' ? 400 : 500;
              return jsonReply(res, http, {
                ok: false,
                error: code,
                message: err instanceof Error ? err.message : String(err),
                owner: err?.payload?.error?.owner,
                blockedBy: err?.payload?.error?.blockedBy,
              });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/system/recover`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            // 自己是 Hub：本地再试写一条系统事件，写进去就是恢复
            if (hubRuntime.server) {
              try {
                const info = hubRuntime.server.info();
                if (info.systemBroken) {
                  hubRuntime.server.systemWrite({ kind: 'note', text: '系统写入已恢复', level: 'info' });
                }
                return jsonReply(res, 200, { ok: true, recovered: true });
              } catch (err) {
                return jsonReply(res, 500, { ok: false, error: 'system-write-failed', message: err.message });
              }
            }
            // 成员：让 Hub 那边试
            if (hubRuntime.client) {
              try {
                const out = await hubRuntime.client.recoverSystem();
                return jsonReply(res, 200, { ok: true, recovered: Boolean(out?.recovered) });
              } catch (err) {
                return jsonReply(res, 500, { ok: false, error: 'system-write-failed', message: err.message });
              }
            }
            return jsonReply(res, 400, { ok: false, error: '没有 Hub', message: '熔断恢复要连上 Hub 才能做' });
          },
        },
      ];
      const disposers = routes.map((r) => scope.webServer.register(r));
      return () => {
        for (const d of disposers.reverse()) {
          try { d(); } catch { /* 注销失败不该影响卸载 */ }
        }
      };
    });
  });

  /* ───────────────────── agent 工具 ───────────────────── */

  ctx.inject(['tools'], (scope) => {
    scope.effect(() => {
      const disposers = [

        scope.tools.register({
        name: 'collab_post',
        description:
          '往协作看板写一条记录（使用者随时在看这个看板）。' +
          'kind=msg 是人和人的话（from 填发言者名字）；' +
          'kind=task 是任务卡（taskId 相同的后写覆盖前写）；progress 是进度；' +
          'artifact 是产出物；note 是系统提示（卡在哪、为什么等）。' +
          'msg 的 mentions 指名谁就定向叫谁；卡上的普通消息只投给当前 owner（creator 不自动参与）。' +
          '**progress 会续租约、note 不会** —— 还在干就写一条 progress。' +
          '认领后默认 10 分钟租约：这段时间内一条 progress / artifact 都没写，卡会被退回待认领（msg 和 note 都不续约）。' +
          '**标 done 前先确认结果真的达成**（有产出 / 验证 / 对方确认，不是「我做了」）；' +
          'done 只许任务负责人或创建者写，别人标会 403；**标 done 只发 {taskId, status:"done"}** —— '
          + '不是创建者还带 title / detail / dependsOn，会整条 403，done 也一起没了。' +
          '不做了就标 cancelled，别留 pending 卡堵下游。' +
          '规矩：**先写日志再干活**，别干完才补记。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['msg', 'task', 'progress', 'artifact', 'note'] },
            text: { type: 'string', description: 'msg / note 的正文' },
            from: { type: 'string', description: 'msg 的说话人名字（自由填写，比如成员名）' },
            task: { type: 'string', description: '关联的任务 id，比如 t1' },
            id: { type: 'string', description: 'task 的 id' },
            title: { type: 'string', description: 'task 的标题' },
            owner: { type: 'string', description: 'task 归谁' },
            status: {
              type: 'string',
              enum: ['pending', 'running', 'blocked', 'done', 'cancelled'],
            },
            detail: { type: 'string', description: 'task 的详细描述' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id' },
            requiredCapabilities: {
              type: 'array',
              items: { type: 'string' },
              description: '做这件事需要的能力标签，如 gpu / ffmpeg',
            },
            priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'task 优先级' },
            tags: { type: 'array', items: { type: 'string' }, description: 'task 标签，最多显示 3 个' },
            dueAt: { type: 'string', description: '截止时间（ISO），只显示不提醒' },
            archived: { type: 'boolean', description: '归档后不进主视图' },
            deleted: {
              type: 'boolean',
              description: '墓碑：删除这张卡。标题/描述/标签会被擦空，日志里只留一个壳；默认视图不再显示',
            },
            taskId: { type: 'string', description: 'msg / artifact 关联的任务 id' },
            replyTo: { type: 'string', description: 'msg 回复的事件 id' },
            mentions: { type: 'array', items: { type: 'string' }, description: 'msg 里 @ 的人' },
            derivedFrom: { type: 'array', items: { type: 'string' }, description: 'artifact 的来源 fileId' },
            fileId: { type: 'string', description: 'artifact 的 Hub fileId（已上传）' },
            size: { type: 'integer', description: 'artifact 文件大小（字节）' },
            name: { type: 'string', description: 'artifact 文件名' },
            done: { type: 'integer', description: 'progress 已完成数' },
            total: { type: 'integer', description: 'progress 总数' },
            note: { type: 'string', description: 'progress 的说明' },
            path: { type: 'string', description: 'artifact 的文件路径' },
            level: { type: 'string', enum: ['info', 'warn'], description: 'note 的级别' },
          },
          required: ['kind'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '没写进去。' }],
        },
        async execute(args) {
          const ev = buildEvent(args ?? {});
          if (!ev) throw new Error('kind 不认识：' + String(args?.kind));
          // 本地先挡：抢别人认领的卡这种事件推上去必被拒，写进日志只会堵住队列
          assertOwnerTransition(ev);
          appendEvent(ev);
          return { ok: true, text: '已写进看板：' + JSON.stringify(ev).slice(0, 200) };
        },
      }),

      scope.tools.register({
        name: 'collab_claim',
        description:
          '认领一条任务卡。' +
          '要走 Hub 的串行通道 —— 两个人同时认领只有一个成功，另一个拿到 conflict。' +
          '依赖没完成会拿到 blocked，任务已取消/已完成拿到 conflict。' +
          '成功之后 Hub 会写一条 task 事件，别的机器下一轮拉取就看得见。' +
          '**没连 Hub 时明确报错，不假装认领成功。**',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', description: '要认领的任务 id，比如 t1' },
            leaseMs: {
              type: 'integer',
              description: '租约毫秒：省略 = 默认 10 分钟；0 = 这条任务不开租约。超过 24 小时会被拒',
            },
            reason: { type: 'string', description: '可省：为什么接这张卡（写进 running 事件，给人看）' },
            plan: { type: 'string', description: '可省：打算怎么做（写进 running 事件，给下一轮读看板的自己看）' },
          },
          required: ['taskId'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '没认领成功。' }],
        },
        async execute(args) {
          const taskId = String(args?.taskId || '').trim();
          if (!taskId) throw new Error('要给 taskId');
          try {
            const out = await claimTask(taskId, {
              leaseMs: args?.leaseMs,
              reason: args?.reason,
              plan: args?.plan,
            });
            const lease = Number(out?.leaseMs) > 0 ? `${Math.round(Number(out.leaseMs) / 60000)} 分钟` : '不开租约';
            return {
              ok: true,
              text: `认领成功：${taskId}（epoch ${out?.epoch}，seq ${out?.seq}，租约 ${lease}）`,
            };
          } catch (e) {
            const code = e?.code || 'internal';
            const hint =
              code === 'conflict' ? '（别人先认领了，或者任务已取消/已完成）'
                : code === 'blocked' ? `（依赖没完成：${(e?.payload?.error?.blockedBy || []).join('、') || '未知'}）`
                  : code === 'bad-param' ? '（参数不对）'
                    : '';
            throw new Error(`认领失败 ${code}${hint}：${e.message}`);
          }
        },
      }),

      scope.tools.register({
        name: 'collab_hub',
        description:
          '协作看板的 Hub 控制。action=status 看当前状态（角色、端口、在线、待同步条数）；' +
          'start 让本机当 Hub；stop 停掉本机 Hub；join 连别人的 Hub（要 address）。' +
          '**两台机器协作时，一台 start，另一台 join。**',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['status', 'start', 'stop', 'join'] },
            address: { type: 'string', description: 'join 时要：http://192.168.1.5:48910' },
            code: { type: 'string', description: 'Hub 口令（设了才要）' },
            port: { type: 'integer', description: 'start 时的端口，默认 48910' },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '没动作。' }],
        },
        async execute(args) {
          const action = String(args?.action || 'status');
          if (action === 'status') {
            const s = hubStatus();
            const lines = [
              `角色：${s.role}`,
              s.server ? `Hub 在跑：端口 ${s.server.port}，epoch ${s.server.epoch}，${s.server.events} 条事件` : '本机没在当 Hub',
              s.client ? `客户端：${s.client.online ? '在线' : '离线'} · ${s.client.baseUrl}` : '没连 Hub',
              `待同步：${s.pending} 条`,
            ];
            return { ok: true, text: lines.join('\\n') };
          }
          if (action === 'start') {
            const info = await startHubRuntime({ port: args?.port, code: args?.code });
            return { ok: true, text: `Hub 已在端口 ${info.port} 起来（epoch ${info.epoch}）` };
          }
          if (action === 'stop') {
            const out = await stopHubRuntime();
            return { ok: true, text: out.stopped ? `Hub 已停（端口 ${out.port}）` : '本来就没在当 Hub' };
          }
          if (action === 'join') {
            const out = await joinHubRemote(args?.address, args?.code);
            return { ok: true, text: `已连上 ${out.address}（epoch ${out.epoch}）` };
          }
          throw new Error('action 只能是 status / start / stop / join');
        },
      }),

      scope.tools.register({
        name: 'collab_attach',
        description:
          '把一个本地文件传到 Hub，并写一条 `artifact` 事件挂到任务上。' +
          '**先上传、再写事件** —— 反了的话，别人拿到事件时文件还没到（DESIGN §6.7 三条硬约束）。' +
          '文件按 sha256 内容寻址，同一份传两次只存一份。需要先连上 Hub。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '本地文件绝对路径' },
            taskId: { type: 'string', description: '挂到哪条任务（可省 = 不进任何任务）' },
            name: { type: 'string', description: '对方看到的名字，默认用文件名' },
            note: { type: 'string', description: '一句话说明这是什么' },
          },
          required: ['path'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '没传上去。' }],
        },
        async execute(args) {
          if (!hubRuntime.client) throw new Error('还没连上 Hub，没地方传');
          const p = String(args?.path || '');
          if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
          const buf = readFileSync(p);
          if (buf.length === 0) throw new Error('这是个空文件，不用传');
          const name = String(args?.name || basename(p)).slice(0, 200);
          const up = await hubRuntime.client.uploadFile(buf, name);
          const ev = buildEvent({
            kind: 'artifact',
            taskId: args?.taskId,
            path: p,
            name,
            note: args?.note,
            fileId: up.fileId,
            size: up.size,
          });
          if (!ev) throw new Error('artifact 事件构造失败');
          appendEvent(ev);
          return {
            ok: true,
            text: `已上传 ${name}（${buf.length} 字节，fileId ${up.fileId}），并写进看板${up.deduped ? '（Hub 上已有，去重）' : ''}`,
          };
        },
      }),

      scope.tools.register({
        name: 'collab_download',
        description:
          '从 Hub 取一个文件，**落到本地真实路径**，并校验 sha256。' +
          'agent 拿 URL 喂不了工具，必须有真路径 —— 这就是这个工具存在的理由。' +
          '不传 dest 就存到 `<数据目录>/downloads/<fileId>`。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fileId: { type: 'string', description: 'artifact 事件里的 transfer.fileId（32 位十六进制）' },
            dest: { type: 'string', description: '存到哪（绝对路径）；省略 = 数据目录下的 downloads/' },
          },
          required: ['fileId'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' }, path: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '没下下来。' }],
        },
        async execute(args) {
          if (!hubRuntime.client) throw new Error('还没连上 Hub，没地方下');
          const fileId = String(args?.fileId || '').trim();
          if (!/^[0-9a-f]{32}$/.test(fileId)) throw new Error('fileId 要 32 位小写十六进制');
          const dest = args?.dest
            ? resolve(String(args.dest))
            : join(dataDir, 'downloads', fileId);
          // 路径净化：不许跳出数据目录之外（除非调用方显式给了绝对 dest）
          if (args?.dest && dest.split(sep).includes('..')) throw new Error('dest 里不许有 ..');
          const out = await hubRuntime.client.downloadFile(fileId);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, out.buffer);
          return {
            ok: true,
            path: dest,
            text: `已下载到 ${dest}（${out.size} 字节，sha256 ${out.sha256.slice(0, 12)}…）`,
          };
        },
      }),

      scope.tools.register({
        name: 'collab_state',
        description:
          '读协作看板：哪些卡归我、哪些待认领、有没有新消息。' +
          '**默认只返回上次读到的之后的增量**（游标存在本机），所以每轮调用很便宜 —— ' +
          '被定时任务叫醒时先调它，没有新东西就什么都不用做，写一句「无新活」结束。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            since: { type: 'integer', description: '只要序号大于它的；省略 = 用本机游标' },
            full: { type: 'boolean', description: 'true = 从头看全部（排查时才用）' },
            limit: { type: 'integer', description: 'unread 最多返回多少条，默认 20' },
            advance: { type: 'boolean', description: 'false = 不推进游标（想再看一遍时用），默认推进' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '读不到。' }],
        },
        async execute(args) {
          const out = readBoard(args || {});
          if (args?.advance !== false) saveCursor(out.cursor.to);
          return { ok: true, text: JSON.stringify(out, null, 1) };
        },
      }),

      ];
      return () => {
        for (const d of disposers) {
          try { d(); } catch { /* 卸载失败不该影响别的工具 */ }
        }
      };
    });
  });

  /** 面板和工具共用的一套「把入参变事件」，两份实现迟早会走偏。 */
  function isText(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  function textList(v, max, eachMax) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
      if (!isText(item)) continue;
      const s = item.trim().slice(0, eachMax);
      if (!out.includes(s)) out.push(s);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 把 `mentions`（名字或 origin）解析成 origin 列表。
   *
   * 只有**本机见过的成员**才解析得出来：成员名挂在 `member` 事件的 `name` 上，
   * `target` 是那个人的 origin。解析不出来就原样留在 `mentions` 里（看板还能显示 @ 了谁），
   * 但不猜、不乱投 —— 猜错等于把话投给无关的人、还烧他一轮 token。
   */
  function resolveMentions(list) {
    const nameMap = new Map();
    for (const ev of viewEvents()) {
      if (!ev || ev.kind !== 'member') continue;
      const name = typeof ev.name === 'string' ? ev.name.trim() : '';
      const target = typeof ev.target === 'string' ? ev.target.trim() : '';
      if (name && /^[0-9a-f]{16}$/.test(target)) nameMap.set(name, target);
    }
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const token = String(raw || '').trim().replace(/^@/, '');
      if (token === '') continue;
      const origin = /^[0-9a-f]{16}$/.test(token) ? token : (nameMap.get(token) || '');
      // 不投给自己：@ 自己不会叫醒任何东西，只会让账本多一条空转
      if (!origin || origin === identity.origin) continue;
      if (!out.includes(origin)) out.push(origin);
    }
    return out;
  }

  /**
   * 本地事件写入（唯一入口）。v2 的可选字段在这里**原样接住**，
   * 不然面板画得出来、数据却没处落。
   *
   * `claimedAt` / `leaseMs` 故意**不接**：§6.3 规定只有 Hub 的 claim 内部路径能写，
   * 成员自己写就能伪造「我刚认领」。
   */
  function buildEvent(input) {
    const ev = buildEventRaw(input);
    if (!ev) return undefined;
    /**
     * 终态卡不许再评论（0.11.17）。
     *
     * 以前是**故意**放开的 —— `buildEventRaw` 的 msg 分支里写着「done 卡上的 @
     * 照样投一次：完成后的追问 / 补验收不能断」。实测两头都停不下来：
     * 本机日志里 33 条评论挂在已 done 的卡下（t2 标 done 之后又聊了 6 条），
     * Hub 侧 39 条 —— 「已完成」就只剩个标签。
     * 现在收死：真要补充，先把卡改回 running，评论跟着任务走。
     */
    if (ev.kind === 'msg' && ev.taskId) {
      const cur = latestTasks(viewEvents()).get(String(ev.taskId));
      if (cur && (cur.status === 'done' || cur.status === 'cancelled')) {
        const e = new Error(
          `任务 ${ev.taskId} 已${cur.status === 'done' ? '完成' : '取消'}，评论已锁；`
          + '要接着补充，先把这张卡的状态改回 running。',
        );
        e.code = 'forbidden';
        throw e;
      }
    }
    /**
     * 本地也校验（0.10.16 的缺口）：以前只在 Hub 端调 `validateEvent`，
     * 脏事件先落盘、推上去被 400 整批拒、从此堵在待同步队列 —— 0.10.14 踩过。
     * 现在写日志之前就挡掉，坏事件根本进不了本地日志。
     */
    const r = validateEvent(
      /**
       * 更新已存在的卡时允许不带 title（0.11.14）：字段继承在 Hub 端做，
       * 但 `validateEvent` 要求 task 必须有 title —— 拿 taskId 造个探针过校验，
       * 通过后返回的仍是原事件（title 字段照旧不写）。
       */
      ev.kind === 'task' && ev.title === undefined
        ? { ...ev, title: String(ev.taskId || '') }
        : ev,
      { localWrite: true },
    );
    if (!r.ok) {
      const e = new Error(`事件不合法：${r.error.message}`);
      e.code = r.error.code || 'bad-param';
      throw e;
    }
    /**
     * 只借它做**判定**，不拿它做归一化。
     *
     * `validateEvent` 会给缺省字段补值（`owner: ''` / `deleted: false`…），
     * 而 `owner` 一旦出现在事件里就表示「显式设置」—— 改个标题会被 Hub 当成
     * 「释放这张卡」。本地写的就是本地写的，缺省语义交给 Hub 端补。
     */
    return ev;
  }

  /** 老名字：造事件本体（补信封之前）。只有 buildEvent 该调它。 */
  function buildEventRaw(input) {
    const kind = typeof input?.kind === 'string' ? input.kind : '';
    const base = { ts: localIso(), kind };
    const task = isText(input?.task) ? input.task.trim() : undefined;
    if (task) base.task = task;
    switch (kind) {
      case 'msg': {
        const ev = {
          ...base,
          from: isText(input.from) ? input.from.trim() : '本机',
          text: String(input.text ?? ''),
        };
        if (isText(input.taskId)) ev.taskId = input.taskId.trim();
        else if (task) ev.taskId = task;
        if (isText(input.replyTo)) ev.replyTo = input.replyTo.trim();
        const mentions = textList(input.mentions, 16, 64);
        if (mentions.length) ev.mentions = mentions;
        /**
         * 定向投递（`to`）的三级来源，**顺序不能反**：
         *   1. 调用方显式给的 `to`（依赖解锁等系统消息就是这么发的）
         *   2. `mentions` 解析出来的 origin —— 真 @ 谁就只叫谁
         *   3. 卡上**当前 owner** —— 参与集只含 owner，creator 不算
         *
         * 都没有就不写 `to`（广播显示，不额外点名）。`done` 卡上的 @ 照样投一次：
         * 这里不看 status，完成后的追问/补验收不能断。
         */
        if (isText(input.to)) {
          ev.to = input.to.trim();
        } else if (mentions.length) {
          const targets = resolveMentions(mentions);
          if (targets.length === 1) ev.to = targets[0];
          else if (targets.length > 1) ev.to = targets;
        } else if (ev.taskId) {
          const owner = latestTasks(viewEvents()).get(ev.taskId)?.owner || '';
          // 自己的卡不用「叫自己」；待认领的卡没有 owner，保持广播让看板可见
          if (owner && owner !== identity.origin) ev.to = owner;
        }
        return ev;
      }
      case 'task': {
        // 任务标识只看 taskId；老调用方传 `id`，兼容着接住。
        // **不要把它写回 `id`** —— 那是事件信封的位置，写了会被当成事件 id。
        const rawId = isText(input.taskId) ? input.taskId : input.id;
        if (!isText(rawId)) return undefined;
        const taskId = String(rawId).trim().slice(0, 64);
        /**
         * 墓碑（0.10.14）：删除走的就是这个入口。
         * 标题/描述故意留空 —— 删掉的东西不该在本地日志里再写一遍。
         */
        const tombstone = input.deleted === true;
        /**
         * title 兜底分两种（0.11.14）：
         *   - 新建卡没给标题 → 用 taskId 兜底，至少建得出来；
         *   - **已存在的卡**没给标题 → 不写这个字段，让 Hub 从上一版继承。
         *
         * 以前一律兜底，于是「只改 status」会顺手把真标题改成 taskId
         * （汐汐 2026-11-07 T01 实测：title 被冲成 `t-t01a1b2c`）。
         */
        const knownTask = latestTasks(viewEvents()).get(taskId);
        const ev = {
          ...base,
          taskId,
          status: ['pending', 'running', 'blocked', 'done', 'cancelled'].includes(input.status)
            ? input.status
            : (tombstone ? 'cancelled' : 'pending'),
        };
        if (isText(input.title)) ev.title = input.title.trim().slice(0, 200);
        else if (tombstone) ev.title = '';
        else if (!knownTask) ev.title = taskId;
        if (tombstone) {
          ev.deleted = true;
          ev.deletedAt = isText(input.deletedAt) ? input.deletedAt : new Date().toISOString();
        }
        /**
         * `owner` 只在调用方**显式**给了的时候写。
         *
         * 无条件写 `owner: ''` 会把「改标题」变成「释放」—— 推给 Hub 之后
         * 会被 owner 迁移规则当成「替别人释放」拒掉（403），
         * 而且那条事件从此堵在本地队列里。没给 = 沿用 Hub 上的当前值。
         */
        if (input && typeof input === 'object' && 'owner' in input) {
          ev.owner = typeof input.owner === 'string' ? input.owner.trim() : '';
        }
        if (isText(input.detail)) ev.detail = input.detail.trim().slice(0, 4000);
        const dependsOn = textList(input.dependsOn, 20, 64);
        if (dependsOn.length) ev.dependsOn = dependsOn;
        const required = textList(input.requiredCapabilities, 20, 32);
        if (required.length) ev.requiredCapabilities = required;
        if (['high', 'normal', 'low'].includes(input.priority)) ev.priority = input.priority;
        const tags = textList(input.tags, 8, 24);
        if (tags.length) ev.tags = tags;
        if (isText(input.dueAt)) {
          const t = Date.parse(input.dueAt);
          if (Number.isFinite(t)) ev.dueAt = new Date(t).toISOString();
        }
        if (typeof input.archived === 'boolean') ev.archived = input.archived;
        return ev;
      }
      case 'progress': {
        /**
         * 进度必须挂在具体任务上：`validateEvent('progress')` 只认 `taskId`。
         * 老调用方写的是 `task`（和 taskId 同义），这里统一补齐；
         * 两者都没有 = 这不是一条进度，直接不写，别落一条校验不过的脏事件。
         */
        const taskId = isText(input.taskId)
          ? input.taskId.trim()
          : (task ?? (typeof input.id === 'string' ? input.id.trim() : ''));
        if (!taskId) return undefined;
        const done = Math.max(0, Math.trunc(Number(input.done) || 0));
        const total = Math.max(done, Math.trunc(Number(input.total) || 0));
        return {
          ...base,
          taskId,
          task: taskId,
          done,
          total,
          note: typeof input.note === 'string' ? input.note : '',
        };
      }
      case 'artifact': {
        const ev = {
          ...base,
          path: String(input.path ?? ''),
          note: typeof input.note === 'string' ? input.note : '',
        };
        if (isText(input.taskId)) ev.taskId = input.taskId.trim();
        else if (task) ev.taskId = task;
        const derived = textList(input.derivedFrom, 8, 64);
        if (derived.length) ev.derivedFrom = derived;
        if (isText(input.fileId)) {
          ev.transfer = {
            mode: 'hub',
            fileId: input.fileId.trim(),
            size: Number.isFinite(Number(input.size)) ? Number(input.size) : 0,
            name: isText(input.name) ? input.name.trim() : ev.path,
          };
        }
        return ev;
      }
      case 'note':
        /**
         * `taskId` 是可选字段：这条提示说的是哪张卡（0.11.4）。
         *
         * 面板据此在**卡被删掉之后把这条一起收走** —— 不然卡清了、动态流里
         * 那几十条「自动认领: xxx」还挂着，看着像没删干净。
         * 不带 = 全局提示，永远留着。
         */
        return {
          ...base,
          text: String(input.text ?? ''),
          level: input.level === 'warn' ? 'warn' : 'info',
          ...(isText(input.taskId) ? { taskId: String(input.taskId).trim().slice(0, 64) } : {}),
        };
      case 'member':
        // 成员事件由成员自己写（系统 origin 不许写 member，§6.10.4）
        return {
          ...base,
          action: ['join', 'leave', 'rename', 'update'].includes(input.action) ? input.action : 'update',
          target: isText(input.target) ? input.target.trim() : identity.origin,
          name: isText(input.name) ? input.name.trim().slice(0, 64) : displayName(),
          status: input.status === 'busy' ? 'busy' : 'idle',
        };
      default:
        return undefined;
    }
  }

  /**
   * 写之前的本地预检 —— 只查 `task` 的 owner 迁移。
   *
   * 为什么非查不可：Hub 拒事件时是**整批**拒（`validateBatch` 一失败，一趟请求全废），
   * 而客户端不标记失败项。一条非法事件留在本地日志里，就会每 3 秒重推一次、
   * 每次都把整批连坐 —— 这台机器的同步从此停摆，看板上再也收不到新东西。
   *
   * 本地视图可能落后（别人刚认领、这边还没拉到），所以这里过了**不代表** Hub 会过；
   * 但能挡住「明知是别人的卡还写自己」这一类 —— 那种推上去一定被拒。
   *
   * 判据和 Hub 共用 `selectable.mjs` 的 `ownerTransitionError()`。
   */
  function assertOwnerTransition(ev) {
    if (!ev || ev.kind !== 'task') return;
    // 没写 owner = 不动它（Hub 会沿用当前值），不用校验
    if (!Object.prototype.hasOwnProperty.call(ev, 'owner')) return;
    const tasks = latestTasks(viewEvents());
    const prev = tasks.get(ev.taskId);
    const err = ownerTransitionError({
      nextOwner: ev.owner,
      prevOwner: prev ? prev.owner : '',
      writer: identity.origin,
      hasTask: Boolean(prev),
    });
    if (err) {
      const e = new Error(err.message);
      e.code = 'forbidden';
      throw e;
    }
  }

  /* ───────────────────── 启动自动认领 ───────────────────── */

  /**
   * 自动认领：启动后扫「该我接的活」，符合条件的直接认领。
   *
   * **它能干什么、不能干什么，别混**：
   *   - 能：把卡认领到手（owner 写成自己），别的机器抢不走，看板上立刻变「进行中」
   *   - 不能：叫醒 agent。认领只是标记归属，agent 仍然要在被消息触发时才跑一轮
   *
   * 只认这些（少一条都不认）：
   *   - `pending`、没有 owner、没归档
   *   - **不是自己建的**（自己建的活该派给别人）
   *   - 依赖全部 `done` / `cancelled`
   *
   * 认失败的（conflict / blocked）也记进 `autoTried`，别每轮重试同一张卡刷日志。
   */
  const autoTried = new Set();

  /**
   * 这张卡是不是已经有一条「自动认领」提示了（0.11.5）。
   *
   * 以前每认领一次写一条 —— 租约到期 → 卡退回待认领 → 又认领 → 又一条。
   * 真机上 18 张卡攒出 42 条这种 note，把动态流整屏刷满，全是一模一样的字。
   * 一张卡只留一条就够：状态看卡片本身，这里只需要「被谁接走了」这一个事实。
   *
   * 直接查事件流、不另存状态：重启后来认、重连后再认，判据都一样。
   * 老 note 没有 `taskId` 字段，按固定文案前缀反解（和客户端的 `noteTaskIdOf` 同一套规则）。
   */
  function hasAutoClaimNote(taskId) {
    for (const e of viewEvents()) {
      if (!e || e.kind !== 'note') continue;
      const text = String(e.text || '');
      if (!text.startsWith('自动认领')) continue;
      if (noteTaskIdOf(e, text) === taskId) return true;
    }
    return false;
  }

  function pickClaimable(events) {
    // 判据只有一份，在 selectable.mjs。这里只加「这轮已经试过就别再试」。
    const list = claimableOnly(events, {
      selfOrigin: identity.origin,
          });
    return list.filter((task) => !autoTried.has(task.taskId));
  }

  ctx.effect(() => {
    let timer = null;
    let lastScan = 0;
    let busy = false;

    const tick = async () => {
      if (busy) return;
      try {
        const s = getSettings();
        if (s.autoClaim !== true) return;
        if (!hubRuntime.client) return; // 没连 Hub，没有认领通道
        const every = Math.max(1000, Number(s.autoClaimMs) || 60000);
        const now = Date.now();
        if (now - lastScan < every) return;
        lastScan = now;

        const list = pickClaimable(viewEvents());
        if (list.length === 0) return;

        busy = true;
        for (const task of list) {
          try {
            await claimTask(task.taskId, {});
            autoTried.add(task.taskId);
            // 一张卡只写一条（0.11.5）：租约到期再认、重连再认，都别重复刷
            if (!hasAutoClaimNote(task.taskId)) {
              const note = buildEvent({
                kind: 'note',
                text: `自动认领：${task.taskId} ${task.title}`,
                level: 'info',
                taskId: task.taskId,
              });
              if (note) appendEvent(note);
            }
            hubLog('info', `自动认领 ${task.taskId}`);
          } catch (e) {
            autoTried.add(task.taskId);
            // conflict（被抢了）/ blocked（依赖没完成）都是正常结果，不刷日志
            if (e.code !== 'conflict' && e.code !== 'blocked') {
              hubLog('warn', `自动认领 ${task.taskId} 失败：${e.message}`);
            }
          }
        }
      } catch { /* 扫描本身炸了不影响下一轮 */ } finally {
        busy = false;
      }
    };

    // 启动 5 秒后先扫一次（等 Hub 连上），之后每 60 秒醒一次看该不该真扫
    const boot = setTimeout(() => {
      tick();
      timer = setInterval(tick, 5000);
      if (typeof timer.unref === 'function') timer.unref();
    }, 5000);
    if (typeof boot.unref === 'function') boot.unref();
    return () => {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
    };
  });

  /* ───────────────────── 待办提醒（不是「唤醒 agent」） ───────────────────── */

  /**
   * 扫「该我接的活」并写一条系统提示。
   *
   * **诚实说明它能干什么、不能干什么**：
   *   - 能：看板动态里冒一条 `有活等人接：t4 …`，让使用者看见
   *   - 不能：自己唤起 agent。DSH 的 agent 只在被消息触发时跑一轮，插件没有开轮的权限。
   *     所以「另一台自己加入」这件事，最后还是要有人触发 —— 或者在那台挂个定时任务。
   *
   * 同一张卡只提醒一次（进程内 Map），别每分钟刷一条。
   * 扫的节奏由设置控制：每 60 秒醒一个轻表，够时间了才真算（这样改设置立即生效，不用重启）。
   */
  const wakeNotified = new Map();
  ctx.effect(() => {
    let lastScanAt = 0;
    let timer = null;
    const scan = () => {
      try {
        const s = getSettings();
        if (s.pendingWatch !== true) return;
        const every = Math.max(60000, Number(s.pendingWatchMs) || 300000);
        const now = Date.now();
        if (now - lastScanAt < every) return;
        lastScanAt = now;

        // 和自动认领同一份判据：**自己建的卡不喊**。之前这里漏了排除，
        // 于是同一张卡「认领不接、提醒却喊」，两个信号互相打脸。
        const rows = claimableTasks(viewEvents(), {
          selfOrigin: identity.origin,
                  });
        for (const { task, ok } of rows) {
          if (!ok) continue;
          if (wakeNotified.get(task.taskId) === task.status) continue;
          wakeNotified.set(task.taskId, task.status);
          const ev = buildEvent({
            kind: 'note',
            text: `有活等人接：${task.taskId} ${task.title}`,
            level: 'info',
            taskId: task.taskId,
          });
          if (ev) appendEvent(ev);
        }
      } catch { /* 扫失败不该影响插件 */ }
    };
    const boot = setTimeout(() => {
      scan();
      timer = setInterval(scan, 60000);
      if (typeof timer.unref === 'function') timer.unref();
    }, 6000);
    if (typeof boot.unref === 'function') boot.unref();
    return () => {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
    };
  });

  /* ───────────────────── 墓碑与保留期（0.10.14） ───────────────────── */

  /**
   * 写一条墓碑：这张卡的正文从此不再被读出来。
   *
   * 为什么不是「删掉日志里的行」：事件流是两台机器同步的唯一依据。删一行，
   * 对方会以为这件事没发生过；中间少一个 seq，增量拉取还会卡住。
   * 墓碑是唯一能跨机一致的做法 —— 日志留着骨架，内容擦掉。
   */
  function writeTombstone(taskId, reason = 'manual') {
    if (!taskId) throw new Error('墓碑要有 taskId');
    const ev = buildEvent({
      kind: 'task',
      taskId,
      title: '',
      status: 'cancelled',
      deleted: true,
      deletedAt: new Date().toISOString(),
    });
    if (!ev) throw new Error('墓碑没造出来：' + taskId);
    appendEvent(ev);
    // 本机这一份日志也要擦：只写墓碑不擦的话，打开 events.jsonl 还看得见原文
    scrubLocalTaskBody(taskId);
    hubLog('info', `墓碑：${taskId}（${reason}）`);
    return ev;
  }

  /**
   * 保留期：已结束的卡超过 `retentionDays` 天自动立碑。
   *
   * 每 60 秒醒一次轻表，真正扫描最多 10 分钟一次 —— 改设置立即生效，不用重启。
   * `retentionDays = 0` 等于「永不自动清」，只能手动删。
   */
  ctx.effect(() => {
    let lastScanAt = 0;
    let timer = null;
    const scan = () => {
      try {
        const s = getSettings();
        const days = Number(s.retentionDays) || 0;
        if (days <= 0) return;
        const now = Date.now();
        if (now - lastScanAt < 10 * 60 * 1000) return;
        lastScanAt = now;
        const cutoff = now - days * 86400000;
        let n = 0;
        for (const t of latestTasks(viewEvents()).values()) {
          if (!t || t.deleted === true) continue;
          if (t.status !== 'done' && t.status !== 'cancelled') continue;
          const ts = Date.parse(String(t.ts || ''));
          if (!Number.isFinite(ts) || ts > cutoff) continue;
          try {
            writeTombstone(String(t.taskId), `保留期 ${days} 天`);
            n += 1;
          } catch { /* 单张失败不影响其它 */ }
        }
        if (n > 0) hubLog('info', `保留期到点：自动立碑 ${n} 张`);
      } catch { /* 扫失败不该影响插件 */ }
    };
    const boot = setTimeout(() => {
      scan();
      timer = setInterval(scan, 60000);
      if (typeof timer.unref === 'function') timer.unref();
    }, 12000);
    if (typeof boot.unref === 'function') boot.unref();
    return () => {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
    };
  });

  /* ───────────────────── 启动时接 Hub ───────────────────── */

  /**
   * 按 `role` 自动接上：
   *   `hub`    → 本机起 Hub（端口/口令取设置）
   *   `member` → 连 `hubAddress`
   *   `solo`   → 什么都不做，看板只看本机日志
   *
   * 晚 800ms 起，别和插件加载抢时间；失败只记日志，不让插件挂掉 ——
   * 看板单机也能用，连不上 Hub 不该变成整个面板打不开。
   */
  ctx.effect(() => {
    let alive = true;
    /**
     * 启动连不上就退避重试。
     *
     * 0.10.11 以前这里失败只记一条日志，然后 `hubRuntime.client` 永远是 null ——
     * 真机实测：Hub 20:56:51 才起来，成员机 20:56 重启，join 报 `fetch failed`，
     * 之后一直挂着，直到有人手动点「连接」才通。两台机器同时重启是常态，
     * 「谁先起来」不该决定谁整天掉线。
     *
     * 退避 3s/5s/10s/20s/30s 之后封顶 60s，直到连上为止；连上了就停。
     * 每次重试都重新读设置 —— 中途改了地址/角色，下一轮就该用新值。
     */
    const RETRY_MS = [3000, 5000, 10000, 20000, 30000, 60000];
    let timer = null;
    let attempt = 0;

    const boot = async () => {
      if (!alive) return;
      // 已经连上了（手动 join、或上一轮重试成功）：不再重试
      if (hubRuntime.client || hubRuntime.server) return;
      const s = getSettings();
      try {
        if (s.role === 'hub') {
          await startHubRuntime({ port: s.hubPort, code: s.hubCode });
        } else if (s.role === 'member' && s.hubAddress) {
          await joinHubRemote(s.hubAddress, s.hubCode);
        }
        attempt = 0;
      } catch (e) {
        hubRuntime.error = e instanceof Error ? e.message : String(e);
        hubRuntime.role = s.role;
        const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
        attempt += 1;
        hubLog('warn', `启动接 Hub 失败（第 ${attempt} 次）：${hubRuntime.error}；${Math.round(wait / 1000)} 秒后重试`);
        timer = setTimeout(() => { if (alive) boot(); }, wait);
        if (typeof timer.unref === 'function') timer.unref();
      }
    };
    const first = setTimeout(() => { if (alive) boot(); }, 800);
    if (typeof first.unref === 'function') first.unref();
    return () => {
      alive = false;
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      // 插件卸载：先断客户端再停服务，别让 client 对着已经关掉的服务重试
      if (hubRuntime.client) { try { hubRuntime.client.stop(); } catch { /* ignore */ } }
      if (hubRuntime.server) { try { hubRuntime.server.close(); } catch { /* ignore */ } }
      hubRuntime.client = null;
      hubRuntime.server = null;
    };
  });

  ctx.logger?.info?.(`协作看板已就绪：${LOG}`);
}
