/**
 * 协作看板 · 设置（settings.json）
 *
 * 规矩（UI-BRIEF §3.3）：**只有真能生效的才进 SETTINGS_SPEC**。
 * 加一项之前先问：改了它，下一轮真的会不一样吗？不能生效的开关不该出现在面板上。
 *
 * 为什么存 json 而不写回 cordis.patch.yml：改 config 要重启 DSH，
 * 调个轮询间隔不该把整个应用重启一遍。
 *
 * @module dsh-collab-board/host/settings
 */
import { statSync, readFileSync } from 'node:fs';
import { writeAtomic } from './http-util.mjs';

export function settingsSpec(maxEventsDefault = 5000) {
  return {
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
    maxEvents: { kind: 'int', min: 100, max: 200000, def: maxEventsDefault },
    hubAddress: { kind: 'string', max: 200, def: '' },
    hubPort: { kind: 'int', min: 1, max: 65535, def: 48910 },
    /**
     * UDP 自动发现端口。默认 48911。
     *
     * 以前这个只能改代码 —— `createDiscovery` 支持传，但面板这边没接出来，
     * 48911 被别的程序占了就等于「发现功能静默失效」。和 TCP 端口一样给个入口。
     */
    discoveryPort: { kind: 'int', min: 1024, max: 65535, def: 48911 },
    /**
     * 已结束的卡保留多少天（墓碑自动清，0 = 永不自动清）。默认 30。
     *
     * 删除不是物理删行 —— 事件流只追加，删行会让两台机器对不上账。
     * 所以「清掉」= 写一条墓碑，正文擦空，只留 id + 删除时间 + 谁删的。
     */
    retentionDays: { kind: 'int', min: 0, max: 3650, def: 30 },
    /** 面板要不要显示墓碑（已删除的卡）。默认关：删了就是删了。 */
    showDeleted: { kind: 'bool', def: false },
    hubCode: { kind: 'string', max: 64, def: '' },
    pendingWatch: { kind: 'bool', def: false },
    pendingWatchMs: { kind: 'int', min: 60000, max: 3600000, def: 300000 },
    /**
     * 自动认领：启动后扫「该我接的活」直接认领。
     * 默认**开**——这是使用方明确要的行为（电脑一启动就把活接下来）。
     * 只在连上 Hub 时生效；单机模式没有认领通道。
     */
    autoClaim: { kind: 'bool', def: true },
    autoClaimMs: { kind: 'int', min: 1000, max: 3600000, def: 60000 },
    /**
     * 本地隐藏的成员（逗号分隔的 origin）。
     * **只影响这台机器的视图**，不改事件流、不影响别人 —— 所以能安全地「删人」。
     */
    hiddenMembers: { kind: 'string', max: 4000, def: '' },
    /**
     * 有新消息时自动唤醒本机 agent（调 `sessionController.prompt`）。
     *
     * **默认关**：它会在对话里插一条真消息，而且会等 agent 跑完一整轮才返回。
     * 要开的时候自己开 —— 别默认就把人的会话点着。
     */
    wakeOnMessage: { kind: 'bool', def: false },
    wakeCooldownMs: { kind: 'int', min: 60000, max: 3600000, def: 300000 },
    /**
     * 一次唤醒最多投几次（含第一次）。
     *
     * 唤醒失败以前没有第二次：宿主没会话、会话忙、进程刚好在重启，都只落一条日志。
     * 现在失败会留在投递账本里重试，次数由这里定。设 1 = 不重试，行为和旧版一致。
     */
    wakeRetries: { kind: 'int', min: 1, max: 10, def: 3 },
    /**
     * 任务没完成就自己再叫一次。
     *
     * 唤醒原本只有「别人发了消息」这一个来源：谁最后一条不回，链就断在那儿。
     * 打开后，一轮投递结束时如果那张卡还是 running，插件自己排下一条唤醒，
     * 到冷却结束再叫自己接着干。**默认关**：这是会让 agent 自己转起来的开关，
     * 不点着就不转 —— 每转一轮都是一整轮 token。
     */
    wakeSelfContinue: { kind: 'bool', def: false },
    /** 同一张卡最多连续续跑几次。到了就写一条 warn note 停下，不无限刷。 */
    wakeSelfContinueMax: { kind: 'int', min: 1, max: 50, def: 8 },
  };
}

/**
 * 建一个设置读写器。
 *
 * @param {object} opts
 * @param {string} opts.file            settings.json 的绝对路径
 * @param {number} [opts.maxEventsDefault] `maxEvents` 的默认值（来自 cordis config）
 * @returns {{SETTINGS_SPEC: object, SETTINGS_KEYS: string[], settingsDefaults: Function,
 *            coerceSetting: Function, getSettings: Function, patchSettings: Function}}
 */
export function createSettings({ file, maxEventsDefault = 5000 }) {
  const SETTINGS_SPEC = settingsSpec(maxEventsDefault);
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

  let settingsCache = { mtime: -1, size: -1, data: null };

  function getSettings() {
    let st;
    try { st = statSync(file); } catch { return settingsDefaults(); }
    if (settingsCache.data && st.mtimeMs === settingsCache.mtime && st.size === settingsCache.size) {
      return settingsCache.data;
    }
    let raw = {};
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = {}; }
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
    writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
    settingsCache = { mtime: -1, size: -1, data: null };
    return { settings: getSettings(), ignored };
  }

  return { SETTINGS_SPEC, SETTINGS_KEYS, settingsDefaults, coerceSetting, getSettings, patchSettings };
}
