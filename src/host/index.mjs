/**
 * 协作看板 · 宿主半边
 *
 * 三件事：
 *   1. 守着 `events.jsonl`（唯一事实源，只追加）
 *   2. 每 2 秒把 dsh-lan-share 收到的消息搬进来 —— **没人调 inbox 也看得见**
 *   3. 给面板和 agent 各开一条写入口（HTTP 路由 + collab_post 工具）
 *
 * 为什么要有这个插件：之前是几个散装脚本 + 一个自己起的 7788 端口，
 * 会话一关全停。长出插件的意义是——**DSH 活着它就活着**。
 *
 * @module dsh-collab-board
 */
import {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { loadIdentity } from './identity.mjs';
import { createHubClient } from './hub-client.mjs';
import { startHub } from './hub.mjs';
import { compareEvents, dedupeById, hasSyncStamp, makeEventId, stampLocal } from './events.mjs';

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

function jsonReply(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 把请求体读成对象，限制大小，坏 JSON 直接拒。 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((ok, no) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        no(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        ok(text.trim() === '' ? {} : JSON.parse(text));
      } catch {
        no(new Error('不是合法 JSON'));
      }
    });
    req.on('error', no);
  });
}

export function apply(ctx, rawConfig = {}) {
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const home = (process.env['DSH_HOME'] || '').trim() || join(homedir(), '.dsh');
  const custom = typeof cfg.dataDir === 'string' ? cfg.dataDir.trim() : '';
  const dataDir = custom === '' ? join(home, 'collab') : resolve(custom);
  const LOG = join(dataDir, 'events.jsonl');
  const SEEN_FILE = join(dataDir, '.inbox-synced.json');
  const LAN_STATE = join(home, 'lan-share', 'state.json');

  const syncLanInbox = cfg.syncLanInbox !== false;
  const intervalMs = Number.isFinite(Number(cfg.syncIntervalMs))
    ? Math.max(500, Number(cfg.syncIntervalMs))
    : 2000;
  const maxEvents = Number.isFinite(Number(cfg.maxEvents))
    ? Math.max(100, Number(cfg.maxEvents))
    : 5000;

  mkdirSync(dataDir, { recursive: true });

  /* ───────────────────── 设置（settings.json） ───────────────────── */

  const SETTINGS_FILE = join(dataDir, 'settings.json');

  /**
   * 面板能改的设置项。
   *
   * 规矩（UI-BRIEF §3.3）：**只有这一版真能生效的才进来**。
   * Hub 那一组（地址 / 端口 / 口令）宿主侧已经真生效了 —— 起 Hub、加入、重连都读它；
   * 界面输入框下一轮接，所以这一轮它们只能通过 PATCH /settings 或 cordis config 改。
   *
   * 为什么存这儿而不写回 cordis.patch.yml：改 config 要重启 DSH，
   * 调个轮询间隔不该把整个应用重启一遍。
   */
  const SETTINGS_SPEC = {
    selfName: { kind: 'string', max: 64, def: '' },
    role: { kind: 'enum', values: ['solo', 'hub', 'member'], def: 'solo' },
    pollIntervalMs: { kind: 'int', min: 1000, max: 60000, def: 3000 },
    showSystemEvents: { kind: 'bool', def: true },
    showArtifacts: { kind: 'bool', def: true },
    autoScroll: { kind: 'bool', def: true },
    timeFormat: { kind: 'enum', values: ['clock', 'relative'], def: 'clock' },
    maxReplay: { kind: 'int', min: 50, max: 5000, def: 500 },
    capabilityDetect: { kind: 'bool', def: true },
    capabilitiesExtra: { kind: 'string', max: 2000, def: '' },
    maxEvents: { kind: 'int', min: 100, max: 200000, def: maxEvents },
    hubAddress: { kind: 'string', max: 200, def: '' },
    hubPort: { kind: 'int', min: 1, max: 65535, def: 48910 },
    hubCode: { kind: 'string', max: 64, def: '' },
    pendingWatch: { kind: 'bool', def: false },
    pendingWatchMs: { kind: 'int', min: 60000, max: 3600000, def: 300000 },
  };
  const SETTINGS_KEYS = Object.keys(SETTINGS_SPEC);

  function settingsDefaults() {
    const out = {};
    for (const k of SETTINGS_KEYS) out[k] = SETTINGS_SPEC[k].def;
    return out;
  }

  /** 校验单个设置值。坏值返回 ok:false + 人话，绝不悄悄写进去。 */
  function coerceSetting(key, raw) {
    const spec = SETTINGS_SPEC[key];
    if (!spec) return { ok: false, reason: '不认识的设置项' };
    if (spec.kind === 'bool') {
      if (typeof raw !== 'boolean') return { ok: false, reason: '要 true / false' };
      return { ok: true, value: raw };
    }
    if (spec.kind === 'enum') {
      if (typeof raw !== 'string' || !spec.values.includes(raw)) {
        return { ok: false, reason: `只能是 ${spec.values.join(' / ')}` };
      }
      return { ok: true, value: raw };
    }
    if (spec.kind === 'int') {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: '要是整数' };
      if (n < spec.min || n > spec.max) return { ok: false, reason: `范围 ${spec.min}～${spec.max}` };
      return { ok: true, value: n };
    }
    if (typeof raw !== 'string') return { ok: false, reason: '要字符串' };
    const text = raw.trim();
    if (text.length > spec.max) return { ok: false, reason: `最长 ${spec.max} 字符` };
    return { ok: true, value: text };
  }

  function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  }

  let settingsCache = { mtime: -1, size: -1, data: null };

  function getSettings() {
    let st;
    try { st = statSync(SETTINGS_FILE); } catch { return settingsDefaults(); }
    if (settingsCache.data && st.mtimeMs === settingsCache.mtime && st.size === settingsCache.size) {
      return settingsCache.data;
    }
    let raw = {};
    try { raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { raw = {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const out = settingsDefaults();
    for (const k of SETTINGS_KEYS) {
      if (!(k in raw)) continue;
      const r = coerceSetting(k, raw[k]);
      if (r.ok) out[k] = r.value;
    }
    settingsCache = { mtime: st.mtimeMs, size: st.size, data: out };
    return out;
  }

  function patchSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('patch 要是个对象');
    }
    const next = { ...getSettings() };
    const ignored = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!SETTINGS_SPEC[k]) { ignored.push(k); continue; }
      const r = coerceSetting(k, v);
      if (!r.ok) throw new Error(`${k}：${r.reason}`);
      next[k] = r.value;
    }
    writeAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n');
    settingsCache = { mtime: -1, size: -1, data: null };
    return { settings: getSettings(), ignored };
  }

  /* ───────────────────── 能力自检（§6.8） ───────────────────── */

  const CAP_FILE = join(dataDir, 'capabilities.json');
  /** 内置探测表：只写标签，绝不写绝对路径。`node` 故意不探 —— 插件自己就是 node。 */
  const PROBE_BINS = [
    ['ffmpeg', 'ffmpeg'],
    ['python', 'python'],
    ['soffice', 'soffice'],
    ['gpu', 'nvidia-smi'],
  ];
  const CHROME_PATHS = [
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  let capRuntime = { status: 'idle', detected: [], at: null };

  function whichBin(bin) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((ok) => {
      execFile(finder, [bin], { timeout: 2500, windowsHide: true }, (err) => ok(!err));
    });
  }

  async function detectCapabilities() {
    capRuntime = { ...capRuntime, status: 'running' };
    const found = new Set();
    await Promise.all(
      PROBE_BINS.map(async ([tag, bin]) => {
        try {
          if (await whichBin(bin)) found.add(tag);
        } catch { /* 探测失败 = 没有 */ }
      }),
    );
    for (const p of CHROME_PATHS) {
      try { if (existsSync(p)) { found.add('chrome'); break; } } catch { /* ignore */ }
    }
    const detected = [...found].sort();
    capRuntime = { status: 'done', detected, at: localIso() };
    try { writeAtomic(CAP_FILE, JSON.stringify({ detected, at: capRuntime.at }) + '\n'); } catch { /* 下次再说 */ }
    return capRuntime;
  }

  function manualCapabilities() {
    return (getSettings().capabilitiesExtra || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function capabilityPayload() {
    const manual = manualCapabilities();
    const all = [...new Set([...capRuntime.detected, ...manual])].sort();
    return { ok: true, status: capRuntime.status, detected: capRuntime.detected, manual, all, at: capRuntime.at };
  }

  /* ───────────────────── 日志 ───────────────────── */

  let cache = { mtime: -1, size: -1, events: [] };

  /* ───────────────────── 身份与 Hub ───────────────────── */

  /**
   * 身份：`origin` 生成一次永不变；`groupId` 走四级恢复（identity.json → Hub /info →
   * 本地 hub 事件 → 新生成）。groupId 换了等于换了个组，界面上看不出来，只会「又连不上」。
   */
  const identity = loadIdentity({ dir: dataDir, logPath: LOG, readLog: () => readEvents() });

  /**
   * 推送成功后的 `(epoch, seq)` 回写表。
   *
   * 为什么不直接改 events.jsonl：那是只追加的事实源，回写就得重写整个文件，
   * 断电那一刻整个日志都可能碎。用一个 sidecar 记 `id → [epoch, seq]`，
   * 读的时候补上，代价是偶尔丢一条映射（重推一遍，幂等兜住）。
   */
  const SEQ_FILE = join(dataDir, '.synced.json');
  let seqMap = {};
  try {
    const raw = JSON.parse(readFileSync(SEQ_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) seqMap = raw;
  } catch { seqMap = {}; }

  function persistSeqMap() {
    try { writeAtomic(SEQ_FILE, JSON.stringify(seqMap)); } catch { /* 丢了就重推，幂等 */ }
  }

  /** Hub 运行态。`role` 跟着 settings 走，但真正起没起看 server/client。 */
  const hubRuntime = { role: 'solo', server: null, client: null, error: '', startedAt: '' };


  /** 读全量事件。坏行（并发写撕裂、半行）跳过，绝不让一行坏 JSON 弄死面板。 */
  function readEvents() {
    if (!existsSync(LOG)) return [];
    let st;
    try { st = statSync(LOG); } catch { return []; }
    if (st.mtimeMs === cache.mtime && st.size === cache.size) return cache.events;
    let text = '';
    try { text = readFileSync(LOG, 'utf8'); } catch { return cache.events; }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t === '') continue;
      try {
        const e = JSON.parse(t);
        if (e && typeof e === 'object') out.push(e);
      } catch { /* 半行，跳过 */ }
    }
    for (const e of out) {
      // 推给 Hub 成功后拿到的 (epoch, seq) 存在 sidecar 里，读的时候补上
      const stamp = e && e.id && seqMap[e.id];
      if (stamp && Array.isArray(stamp) && !hasSyncStamp(e)) {
        e.epoch = stamp[0];
        e.seq = stamp[1];
      }
    }
    cache = { mtime: st.mtimeMs, size: st.size, events: out };
    return out;
  }

  /**
   * 追加一条事件。
   *
   * 三件事：
   *   1. 补信封（eventVersion / id / origin / name / ts）—— **本地写的时候不补，
   *      推给 Hub 时校验器一定会拒**（origin 缺失）
   *   2. 同 id 只留第一条（§6.5）：重投、拉回来又写一遍都不该翻倍
   *   3. 超过上限按行裁最老的
   *
   * 注意 `task` 事件的 `id`：信封的 id 是 `ev_...`，任务标识只看 `taskId`。
   * 老数据（0.1.0）反过来把任务 id 放在 `id` 里，面板那边已经兼容，这里不迁就。
   */
  function appendEvent(ev, opts = {}) {
    const all = readEvents();
    if (ev && ev.id && all.some((e) => e.id === ev.id)) return ev;

    let stamped = ev;
    if (!opts.raw) {
      const hasEventId = typeof ev.id === 'string' && ev.id.startsWith('ev_');
      stamped = {
        eventVersion: 2,
        origin: identity.origin,
        name: getSettings().selfName || '',
        ...ev,
        id: hasEventId ? ev.id : makeEventId(identity.origin),
      };
      if (!stamped.ts) stamped.ts = localIso();
    }

    appendFileSync(LOG, JSON.stringify(stamped) + '\n', 'utf8');
    cache = { mtime: -1, size: -1, events: [] };
    const after = readEvents();
    const limit = getSettings().maxEvents;
    if (after.length > limit) {
      const kept = after.slice(-limit);
      writeFileSync(LOG, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      cache = { mtime: -1, size: -1, events: [] };
    }
    return stamped;
  }

  /** 本机还没拿到序号的事件（要推给 Hub）。 */
  function pendingEvents() {
    return readEvents().filter((e) => e && e.id && !hasSyncStamp(e) && e.origin === identity.origin);
  }

  /* ─────────────── lan-share 收件 → 日志 ─────────────── */

  let seen = [];
  try { seen = JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch { seen = []; }
  if (!Array.isArray(seen)) seen = [];
  let lastLanSize = -1;

  function syncInbox() {
    if (!syncLanInbox || !existsSync(LAN_STATE)) return;
    let raw;
    try { raw = readFileSync(LAN_STATE, 'utf8'); } catch { return; }
    if (raw.length === lastLanSize) return;
    lastLanSize = raw.length;

    let st;
    try { st = JSON.parse(raw); } catch { return; }
    const inbox = Array.isArray(st?.inbox) ? st.inbox : [];
    const fresh = [];
    for (const e of inbox) {
      if (!e || typeof e.id !== 'string' || seen.includes(e.id)) continue;
      const ts = e.receivedAt ? localIso(new Date(e.receivedAt)) : localIso();
      if (e.kind === 'text' || typeof e.text === 'string') {
        fresh.push({ ts, kind: 'msg', from: e.peerName || '对方', text: String(e.text || ''), via: 'lan-share' });
      } else {
        fresh.push({ ts, kind: 'artifact', path: e.name || '(文件)', note: `来自 ${e.peerName || '对方'} 的文件` });
      }
      seen.push(e.id);
    }
    if (fresh.length === 0) return;
    for (const ev of fresh) appendEvent(ev);
    try { writeFileSync(SEEN_FILE, JSON.stringify(seen.slice(-800)), 'utf8'); } catch { /* 下次再写 */ }
  }

  /* ───────────────────── Hub 生命周期 ───────────────────── */

  const hubLog = (level, msg) => {
    if (level === 'warn') ctx.logger?.warn?.(`[collab-hub] ${msg}`);
    else ctx.logger?.info?.(`[collab-hub] ${msg}`);
  };

  const displayName = () => getSettings().selfName || hostname();

  /** 推送成功：把 Hub 分的 `(epoch, seq)` 记进 sidecar，读取时补上。 */
  function onPushed(accepted) {
    let dirty = false;
    for (const row of Array.isArray(accepted) ? accepted : []) {
      if (!row || !row.id || row.duplicate) continue;
      if (Number.isFinite(row.epoch) && Number.isFinite(row.seq)) {
        seqMap[row.id] = [row.epoch, row.seq];
        dirty = true;
      }
    }
    if (dirty) {
      persistSeqMap();
      cache = { mtime: -1, size: -1, events: [] };
    }
  }

  /** 拉回来的事件：别家写的落本机日志；自己写的只补序号，不重复写。 */
  function onPulled(events) {
    let dirty = false;
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || !ev.id) continue;
      if (Number.isFinite(ev.epoch) && Number.isFinite(ev.seq) && !seqMap[ev.id]) {
        seqMap[ev.id] = [ev.epoch, ev.seq];
        dirty = true;
      }
      if (ev.origin !== identity.origin) {
        appendEvent(ev, { raw: true });
      }
    }
    if (dirty) persistSeqMap();
    cache = { mtime: -1, size: -1, events: [] };
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
              appendEvent(ev);
              return jsonReply(res, 200, { ok: true, event: ev });
            } catch (err) {
              return jsonReply(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
              writeFileSync(LOG, '', 'utf8');
              writeFileSync(SEEN_FILE, '[]', 'utf8');
              seen = [];
              lastLanSize = -1;
              cache = { mtime: -1, size: -1, events: [] };
              return jsonReply(res, 200, { ok: true });
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

        const tasks = new Map();
        for (const ev of readEvents()) {
          if (!ev || ev.kind !== 'task' || !ev.taskId) continue;
          const prev = tasks.get(ev.taskId);
          if (!prev || compareEvents(ev, prev) > 0) tasks.set(ev.taskId, ev);
        }

        const mine = new Set(capabilityPayload().all.map((c) => String(c).toLowerCase()));
        for (const task of tasks.values()) {
          if (task.status !== 'pending' || task.owner) continue;
          if (task.archived) continue;
          const depsOk = (Array.isArray(task.dependsOn) ? task.dependsOn : []).every((d) => {
            const dep = tasks.get(d);
            return dep && (dep.status === 'done' || dep.status === 'cancelled');
          });
          if (!depsOk) continue;
          const capsOk = (Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [])
            .every((c) => mine.has(String(c).toLowerCase()));
          if (!capsOk) continue;
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

  /* ───────────────────── 启动收件同步 ───────────────────── */

  ctx.effect(() => {
    syncInbox();
    const timer = setInterval(() => {
      try { syncInbox(); } catch { /* 单次失败不拖垮循环 */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
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
