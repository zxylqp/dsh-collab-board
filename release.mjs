#!/usr/bin/env node
/**
 * 把 CHANGELOG 里**当前版本**（取 package.json 的 version）那一段发成 GitHub Release。
 *
 * 为什么单独一个脚本：0.11.x 有六个版本只推了代码、没发 Release，版本页停在 v0.11.5，
 * 装机的人看不出这一版改了什么。发版流程里 release 不是可选项。
 *
 * 用法：
 *   node release.mjs           # 建 tag + Release（已有就更新，重跑安全）
 *   node release.mjs --dry     # 只打印标题和正文，不调 API
 *
 * token 从 profiles/desktop/cordis.patch.yml 取（和 publish.mjs 同一处）。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CONFIG = join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const OWNER = 'zxylqp';
const REPO = 'dsh-collab-board';
const DRY = process.argv.includes('--dry');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const m = changelog.match(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\n([\\s\\S]*?)\\n---`, 'm'));
if (!m) {
  console.error(`[x] CHANGELOG 里找不到 ## ${version} 段 —— 先在 CHANGELOG 补这一版`);
  process.exit(1);
}
const body = m[1].trim();
const name = `v${version}：${(body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '')
  .replace(/\*\*/g, '').trim().slice(0, 80)}`;

if (DRY) {
  console.log(`[dry] tag=${tag}`);
  console.log(`[dry] 标题：${name}`);
  console.log(`[dry] 正文 ${body.length} 字`);
  process.exit(0);
}

const token = (() => {
  const t = readFileSync(CONFIG, 'utf8').match(/github_pat_[A-Za-z0-9_]+/);
  return t && t[0];
})();
if (!token) {
  console.error(`[x] ${CONFIG} 里没有 github_pat_ token`);
  process.exit(1);
}

async function api(path, { method = 'GET', payload } = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-collab-board-release',
      'content-type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// 已存在就更新，不重复建（重跑安全）
let existing = null;
try {
  existing = await api(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
} catch (e) {
  if (!String(e.message).includes('404')) throw e;
}

const payload = { tag_name: tag, name, body, draft: false, prerelease: false };
const out = existing
  ? await api(`/repos/${OWNER}/${REPO}/releases/${existing.id}`, { method: 'PATCH', payload })
  : await api(`/repos/${OWNER}/${REPO}/releases`, { method: 'POST', payload });

console.log(`${existing ? '已更新' : '已创建'} release ${out.tag_name}`);
console.log('标题：', out.name);
console.log('页面：', out.html_url);
console.log('目标：', out.target_commitish, '｜草稿：', out.draft);
console.log('正文长度：', String(out.body || '').length, '字');
