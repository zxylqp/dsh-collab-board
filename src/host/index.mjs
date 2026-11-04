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
import { join, resolve, basename, dirname, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { loadIdentity } from './identity.mjs';
import { createHubClient } from './hub-client.mjs';
import { startHub } from './hub.mjs';
import {
  claimableOnly,
  claimableTasks,
  latestTasks,
  missingCapabilities,
  ownerTransitionError,
} from './selectable.mjs';

export const name = 'collab-board';
/** 不依赖任何服务就能活；webServer / tools 都是有了才注册。 */
export const inject = [];

/** 面板与数据接口的根路径。改它要同步改 src/client/index.js 的 API。 */
const PANEL_BASE = '/collab-board';

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
import { createSettings } from './settings.mjs';
import { createCapabilities } from './capabilities.mjs';
import { createStore } from './store.mjs';

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
  const {
    SETTINGS_SPEC, getSettings, patchSettings,
  } = createSettings({ file: SETTINGS_FILE, maxEventsDefault: maxEvents });

  /* ───────────────────── 能力自检（§6.8） ───────────────────── */

  // 探测表、chrome 路径、手填标签的合并全在 capabilities.mjs。
  const { detectCapabilities, capabilityPayload } = createCapabilities({
    dataDir, getSettings, localIso,
  });

  /* ───────────────────── 本地事件库 ───────────────────── */

  /**
   * 事件读写全在 store.mjs。`origin` 用 getter 传：identity 在它之后建
   * （恢复 groupId 要读日志，而日志在 store 里 —— 互相引用只能延迟求值）。
   */
  const store = createStore({
    logPath: LOG,
    seqFile: join(dataDir, '.synced.json'),
    origin: () => identity.origin,
    nameOf: () => getSettings().selfName || '',
    maxEventsOf: () => getSettings().maxEvents,
    localIso,
  });
  const { readEvents, appendEvent, pendingEvents, markSynced, invalidate } = store;

  /* ───────────────────── 身份与 Hub ───────────────────── */

  /**
   * 身份：`origin` 生成一次永不变；`groupId` 走四级恢复（identity.json → Hub /info →
   * 本地 hub 事件 → 新生成）。groupId 换了等于换了个组，界面上看不出来，只会「又连不上」。
   */
  const identity = loadIdentity({ dir: dataDir, logPath: LOG, readLog: () => readEvents() });

  /** Hub 运行态。`role` 跟着 settings 走，但真正起没起看 server/client。 */
  const hubRuntime = { role: 'solo', server: null, client: null, error: '', startedAt: '' };

  /* ───────────────────── 自动唤醒（有新消息时叫醒本机 agent） ───────────────────── */

  /**
   * 收到别人的消息 → 调 `sessionController.prompt` 把本机 agent 叫起来。
   *
   * 接口形状是从宿主包里核出来的，不是猜的：
   *     sessionController.prompt({ sessionId, prompt: [{ type: 'text', text }] })
   *     → { stopReason: 'end_turn' }
   *
   * 三条护栏，缺一条都不干：
   *   1. 只认**别人发的** `msg`（自己发的不算、note 不算）
   *   2. 同一个 `taskId` / `global` 在冷却期内最多唤醒一次
   *   3. 正在唤醒时不叠加（`prompt` 会等一整轮跑完，可能几十秒）
   *
   * **代价说清楚**：它会往对话里插一条真实消息，而且会等 agent 干完才返回。
   * 所以默认关，内容里也明写「协作看板自动触发」，不让人以为是凭空冒出来的话。
   */
  const wakeState = { lastAt: new Map(), busy: false, lastError: '', lastAtIso: '' };

  async function pickWakeSession() {
    const svc = typeof ctx.get === 'function' ? ctx.get('sessionController') : null;
    if (!svc || typeof svc.list !== 'function') return '';
    const out = await svc.list();
    const items = Array.isArray(out?.items) ? out.items : [];
    const alive = items.filter((s) => s && typeof s.sessionId === 'string' && s.agentAvailable !== false);
    alive.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return alive[0] ? alive[0].sessionId : '';
  }

  async function wakeAgent(text) {
    const svc = typeof ctx.get === 'function' ? ctx.get('sessionController') : null;
    if (!svc || typeof svc.prompt !== 'function') throw new Error('宿主没有 sessionController.prompt');
    const sessionId = await pickWakeSession();
    if (!sessionId) throw new Error('找不到可唤醒的会话');
    const r = await svc.prompt({ sessionId, prompt: [{ type: 'text', text }] });
    return { sessionId, stopReason: (r && r.stopReason) || '' };
  }

  function considerWake(events) {
    if (wakeState.busy) return;
    const s = getSettings();
    if (s.wakeOnMessage !== true) return;

    const fresh = (Array.isArray(events) ? events : []).filter(
      (ev) => ev && ev.kind === 'msg' && typeof ev.origin === 'string' && ev.origin !== identity.origin,
    );
    if (fresh.length === 0) return;

    const cooldown = Math.max(60000, Number(s.wakeCooldownMs) || 300000);
    const now = Date.now();
    const target = fresh.find((ev) => {
      const k = ev.taskId || 'global';
      return now - (wakeState.lastAt.get(k) || 0) >= cooldown;
    });
    if (!target) return;

    const key = target.taskId || 'global';
    wakeState.lastAt.set(key, now);
    wakeState.busy = true;

    const where = target.taskId ? `任务 ${target.taskId}` : '全局';
    const text = `【协作看板自动触发】${target.from || target.name || '对方'} 在${where}发了新消息。`
      + '先调 collab_state 读增量（不要全量读），看完再决定要不要回。'
      + '回完就停，不要连续追问。';

    wakeAgent(text)
      .then((r) => {
        wakeState.lastAtIso = new Date().toISOString();
        wakeState.lastError = '';
        hubLog('info', `已唤醒会话 ${String(r.sessionId).slice(0, 16)}…（${r.stopReason || '?'}）`);
      })
      .catch((e) => {
        wakeState.lastError = e instanceof Error ? e.message : String(e);
        hubLog('warn', `唤醒失败：${wakeState.lastError}`);
      })
      .finally(() => { wakeState.busy = false; });
  }

  /* ───────────────────── Hub 生命周期 ───────────────────── */

  const hubLog = (level, msg) => {
    if (level === 'warn') ctx.logger?.warn?.(`[collab-hub] ${msg}`);
    else ctx.logger?.info?.(`[collab-hub] ${msg}`);
  };

  const displayName = () => getSettings().selfName || hostname();

  /** 推送成功：把 Hub 分的 `(epoch, seq)` 记进 sidecar，读取时补上。 */
  function onPushed(accepted) {
    markSynced(accepted);
  }

  /**
   * 拉回来的事件：本机没有的就落盘，有的只补序号。
   *
   * **判据是「本机有没有这条 id」，不是 origin。** Hub 替本机写的事件（认领、
   * 租约释放）origin 也是本机，可本机日志里根本没有这一条 —— 按 origin 判就会
   * 把它整个丢掉，于是「我自己认领完，我看不见它变成 running」。
   */
  function onPulled(events) {
    const freshly = [];
    const synced = [];
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
    invalidate();
    // 只有**真正新落盘的**事件才考虑唤醒（重复拉回来、补序号都不算）
    if (freshly.length) considerWake(freshly);
  }

  /** 挂一个 Hub 客户端。Hub 本机也走这条 —— 一条路径，不分支。 */
  function attachClient(baseUrl, code) {
    if (hubRuntime.client) {
      try { hubRuntime.client.stop(); } catch { /* 停了就算了 */ }
    }
    const client = createHubClient({
      baseUrl,
      origin: identity.origin,
      name: displayName(),
      capabilities: capabilityPayload().all,
      code: code || '',
      pending: pendingEvents,
      onPushed,
      onEvents: onPulled,
      log: hubLog,
      status: () => 'idle',
      // 连上之后由**本机**写一条 member 事件：§6.10.4 禁止系统 origin 写 member
      onJoined: () => {
        const name = displayName();
        const caps = capabilityPayload().all;
        const already = readEvents().some(
          (e) => e && e.kind === 'member' && e.origin === identity.origin && e.action === 'join' && e.name === name,
        );
        if (already) return;
        const ev = buildEvent({ kind: 'member', action: 'join', name, capabilities: caps });
        if (ev) appendEvent(ev);
      },
    });
    hubRuntime.client = client;
    hubRuntime.error = '';
    client.start();
    return client;
  }

  /** 「我来当 Hub」。 */
  async function startHubRuntime(opts = {}) {
    if (hubRuntime.server) {
      return { ...hubRuntime.server.info(), already: true };
    }
    const s = getSettings();
    const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : Number(s.hubPort) || 48910;
    const code = typeof opts.code === 'string' ? opts.code : (s.hubCode || '');
    // P0-3b：拿上次连过的地址先探一下，别让同一个组起出两个 Hub
    const probeUrl = typeof opts.probeUrl === 'string' ? opts.probeUrl : (s.hubAddress || '');
    const started = await startHub({
      dir: dataDir,
      groupId: identity.groupId,
      origin: identity.origin,
      name: displayName(),
      port,
      code,
      log: hubLog,
      probeUrl,
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
    attachClient(url, code || '');
    hubRuntime.role = 'member';
    return { address: url, epoch: info.epoch, groupId: info.groupId, needCode: info.needCode };
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
    return hubRuntime.client.claim(taskId, opts);
  }

  /* ───────────────────── 面板数据 ───────────────────── */

  function panelState(since = 0) {
    const all = readEvents();
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
    const all = readEvents();
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
        capabilities: capabilityPayload().all,
        includeArchived: true,
      }).map((row) => [row.task.taskId, row]),
    );

    const mine = [];
    const pending = [];
    for (const t of tasks.values()) {
      if (t.archived) continue;
      const brief = {
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        priority: t.priority || 'normal',
        ...(t.dueAt ? { dueAt: t.dueAt } : {}),
      };
      if (t.owner === identity.origin) {
        if (t.status === 'running' || t.status === 'blocked') mine.push(brief);
      } else if (t.status === 'pending' && !t.owner) {
        // 待认领池：把它「为什么还不能接」一起给出去。
        // 只有 taskId 和标题的话，agent 会以为每张 pending 它都能接。
        const v = verdicts.get(t.taskId);
        pending.push({
          ...brief,
          claimable: Boolean(v && v.ok),
          ...(v && !v.ok && v.reason ? { blockedBy: v.reason } : {}),
          ...(missingCapabilities(t, capabilityPayload().all).length
            ? { missingCapabilities: missingCapabilities(t, capabilityPayload().all) }
            : {}),
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
        unread.push({
          seq: ev.seq,
          kind: 'task',
          taskId: ev.taskId,
          title: ev.title,
          status: ev.status,
          owner: ev.owner || '',
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
          kind: 'exact',
          path: `${PANEL_BASE}/post`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readBody(req);
              const ev = buildEvent(body);
              if (!ev) return jsonReply(res, 400, { ok: false, error: 'kind 不认识' });
              assertOwnerTransition(body, ev);
              appendEvent(ev);
              return jsonReply(res, 200, { ok: true, event: ev });
            } catch (err) {
              const status = err?.code === 'forbidden' ? 403 : 400;
              return jsonReply(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
                settings: getSettings(),
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
              // 刚把「启动时探测」打开，就顺手探一次 —— 不然要等下次重启才有标签
              if (patch && patch.capabilityDetect === true) {
                detectCapabilities().catch(() => { /* 失败就是没标签 */ });
              }
              return jsonReply(res, 200, { ok: true, ...out, dataDir });
            } catch (err) {
              return jsonReply(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/capabilities`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'method' });
            return jsonReply(res, 200, capabilityPayload());
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/capabilities/detect`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'method' });
            try {
              await detectCapabilities();
              return jsonReply(res, 200, capabilityPayload());
            } catch (err) {
              return jsonReply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
              writeFileSync(LOG, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '', 'utf8');
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
          assertOwnerTransition(args ?? {}, ev);
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
            capabilities: {
              type: 'array',
              items: { type: 'string' },
              description: '本次自报的能力标签，只用来算「缺 xx」警告，不改变广播出去的能力画像',
            },
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
              capabilities: args?.capabilities,
            });
            const lease = Number(out?.leaseMs) > 0 ? `${Math.round(Number(out.leaseMs) / 60000)} 分钟` : '不开租约';
            const warn = Array.isArray(out?.warnings) && out.warnings.length ? `；注意：${out.warnings.join('、')}` : '';
            return {
              ok: true,
              text: `认领成功：${taskId}（epoch ${out?.epoch}，seq ${out?.seq}，租约 ${lease}）${warn}`,
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
   * 本地事件写入。v2 的可选字段（priority / tags / dueAt / dependsOn /
   * requiredCapabilities / archived / derivedFrom）在这里**原样接住**，
   * 不然面板画得出来、数据却没处落。
   *
   * `claimedAt` / `leaseMs` 故意**不接**：§6.3 规定只有 Hub 的 claim 内部路径能写，
   * 成员自己写就能伪造「我刚认领」。
   */
  function buildEvent(input) {
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
        return ev;
      }
      case 'task': {
        // 任务标识只看 taskId；老调用方传 `id`，兼容着接住。
        // **不要把它写回 `id`** —— 那是事件信封的位置，写了会被当成事件 id。
        const rawId = isText(input.taskId) ? input.taskId : input.id;
        if (!isText(rawId)) return undefined;
        const taskId = String(rawId).trim().slice(0, 64);
        const ev = {
          ...base,
          taskId,
          title: isText(input.title) ? input.title.trim().slice(0, 200) : taskId,
          owner: typeof input.owner === 'string' ? input.owner.trim() : '',
          status: ['pending', 'running', 'blocked', 'done', 'cancelled'].includes(input.status)
            ? input.status
            : 'pending',
        };
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
      case 'progress':
        return {
          ...base,
          task: task ?? (typeof input.id === 'string' ? input.id : ''),
          done: Number.isFinite(Number(input.done)) ? Number(input.done) : 0,
          total: Number.isFinite(Number(input.total)) ? Number(input.total) : 0,
          note: typeof input.note === 'string' ? input.note : '',
        };
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
        return { ...base, text: String(input.text ?? ''), level: input.level === 'warn' ? 'warn' : 'info' };
      case 'member':
        // 成员事件由成员自己写（系统 origin 不许写 member，§6.10.4）
        return {
          ...base,
          action: ['join', 'leave', 'rename', 'update'].includes(input.action) ? input.action : 'update',
          target: isText(input.target) ? input.target.trim() : identity.origin,
          name: isText(input.name) ? input.name.trim().slice(0, 64) : displayName(),
          capabilities: textList(input.capabilities, 64, 32),
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
  function assertOwnerTransition(input, ev) {
    if (!ev || ev.kind !== 'task') return;
    const tasks = latestTasks(readEvents());
    const prev = tasks.get(ev.taskId);
    // buildEvent 会把缺失的 owner 补成空串，那样「没传 owner」就变成了「释放」。
    // 所以要看原始入参里到底有没有这个字段。
    const explicitOwner = input && typeof input === 'object' && 'owner' in input;
    const nextOwner = explicitOwner ? ev.owner : (prev ? prev.owner : '');
    const err = ownerTransitionError({
      nextOwner,
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
   *   - 任务要求的每个能力标签我都有
   *
   * 认失败的（conflict / blocked）也记进 `autoTried`，别每轮重试同一张卡刷日志。
   */
  const autoTried = new Set();

  function pickClaimable(events) {
    // 判据只有一份，在 selectable.mjs。这里只加「这轮已经试过就别再试」。
    const list = claimableOnly(events, {
      selfOrigin: identity.origin,
      capabilities: capabilityPayload().all,
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

        const list = pickClaimable(readEvents());
        if (list.length === 0) return;

        busy = true;
        for (const task of list) {
          try {
            await claimTask(task.taskId, {});
            autoTried.add(task.taskId);
            const note = buildEvent({
              kind: 'note',
              text: `自动认领：${task.taskId} ${task.title}`,
              level: 'info',
            });
            if (note) appendEvent(note);
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
        const rows = claimableTasks(readEvents(), {
          selfOrigin: identity.origin,
          capabilities: capabilityPayload().all,
        });
        for (const { task, ok } of rows) {
          if (!ok) continue;
          if (wakeNotified.get(task.taskId) === task.status) continue;
          wakeNotified.set(task.taskId, task.status);
          const ev = buildEvent({
            kind: 'note',
            text: `有活等人接：${task.taskId} ${task.title}`,
            level: 'info',
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
    const s = getSettings();
    let alive = true;
    const boot = async () => {
      try {
        if (s.role === 'hub') {
          await startHubRuntime({ port: s.hubPort, code: s.hubCode });
        } else if (s.role === 'member' && s.hubAddress) {
          await joinHubRemote(s.hubAddress, s.hubCode);
        }
      } catch (e) {
        hubRuntime.error = e instanceof Error ? e.message : String(e);
        hubRuntime.role = s.role;
        hubLog('warn', `启动接 Hub 失败：${hubRuntime.error}`);
      }
    };
    const timer = setTimeout(() => { if (alive) boot(); }, 800);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      alive = false;
      clearTimeout(timer);
      // 插件卸载：先断客户端再停服务，别让 client 对着已经关掉的服务重试
      if (hubRuntime.client) { try { hubRuntime.client.stop(); } catch { /* ignore */ } }
      if (hubRuntime.server) { try { hubRuntime.server.close(); } catch { /* ignore */ } }
      hubRuntime.client = null;
      hubRuntime.server = null;
    };
  });

  /* ───────────────────── 启动能力自检 ───────────────────── */

  ctx.effect(() => {
    if (!getSettings().capabilityDetect) return;
    const timer = setTimeout(() => {
      detectCapabilities().catch(() => { /* 探测失败 = 没有标签，不吵 */ });
    }, 400);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  });

  ctx.logger?.info?.(`协作看板已就绪：${LOG}`);
}
