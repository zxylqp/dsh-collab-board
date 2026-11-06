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
 *   3. **读路径按字节偏移增量读**（0.11.2）。这条建立在上面两条上：只追加、不原地改，
 *      读指针才敢往前推。谁要是在这里引入原地改写（修历史、压缩行），**必须同时调
 *      `invalidate()`**，否则读到的还是旧内容 —— 缓存判断只认「变了多少字节」。
 *
 * @module dsh-collab-board/host/store
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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
  /**
   * 读缓存。`null` = 还没读过 / 被显式作废。
   *
   * 0.11.2 之前每次读都 `readFileSync` 整份日志，而 `appendEvent` 是
   * 「追加 → 作废 → 再全量读」——**每写一条进度就把整份日志重读一遍**。
   * 现在文件只往前长时只读新增那段（按字节偏移），变短才全量重来。
   *
   * `byId` 顺带解决 `appendEvent` 的同 id 去重（以前是 `all.some()`，同样 O(n)）。
   */
  let cache = null;
  /** 只给测试和诊断看：全量读几次、增量读几次、读了多少字节。 */
  const counters = { fullReads: 0, incrReads: 0, bytesRead: 0 };

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
    // 不用 invalidate：keptEvents() 每次现算拒绝集，缓存里的事件对象不动。
  }

  function persistSeqMap() {
    try { writeAtomic(seqFile, JSON.stringify(seqMap)); } catch { /* 丢了就重推，幂等 */ }
  }

  /** 缓存作废。外部改动日志（清空、重建）之后必须调。 */
  function invalidate() {
    cache = null;
  }

  function emptyCache() {
    return { readAt: -1, mtime: -1, events: [], tail: '', byId: new Map() };
  }

  /** 只读 [from, to) 这一段字节，不碰文件其它部分。 */
  function readRange(from, to) {
    const len = Math.max(0, to - from);
    if (len <= 0) return '';
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      return buf.subarray(0, got).toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 拆行解析，返回**没写完的那半行**。
   *
   * 半行不能当场解析、更不能丢：留在 `cache.tail` 里等下次新数据拼上。
   * 不这么做的话，一次读到半截 JSON 就永久少一条事件（并发写撕裂、别人正在追加）。
   */
  function absorb(text, into, byId) {
    if (text === '') return '';
    const lines = text.split('\n');
    const last = lines.pop();
    const take = (raw) => {
      const line = raw.trim();
      if (line === '') return false;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e !== 'object') return false;
        into.push(e);
        if (typeof e.id === 'string' && e.id !== '') byId.set(e.id, e);
        return true;
      } catch { return false; }
    };
    for (const raw of lines) take(raw);
    /**
     * 文件末尾没有换行时，最后一段先试着当完整事件收下。
     *
     * 两个场景要分开：
     *   - 别人正在写（半行）：解析失败 → 留给下次拼，**不能丢**
     *   - 文件本来就缺结尾换行（手工编辑 / 外部工具写出来的）：解析成功 → 收下，
     *     不然它永远卡在 tail 里，那条事件永久不出现（比旧的全量读还差）
     */
    if (last !== '' && take(last)) return '';
    return last;
  }

  /** 把 sidecar 里的 (epoch, seq) 补到还没有戳的事件上。 */
  function applyStamps(list) {
    for (const e of list) {
      const stamp = e && e.id ? seqMap[e.id] : null;
      if (stamp && Array.isArray(stamp) && !hasSyncStamp(e)) {
        e.epoch = stamp[0];
        e.seq = stamp[1];
      }
    }
  }

  /** 被 Hub 拒掉的不进视图：文件里保留原文（事实源不改），看板/待同步/折叠都不该再看它。 */
  function keptEvents() {
    if (!cache) return [];
    return cache.events.filter((e) => !(e && e.id && rejectedIds.has(e.id)));
  }

  /**
   * 读事件。
   *
   * 三条路径：
   *   1. 文件没变（size + mtime 都对得上）→ 直接用缓存
   *   2. 只变长了 → 只读新增的字节
   *   3. 变短了（裁剪 / 清空 / 被替换）或没有缓存 → 全量重读
   */
  function readEvents() {
    if (!existsSync(logPath)) {
      cache = emptyCache();
      return [];
    }
    let st;
    try { st = statSync(logPath); } catch { return keptEvents(); }

    if (cache && st.size === cache.readAt && st.mtimeMs === cache.mtime) return keptEvents();
    if (!cache) cache = emptyCache();

    if (cache.readAt >= 0 && st.size > cache.readAt) {
      const text = readRange(cache.readAt, st.size);
      counters.incrReads += 1;
      counters.bytesRead += st.size - cache.readAt;
      cache.tail = absorb(cache.tail + text, cache.events, cache.byId);
      cache.readAt = st.size;
      cache.mtime = st.mtimeMs;
    } else {
      let text = '';
      try { text = readFileSync(logPath, 'utf8'); } catch { return keptEvents(); }
      counters.fullReads += 1;
      counters.bytesRead += Buffer.byteLength(text, 'utf8');
      cache = emptyCache();
      cache.tail = absorb(text, cache.events, cache.byId);
      cache.readAt = st.size;
      cache.mtime = st.mtimeMs;
    }
    applyStamps(cache.events);
    return keptEvents();
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
    readEvents(); // 保证 cache 建好（顺带补戳）
    if (ev && ev.id && cache && cache.byId.has(ev.id)) return ev;

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

    const line = JSON.stringify(stamped) + '\n';
    appendFileSync(logPath, line, 'utf8');
    /**
     * 追加后**不重读**：这条就是我们刚写的，直接并进缓存并把读指针推过去。
     * 以前这里 invalidate + readEvents，等于每写一条就把整份日志读一遍。
     */
    if (cache) {
      cache.events.push(stamped);
      if (typeof stamped.id === 'string' && stamped.id !== '') cache.byId.set(stamped.id, stamped);
      // 用文件真实长度对齐读指针，别拿 -1（「还没读过」）去加字节数 —— 那样会永久错位 1 字节
      try {
        const st = statSync(logPath);
        cache.readAt = st.size;
        cache.mtime = st.mtimeMs;
      } catch { /* 拿不到就让下次自己发现 */ }
    }

    /**
     * 裁剪：**超过上限 + 余量**才做一次，一次裁回上限。
     *
     * 以前是「只要超过上限 1 条就全量重写」—— 到了上限之后，每写一条进度都要把
     * 整份日志重写一遍（`maxEvents` 默认 5000，约 3~4 MB），而且裁剪窗口里断电
     * 还多一次风险。按 `limit × 0.15`（至少 50 条）的余量摊薄，触发频率降到 1/50 左右。
     */
    const limit = Math.max(1, maxEventsOf());
    const slack = Math.max(50, Math.ceil(limit * 0.15));
    if (cache && cache.events.length > limit + slack) {
      const kept = cache.events.slice(-limit);
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
        /**
         * 缓存里那条要是已经在，就地把戳补上。
         *
         * 以前这里 `invalidate()` 整份重读：推送一轮就把日志全量读一遍，
         * 刚做的增量读白干。对象是同一个引用，补完面板立刻能看到。
         */
        const hit = cache && cache.byId.get(row.id);
        if (hit && !hasSyncStamp(hit)) {
          hit.epoch = row.epoch;
          hit.seq = row.seq;
        }
      }
    }
    if (dirty) {
      persistSeqMap();
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

  /** 读路径计数（测试 / 诊断用）——「增量读」到底有没有生效看这里。 */
  function stats() {
    return { ...counters, cached: cache ? cache.events.length : 0, tail: cache ? cache.tail.length : 0 };
  }

  return {
    readEvents, appendEvent, pendingEvents, persistSeqMap, invalidate,
    markSynced, markRejected, maxSynced, stats,
  };
}
