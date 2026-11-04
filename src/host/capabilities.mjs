/**
 * 协作看板 · 能力自检（§6.8）
 *
 * 只产出**标签**（ffmpeg / python / soffice / gpu / chrome / 手填的），
 * 绝不产出绝对路径 —— 标签会广播给全组，路径是本机隐私。
 *
 * `node` 故意不探：插件自己就跑在 node 上，探出来等于永远有。
 *
 * @module dsh-collab-board/host/capabilities
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { writeAtomic } from './http-util.mjs';

/** 内置探测表：标签 → 二进制名。 */
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

function whichBin(bin) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((ok) => {
    execFile(finder, [bin], { timeout: 2500, windowsHide: true }, (err) => ok(!err));
  });
}

/**
 * @param {object} opts
 * @param {string}   opts.dataDir     数据目录（capabilities.json 落在这儿）
 * @param {()=>any}  opts.getSettings 读设置（拿手填的 capabilitiesExtra）
 * @param {()=>string} [opts.localIso] 时间戳格式（宿主侧带 +08:00 偏移）
 */
export function createCapabilities({ dataDir, getSettings, localIso = () => new Date().toISOString() }) {
  const CAP_FILE = join(dataDir, 'capabilities.json');

  let capRuntime = { status: 'idle', detected: [], at: null };

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

  return { CAP_FILE, detectCapabilities, manualCapabilities, capabilityPayload };
}
