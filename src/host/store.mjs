/**
 * 协作看板 · 本地事件库（events.jsonl + .synced.json）
 *
 * 这里是**唯一**碰本地日志的地方。之前 readEvents / appendEvent / pendingEvents
 * 都挤在 index.mjs 里，面板轮询、自动认领、待办提醒、推送各自调一遍，
 * 缓存失效点散在四个地方（漏一个就「改了不生效」）。
 *
 * 两条硬约定：
 *   1. `events.jsonl` 只追加，**永不原地改**。回写会把整份日志变成断电即碎的半截文件。
 *   2. 同步状态（Hub 分的 epoch/seq）记在 sidecar `.synced.json` 里，
 *      读的时候补上；丢一条映射的代价是重推一遍，幂等兜住。
 *
 * @module dsh-collab-board/host/store
 */
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { hasSyncStamp, makeEventId } from './events.mjs';
import { writeAtomic } from './http-util.mjs';

/**
 * @param {object} opts
 * @param {string}   opts.logPath     events.jsonl 绝对路径
 * @param {string}   opts.seqFile     .synced.json 绝对路径
 * @param {()=>string} opts.origin    本机 origin（**getter**：identity 后建，避免循环依赖）
 * @param {()=>string} opts.nameOf    显示名（写完信封用）
 * @param {()=>number} opts.maxEventsOf 日志上限
 * @param {()=>string} opts.localIso  时间戳格式
 */
export function createStore({ logPath, seqFile, rejectedFile, origin, nameOf, maxEventsOf, localIso }) {
  let cache = { mtime: -1, size: -1, events: [] };

  /** id → [epoch, seq]。推给 Hub 成功后回写，读日志时补上。 */
  let seqMap = {};
  try {
    const raw = JSON.parse(readFileSync(seqFile, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) seqMap = raw;
  } catch { seqMap = {}; }

  /**
   * 被 Hub 明确拒绝过、不再重推的事件 id。
   *
   * 之前只放在客户端内存里：重启一轮就忘，那条脏事件会再被重推一次、
   * 再被拒一次、再落一条 warn note —— 而且它还会一直算在「待同步」里，
   * 面板上永远挂着一个灰点。落到磁盘，一次拒绝管到底。
   */
  let rejectedIds = new Set();
  try {
    const raw = rejectedFile ? JSON.parse(readFileSync(rejectedFile, 'utf8')) : [];
    if (Array.isArray(raw)) rejectedIds = new Set(raw.filter((x) => typeof x === 'string' && x));
  } catch { rejectedIds = new Set(); }

  function persistRejected() {
    if (!rejectedFile) return;
    try { writeAtomic(rejectedFile, JSON.stringify([...rejectedIds])); } catch { /* 丢了下次重推，幂等 */ }
  }

  /** 标记一条事件「Hub 不认」，从看板/待同步里摘掉（文件里仍保留原文）。 */
  function markRejected(id) {
    if (typeof id !== 'string' || id === '' || rejectedIds.has(id)) return;
    rejectedIds.add(id);
    persistRejected();
    invalidate();
  }

  function persistSeqMap() {
    try { writeAtomic(seqFile, JSON.stringify(seqMap)); } catch { /* 丢了就重推，幂等 */ }
  }

  /** 缓存作废。外部改动日志（清空、重建）之后必须调。 */
  function invalidate() {
    cache = { mtime: -1, size: -1, events: [] };
  }

  /** 读全量事件。坏行（并发写撕裂、半行）跳过，绝不让一行坏 JSON 弄死面板。 */
  function readEvents() {
    if (!existsSync(logPath)) return [];
    let st;
    try { st = statSync(logPath); } catch { return []; }
    if (st.mtimeMs === cache.mtime && st.size === cache.size) return cache.events;
    let text = '';
    try { text = readFileSync(logPath, 'utf8'); } catch { return cache.events; }
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
    // 被 Hub 拒掉的不进视图：文件里保留原文（事实源不改），但看板/待同步/折叠都不该再看它
    const kept = out.filter((e) => !(e && e.id && rejectedIds.has(e.id)));
    cache = { mtime: st.mtimeMs, size: st.size, events: kept };
    return kept;
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
        origin: origin(),
        name: nameOf() || '',
        ...ev,
        id: hasEventId ? ev.id : makeEventId(origin()),
      };
      if (!stamped.ts) stamped.ts = localIso();
    }

    appendFileSync(logPath, JSON.stringify(stamped) + '\n', 'utf8');
    invalidate();
    const after = readEvents();
    const limit = maxEventsOf();
    if (after.length > limit) {
      const kept = after.slice(-limit);
      /**
       * 裁剪用**原子写**（tmp + rename）。
       *
       * 这个文件头写着「只追加、永不原地改」，而裁剪正是唯一一次全量重写 ——
       * 以前这里是裸 `writeFileSync`，断电落在写一半的窗口里就是半截文件：
       * 丢的不只是被裁掉的老事件，而是整份日志。旁边 sidecar 早就用 writeAtomic 了。
       */
      writeAtomic(logPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
      invalidate();
    }
    return stamped;
  }

  /** 本机还没拿到序号的事件（要推给 Hub）。 */
  function pendingEvents() {
    return readEvents().filter((e) => e && e.id && !hasSyncStamp(e) && e.origin === origin());
  }

  /**
   * 推送成功：把 Hub 分的 `(epoch, seq)` 记进 sidecar。
   * 调用方给的是 `/events` 的 `accepted` 数组。
   */
  function markSynced(accepted) {
    let dirty = false;
    for (const row of Array.isArray(accepted) ? accepted : []) {
      /**
       * `duplicate` 也要记，别跳过。
       *
       * Hub 回 `{id, duplicate:true}` 的意思是「这条我早收过了」—— 本来就是同步成功，
       * 只是不重复编号。以前跳过它，结果这条在本地 sidecar 里永远没有 stamp，
       * `pendingEvents()` 一直把它当待同步，面板永久显示「待同步」（R10 真机实测）。
       * 0.10.8 起 Hub 在 duplicate 里一并回 epoch/seq，这里就能正常记上。
       */
      if (!row || !row.id) continue;
      if (Number.isFinite(row.epoch) && Number.isFinite(row.seq)) {
        seqMap[row.id] = [row.epoch, row.seq];
        dirty = true;
      }
    }
    if (dirty) {
      persistSeqMap();
      invalidate();
    }
  }

  /**
   * sidecar 里记过的最高 (epoch, seq)。
   *
   * 「本机已见」不能只从 `events.jsonl` 算：日志按 `maxEvents` 裁过，最老的行没了，
   * 算出来的最大值会比真实的小。真机就这么中过 —— 日志被截断、最大值只到 seq 122，
   * 重新连上 Hub 补回 123～282 时全被判成新消息，连着三轮「补叫」全是历史重放。
   *
   * sidecar 只增不减（按事件 id 记），不受裁剪影响。
   */
  function maxSynced() {
    let epoch = 0;
    let seq = 0;
    for (const pair of Object.values(seqMap)) {
      if (!Array.isArray(pair)) continue;
      const e = Number(pair[0]);
      const s = Number(pair[1]);
      if (!Number.isFinite(e) || e <= 0) continue;
      if (!Number.isFinite(s) || s <= 0) continue;
      if (e > epoch || (e === epoch && s > seq)) { epoch = e; seq = s; }
    }
    return { epoch, seq };
  }

  return { readEvents, appendEvent, pendingEvents, persistSeqMap, invalidate, markSynced, markRejected, maxSynced };
}
