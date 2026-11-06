/**
 * 协作看板 · HTTP 小工具（宿主半边与 Hub 半边共用）
 *
 * 之前两半边各写了一份 `json` / `readBody` / `writeAtomic`，差异在悄悄长：
 * 超限时一个报「请求体过大」、一个报「请求体太大」；一个带 `httpStatus`/`code`、
 * 一个不带；一个漏了 `req.on('error')`。两份实现迟早会走偏，所以只留一份。
 *
 * **`ok` / `fail` 不在这里** —— 那是 Hub 自己的 wire 格式（`{ok, data}` /
 * `{ok, error}`），面板侧的响应是平铺的，不是同一件事。
 *
 * @module dsh-collab-board/host/http-util
 */
import { writeFileSync, renameSync } from 'node:fs';
import { MAX_BATCH_BYTES } from './events.mjs';

/** 默认请求体上限：整批事件的上限 + 256 KB 余量（信封和字段名）。 */
export const DEFAULT_BODY_LIMIT = MAX_BATCH_BYTES + 256 * 1024;

/**
 * 回一个 JSON 响应。
 *
 * `cache-control: no-store` 是必须的：面板每 3 秒拉一次，浏览器缓存一次
 * 就会让人对着旧数据改，改完还以为没生效。
 */
export function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * 把请求体读成对象。
 *
 * 失败时抛的对象带 `httpStatus` / `code`，Hub 那边直接透给客户端；
 * 面板侧只读 `.message`，两边用同一份不冲突。
 */
export function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体太大'), { httpStatus: 413, code: 'too-large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() === '' ? {} : JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { httpStatus: 400, code: 'bad-param' }));
      }
    });
    req.on('error', reject);
  });
}

/** 写文件用「临时 + rename」，崩溃时不留半截文件。 */
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}
