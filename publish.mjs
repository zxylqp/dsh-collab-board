#!/usr/bin/env node
/**
 * 一次发布：版本对齐 → 测试 → 同步安装位 → 推 GitHub。
 *
 * 为什么要有这个脚本：版本号以前写在四个地方（package.json / 客户端 VERSION 常量 /
 * CHANGELOG 标题 / GitHub 仓库），改一处忘三处。于是出现「磁盘 0.10.15、宿主 0.10.14、
 * GitHub 0.10.12」这种三张皮。这里把「真源」定成 package.json 的 version，
 * 其余全部由它对齐；推送走 Git Data API，不依赖本地 git 历史，也不再依赖那个
 * 经常没开的 127.0.0.1:7897 代理（api.github.com 在 no_proxy 里，直连可用）。
 *
 * 用法：
 *   node publish.mjs            # 检查 + 测试 + 同步 + 推送
 *   node publish.mjs --check    # 只检查版本一致性
 *   node publish.mjs --dry      # 检查 + 测试 + 同步，不推送
 *   node publish.mjs --skip-tests
 */
import { readFileSync, writeFileSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OWNER = 'zxylqp';
const REPO = 'dsh-collab-board';
const BRANCH = 'main';
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const INSTALL = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-collab-board');
const CONFIG = join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const DRY = argv.has('--dry') || CHECK_ONLY;
const SKIP_TESTS = argv.has('--skip-tests');

const say = (s) => console.log(s);
const die = (s) => { console.error(`\n[x] ${s}`); process.exit(1); };

/* ── 1. 版本对齐 ── */

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
say(`\n真源版本：${version}（package.json）`);

const clientPath = join(ROOT, 'src', 'client', 'index.js');
const clientSrc = readFileSync(clientPath, 'utf8');
const m = clientSrc.match(/const VERSION = '([^']+)'/);
if (!m) die('客户端找不到 VERSION 常量');
if (m[1] !== version) {
  say(`  · 客户端 VERSION 是 ${m[1]}，按真源改成 ${version}`);
  writeFileSync(clientPath, clientSrc.replace(m[0], `const VERSION = '${version}'`), 'utf8');
} else {
  say('  · 客户端 VERSION 一致');
}

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const top = changelog.match(/^## (\d+\.\d+\.\d+)/m);
if (!top) die('CHANGELOG 找不到版本标题');
if (top[1] !== version) die(`CHANGELOG 顶部是 ${top[1]}，package.json 是 ${version} —— 先在 CHANGELOG 补这一版`);
say('  · CHANGELOG 顶部一致');

if (CHECK_ONLY) { say('\n检查通过。'); process.exit(0); }

/* ── 2. 测试 ── */

// 客户端没有测试，至少先保证它语法是通的（VERSION 常量就在这个文件里）
try {
  execFileSync(process.execPath, ['--check', join(ROOT, 'src', 'client', 'index.js')], { stdio: 'pipe' });
  say('  · 客户端语法检查通过');
} catch (e) {
  die(`客户端语法错误：\n${e.stderr || e.message}`);
}

if (!SKIP_TESTS) {
  for (const [name, file] of [['hub', 'test/hub.test.mjs'], ['host', 'test/host.test.mjs'], ['two-machine', 'test/two-machine.test.mjs']]) {
    let out;
    try {
      out = execFileSync(process.execPath, [join(ROOT, file)], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      die(`${name} 测试失败：\n${(e.stdout || '') + (e.stderr || '')}`);
    }
    const line = out.trim().split('\n').filter((l) => l.includes('结果：')).pop() || '';
    const failed = Number((line.match(/(\d+)\s*失败/) || [])[1]);
    if (!line || failed !== 0) die(`${name} 测试不是全绿：${line || '没有结果行'}`);
    say(`  · ${name} 测试 ${line.replace(/\s*结果：/, '').trim()}`);
  }
}

/* ── 3. 同步安装位 ── */

/**
 * 装了 DSH 的机器上，宿主进程正占着 `src/` 里的文件，`cpSync` 会报
 * `EPIPE / EBUSY`（Windows 文件锁）。以前一崩就整轮退出 —— 测试跑完了、
 * 却连推送都没做到（2026-11-08 实跑踩到，0.11.28 因此没推上去）。
 *
 * 所以改成逐个复制、失败只记一条警告：**同步不上最多是宿主还跑旧代码**，
 * 不该拦住发版本身。
 */
const syncIssues = [];
const tryCopy = (from, to, label) => {
  try {
    cpSync(from, to, { recursive: true });
  } catch (e) {
    syncIssues.push(`${label}（${e.code || e.message}）`);
  }
};
if (!existsSync(INSTALL)) die(`安装位不存在：${INSTALL}`);
tryCopy(join(ROOT, 'src'), join(INSTALL, 'src'), 'src/');
tryCopy(join(ROOT, 'test'), join(INSTALL, 'test'), 'test/');
for (const f of ['package.json', 'CHANGELOG.md', 'README.md', 'cordis.patch.yml', 'publish.mjs']) {
  tryCopy(join(ROOT, f), join(INSTALL, f), f);
}
if (syncIssues.length) {
  say(`  ! 有 ${syncIssues.length} 处没同步上：`);
  for (const s of syncIssues) say(`    - ${s}`);
  say('  ! 宿主重启后再跑一次；安装位落后只会让宿主继续跑旧代码，不影响这次推送');
} else {
  say(`  · 已同步到 ${INSTALL}`);
}
say('  ! 宿主进程要重启才加载新代码；/collab-board/version 会报它实际加载的版本');

if (DRY) { say('\n--dry：不推送。'); process.exit(0); }

/* ── 4. 推 GitHub（Git Data API） ── */

const token = (() => {
  const m2 = readFileSync(CONFIG, 'utf8').match(/github_pat_[A-Za-z0-9_]+/);
  return m2 && m2[0];
})();
if (!token) die(`没在 ${CONFIG} 里找到 github_pat_ token`);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-collab-board-publisher',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// 只在 base_tree 上覆盖文本文件；png 没变就让它继承（省请求也省流量）
const FILES = [
  '.gitignore', 'CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
  'publish.mjs', 'release.mjs',
  'src/client/index.js',
  'src/host/delivery.mjs', 'src/host/discovery.mjs',
  'src/host/events.mjs', 'src/host/http-util.mjs', 'src/host/hub-client.mjs',
  'src/host/hub.mjs', 'src/host/identity.mjs', 'src/host/index.mjs',
  'src/host/ratelimit.mjs',
  'src/host/selectable.mjs', 'src/host/settings.mjs', 'src/host/store.mjs', 'src/host/wake.mjs',
  'test/host.test.mjs', 'test/hub.test.mjs', 'test/two-machine.test.mjs',
].filter((f) => existsSync(join(ROOT, f)));
if (FILES.length === 0) die('没有可推送的文件');

/**
 * 本地已删、远端还留着的文件。
 *
 * Git Data API 的 `base_tree` 是**叠加**语义：不在这次 tree 列表里的文件原样继承。
 * 于是「本地删了」在 GitHub 上什么都不会发生 —— 0.11.1 删 capabilities.mjs 时才踩到。
 * 必须显式给一条 `sha: null` 才算删除，否则 clone 下来永远有个死文件。
 */
const DELETED = ['src/host/capabilities.mjs'];

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const baseSha = ref.object.sha;
const baseCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
say(`\n远端 HEAD：${baseSha.slice(0, 8)} ${String(baseCommit.message).split('\n')[0]}`);

const tree = [];
for (const rel of FILES) {
  const abs = join(ROOT, rel);
  const buf = readFileSync(abs);
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: { content: buf.toString('base64'), encoding: 'base64' },
  });
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  say(`  · ${rel}（${statSync(abs).size} B）`);
}
// 本地已删的文件：显式置 null 才真的从远端树里拿掉。
// **只删远端确实还在的**：对一个不存在的路径给 `sha: null`，GitHub 会回
// 422 GitRPC::BadObjectState —— 0.11.2 推的时候就这么炸过一次（0.11.1 已经删掉了）。
const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${baseCommit.tree.sha}?recursive=1`);
const remotePaths = new Set((remoteTree.tree || []).map((e) => e.path));
for (const rel of DELETED) {
  if (existsSync(join(ROOT, rel))) continue;
  if (!remotePaths.has(rel)) continue;
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });
  say(`  · 删除 ${rel}`);
}

const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: { base_tree: baseCommit.tree.sha, tree },
});

/**
 * 提交标题从 **这一版** 的正文里取第一句粗体。
 *
 * 以前是全文件找第一个 `## x.y.z` + 粗体 —— 只要新版本的正文不是粗体开头，
 * 就会抓到上一个版本的标题（0.11.2 那条写成了「删掉能力标签」，是 0.11.1 的）。
 * 现在先按 `## ${version}` 切出本段，再取段内第一处粗体。
 */
const headline = (() => {
  const after = changelog.split(`## ${version}`)[1] || '';
  const section = after.split(/\n## /)[0];
  return (section.match(/\*\*(.+?)\*\*/) || [])[1] || '';
})();
const commitMsg = `${version}：${headline}\n\n由 publish.mjs 打包推送（测试全绿后自动生成）。`;
const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: { message: commitMsg, tree: newTree.sha, parents: [baseSha] },
});
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: { sha: newCommit.sha, force: false },
});

/* ── 5. 校验 ── */

const remotePkg = await api(`/repos/${OWNER}/${REPO}/contents/package.json?ref=${BRANCH}`);
const remoteVersion = JSON.parse(Buffer.from(remotePkg.content, 'base64').toString('utf8')).version;
say(`\n推送成功：${newCommit.sha.slice(0, 8)}  ${commitMsg.split('\n')[0]}`);
if (remoteVersion !== version) die(`推完校验失败：GitHub 上是 ${remoteVersion}，本地是 ${version}`);
say(`校验通过：GitHub package.json = ${remoteVersion}`);
say(`https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);

/* ── 6. tag 与 GitHub Release ── */

/**
 * 以前这个脚本只推代码，tag 和 Release 全靠手动 —— 于是「版本页停在旧版」反复发生：
 * 0.11.6 一次（README 里记着），0.11.27 和 0.11.28 又各一次，都是事后手动补的。
 * 教训写在文档里没用，写进脚本才管用。
 *
 * 三件事按顺序做：tag 存在没 → 不存在就在新 commit 上建；Release 存在没 →
 * 不存在就建、存在且正文不同就 PATCH、一致就跳过（重跑发布不该刷空改动）。
 */
const tagName = `v${version}`;
let tagExists = false;
try {
  await api(`/repos/${OWNER}/${REPO}/git/ref/tags/${tagName}`);
  tagExists = true;
} catch { /* 404 = 还没有 */ }
if (!tagExists) {
  await api(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/tags/${tagName}`, sha: newCommit.sha },
  });
  say(`  · tag ${tagName} 已创建 → ${newCommit.sha.slice(0, 8)}`);
} else {
  say(`  · tag ${tagName} 已存在`);
}

/**
 * Release 正文 = CHANGELOG 里这一版的正文（去掉 `## x.y.z` 行和尾部的 `---`）。
 * 标题 = `vX.Y.Z：` + 段内第一句粗体，和以前手动建的格式保持一致。
 */
const releaseBody = (changelog.split(`## ${version}`)[1] || '').split(/\n---\n/)[0].trim();
const releaseName = `${tagName}：${headline}`;
let existingRelease = null;
try {
  existingRelease = await api(`/repos/${OWNER}/${REPO}/releases/tags/${tagName}`);
} catch { /* 404 = 还没建 */ }
if (!existingRelease) {
  const created = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: {
      tag_name: tagName,
      name: releaseName,
      body: releaseBody,
      draft: false,
      prerelease: false,
    },
  });
  say(`  · Release ${tagName} 已创建：${created.html_url}`);
} else if ((existingRelease.body || '').trim() !== releaseBody) {
  const updated = await api(`/repos/${OWNER}/${REPO}/releases/${existingRelease.id}`, {
    method: 'PATCH',
    body: { name: releaseName, body: releaseBody },
  });
  say(`  · Release ${tagName} 正文已更新：${updated.html_url}`);
} else {
  say(`  · Release ${tagName} 已是最新`);
}

/**
 * 本地 git 对齐远端。
 *
 * API 推送只写 GitHub、不产生本地 commit —— 以前推完本地 HEAD 还停在旧版本，
 * 下次 `git push` 看到「本地落后 + 远端有新提交」，不是假冲突就是分叉
 * （2026-11-07 推 0.11.7 时就这样：远端 27 个 commit、本地 1 个，行尾还混着）。
 * 发布完把本地拉到远端，之后它就是干净的工作副本。
 */
try {
  execFileSync('git', ['fetch', 'origin', BRANCH], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  execFileSync('git', ['reset', '--hard', `origin/${BRANCH}`], { cwd: ROOT, stdio: 'pipe' });
  say(`  · 本地 git 已对齐远端 ${BRANCH}`);
} catch (e) {
  say(`  ! 本地 git 对齐失败（不影响远端已推的内容）：${e.message}`);
}
