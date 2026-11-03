/**
 * 协作看板 · 身份持久化
 *
 * 两个身份，别混：
 *   - `origin`  设备身份，生成一次**永不变**。两台机器同名时靠它区分（§5）。
 *   - `groupId` 组身份，跟着「这一家人」走。换人当 Hub 也**不重新生成**（P0-1e）。
 *
 * groupId 的四级恢复顺序（DESIGN §7.5 P0-1e）：
 *   1. `identity.json` 里的 groupId         —— 有就直接用，这是权威
 *   2. 原 Hub `/info` 返回的 groupId        —— 加入过就有，由调用方传入
 *   3. 本地事件日志最后一条 `hub` 事件      —— 可能过时，但比重新生成强
 *   4. 重新生成                             —— 前三级全空才走这步
 *
 * 为什么这么在意：groupId 换了，两台机器就等于换了个组，广播对不上、成员各连各的，
 * 而界面上看不出任何异常 —— 只会觉得「怎么又连不上了」。所以宁可写死在文件里。
 *
 * @module dsh-collab-board/host/identity
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** origin / groupId 都是 16 位小写十六进制（§3）。 */
const HEX16 = /^[0-9a-f]{16}$/;

/** 系统 origin：Hub 内部写作用的身份，不占成员位、无头像（§6.10）。 */
export const SYSTEM_ORIGIN = '0000000000000000';

export function isOrigin(v) {
  return typeof v === 'string' && HEX16.test(v);
}

export function isGroupId(v) {
  return typeof v === 'string' && HEX16.test(v);
}

/** 16 位小写十六进制。别用 uuid —— 这里是「稳定短 id」，不是 UUID 场景。 */
function randomHex16() {
  return randomBytes(8).toString('hex');
}

/**
 * 从事件日志里捞最后一个可用的 groupId。
 *
 * 只认 `hub` 事件（`kind === 'hub'`）里带 groupId 的；日志坏了就返回 ''，
 * 不抛 —— 身份恢复失败不该让整个插件起不来。
 */
function groupIdFromLog(logPath, readLog) {
  if (!logPath) return '';
  let events;
  try {
    events = typeof readLog === 'function' ? readLog() : [];
  } catch {
    return '';
  }
  if (!Array.isArray(events)) return '';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.kind === 'hub' && isGroupId(e.groupId)) return e.groupId;
  }
  return '';
}

/**
 * 读身份；没有就建。
 *
 * @param {object} opts
 * @param {string} opts.dir            数据目录（`~/.dsh/collab`）
 * @param {string} [opts.logPath]      事件日志路径，用于 groupId 第三级恢复
 * @param {() => any[]} [opts.readLog] 读日志的函数（避免和 index.mjs 循环依赖）
 * @param {string} [opts.hintGroupId]  原 Hub `/info` 给的 groupId（第二级，调用方传入）
 * @returns {{origin: string, groupId: string, groupIdSource: string, path: string, created: boolean}}
 */
export function loadIdentity(opts = {}) {
  const dir = String(opts.dir || '');
  const file = join(dir, 'identity.json');
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }

  const created = !raw;

  // origin：没有就生成，有就信文件（哪怕格式怪也不重生成 —— 换了 origin 等于换了个人）
  let origin = raw && typeof raw.origin === 'string' && isOrigin(raw.origin) ? raw.origin : '';
  if (origin === '') origin = randomHex16();

  // groupId 四级恢复
  let groupId = '';
  let groupIdSource = 'new';
  if (raw && isGroupId(raw.groupId)) {
    groupId = raw.groupId;
    groupIdSource = 'identity';
  } else if (isGroupId(opts.hintGroupId)) {
    groupId = String(opts.hintGroupId);
    groupIdSource = 'hub';
  } else {
    const fromLog = groupIdFromLog(opts.logPath, opts.readLog);
    if (fromLog) {
      groupId = fromLog;
      groupIdSource = 'log';
    } else {
      groupId = randomHex16();
      groupIdSource = 'new';
    }
  }

  const next = { origin, groupId };
  const changed =
    created ||
    !raw ||
    raw.origin !== origin ||
    raw.groupId !== groupId;

  if (changed) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      renameSync(tmp, file);
    } catch {
      /* 写不进去也别炸：内存里这份还能用，下次启动重新恢复 */
    }
  }

  return { origin, groupId, groupIdSource, path: file, created };
}

/**
 * 换 groupId（接入别人的组时才用）。
 * 单独一个函数，是为了让「什么时候该换」在调用点显式可见，不藏在 loadIdentity 里。
 */
export function adoptGroupId(dir, groupId) {
  if (!isGroupId(groupId)) throw new Error('groupId 要 16 位小写十六进制');
  const file = join(dir, 'identity.json');
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    raw = {};
  }
  const next = { ...raw, groupId };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return next;
}
