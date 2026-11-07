/**
 * 双机场景端到端测试 —— 同一进程里跑**两个完整的插件实例**。
 *
 * 为什么这么做：真拿两台电脑测一轮要改 IP、开防火墙、来回切换窗口，
 * 反馈环是分钟级；而两台机器的差异只在于 dataDir、origin、端口，
 * 这些在这个脚本里都是真的 —— 两个 `apply()`、两份 events.jsonl、
 * 真 HTTP 的 join / 心跳 / 推拉，只有宿主外壳是假的。
 *
 * 覆盖用户给的测试清单：
 *   第二步  连接 + 口令（错码被拒 / 对码通过 / 没地方输口令的洞）
 *   3.1     任务卡双向同步
 *   3.2     串行认领（只能一个成功，另一个明确 conflict）
 *   4       文件传输 + sha256 校验 + 内容寻址去重
 *   第五步  依赖闭环（未满足不可认领 → 完成后可认领）
 *   第六步  口令错误 / 断线期间新事件重连补齐
 *
 * 不覆盖：3.3 租约到期自动释放（默认 10 分钟、30 秒扫一次，等不起；
 * 单测 test/hub.test.mjs 的 5e/11 用 leaseTickMs=50 真验过）。
 *
 * 跑：node test/two-machine.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/host/index.mjs';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假宿主：只实现 apply 真正用到的那几个点。和 host.test.mjs 同一套。 */
function makeCtx() {
  const routes = [];
  const tools = [];
  const cleanups = [];
  const ctx = {
    get: () => undefined,
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
    inject(_names, cb) { cb(ctx); },
    logger: { info() {}, warn() {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, routes, tools, cleanups };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { res.headers[k] = v; },
    end(s) { res.body = typeof s === 'string' ? s : String(s ?? ''); },
  };
  return res;
}

function makeReq(method, url, body) {
  const listeners = {};
  const req = {
    method,
    url,
    headers: {},
    on(ev, fn) { listeners[ev] = fn; return req; },
  };
  setImmediate(() => {
    if (body !== undefined) {
      try { listeners.data?.(Buffer.from(JSON.stringify(body))); } catch { /* ignore */ }
    }
    listeners.end?.();
  });
  return req;
}

async function hit(routes, path, { method = 'GET', body } = {}) {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error(`没有注册路由 ${path}`);
  const res = makeRes();
  await route.handler(makeReq(method, path, body), res);
  let payload = null;
  try { payload = JSON.parse(res.body); } catch { payload = res.body; }
  return { status: res.statusCode, payload };
}

function tool(tools, name) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`没有工具 ${name}`);
  return t;
}

/** 轮询等条件成立（默认 12 秒）。 */
async function until(fn, label = '', ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}

async function eventsOf(routes) {
  const st = await hit(routes, '/collab-board/state');
  return { events: Array.isArray(st.payload?.events) ? st.payload.events : [], raw: st.payload };
}

async function main() {
  const dirA = mkdtempSync(join(tmpdir(), 'collab-甲-'));
  const dirB = mkdtempSync(join(tmpdir(), 'collab-乙-'));
  const A = makeCtx();
  const B = makeCtx();
  apply(A.ctx, { dataDir: dirA, syncLanInbox: false });
  apply(B.ctx, { dataDir: dirB, syncLanInbox: false });
  // 自动认领会把「该我接的活」直接抢走，干扰串行认领的断言
  await hit(A.routes, '/collab-board/settings', { method: 'PATCH', body: { autoClaim: false } });
  await hit(B.routes, '/collab-board/settings', { method: 'PATCH', body: { autoClaim: false } });

  console.log('第二步：建 Hub–成员连接（口令）');
  const started = await hit(A.routes, '/collab-board/hub/start', { method: 'POST', body: { port: 0 } });
  const port = started.payload?.info?.port;
  const hubUrl = `http://127.0.0.1:${port}`;
  check('甲机起来当 Hub', started.status === 200 && Number.isInteger(port), JSON.stringify(started.payload).slice(0, 160));

  // 先设口令再让乙加入 —— 这一步以前是空的：面板没有口令输入框
  const setCode = await hit(A.routes, '/collab-board/settings', { method: 'PATCH', body: { hubCode: 'NT2026' } });
  check('甲机设了口令且当场推给运行中的 Hub', setCode.payload?.hubCode?.applied === true,
    JSON.stringify(setCode.payload?.hubCode));

  const joinNoCode = await hit(B.routes, '/collab-board/hub/join', {
    method: 'POST', body: { address: hubUrl },
  });
  check('乙机不填口令 → 明确报「口令不对」，不假装连上',
    joinNoCode.status === 400 && /口令不对/.test(String(joinNoCode.payload?.error)),
    JSON.stringify(joinNoCode.payload).slice(0, 200));
  const bBad = await hit(B.routes, '/collab-board/hub');
  check('失败后乙机不是「已连接」状态', bBad.payload?.client?.online !== true && bBad.payload?.role !== 'member',
    JSON.stringify({ role: bBad.payload?.role, online: bBad.payload?.client?.online }));

  const joinOk = await hit(B.routes, '/collab-board/hub/join', {
    method: 'POST', body: { address: hubUrl, code: 'NT2026' },
  });
  check('乙机填对口令 → 加入成功', joinOk.status === 200 && joinOk.payload?.ok === true,
    JSON.stringify(joinOk.payload).slice(0, 200));

  const aMembers = await hit(A.routes, '/collab-board/members');
  const bMembers = await hit(B.routes, '/collab-board/members');
  const bOrigin = bMembers.payload?.members?.find((m) => m.self)?.origin
    || (await hit(B.routes, '/collab-board/hub')).payload?.origin;
  check('乙机看得到甲机（成员列表里有别人）',
    (bMembers.payload?.members || []).some((m) => !m.self), JSON.stringify(bMembers.payload).slice(0, 200));
  check('甲机看得到乙机在线', (aMembers.payload?.members || []).some((m) => m.origin === bOrigin && m.online),
    JSON.stringify(aMembers.payload).slice(0, 200));

  console.log('\n3.1 任务卡双向同步');
  await tool(A.tools, 'collab_post').execute({
    kind: 'task', id: 't-a', title: '甲机建的卡', status: 'pending', priority: 'normal',
  });
  await tool(B.tools, 'collab_post').execute({
    kind: 'task', id: 't-b', title: '乙机建的卡', status: 'pending', priority: 'normal',
  });
  const bSeesA = await until(async () => (await eventsOf(B.routes)).events.some((e) => e.taskId === 't-a' && e.kind === 'task'),
    '乙看不到甲的卡');
  check('甲机建卡 → 乙机几秒内看到', bSeesA);
  const aSeesB = await until(async () => (await eventsOf(A.routes)).events.some((e) => e.taskId === 't-b' && e.kind === 'task'),
    '甲看不到乙的卡');
  check('乙机建卡 → 甲机也看到', aSeesB);

  console.log('\n3.2 串行认领（同时点同一张卡）');
  const [ca, cb] = await Promise.all([
    hit(A.routes, '/collab-board/tasks/claim', { method: 'POST', body: { taskId: 't-a' } }),
    hit(B.routes, '/collab-board/tasks/claim', { method: 'POST', body: { taskId: 't-a' } }),
  ]);
  const wins = [ca, cb].filter((r) => r.status === 200 && r.payload?.ok === true);
  const loses = [ca, cb].filter((r) => !(r.status === 200 && r.payload?.ok === true));
  check('只有一个成功', wins.length === 1,
    JSON.stringify({ a: ca.status, b: cb.status, aerr: ca.payload?.error, berr: cb.payload?.error }).slice(0, 300));
  check('另一个明确说 conflict / 被人先认领',
    loses.length === 1 && /conflict|被人|先认领/.test(JSON.stringify(loses[0].payload) + loses[0].payload?.error || ''),
    JSON.stringify(loses[0]?.payload).slice(0, 200));

  // 谁赢了谁往下走（文件传输要求 owner 是自己）
  const winnerIsA = ca.status === 200 && ca.payload?.ok === true;
  const win = winnerIsA ? A : B;
  const lose = winnerIsA ? B : A;
  const winDir = winnerIsA ? dirA : dirB;
  const loseDir = winnerIsA ? dirB : dirA;

  console.log('\n第四步：文件传输（sha256 内容寻址）');
  const src = join(winDir, 'payload.txt');
  const payload = Buffer.from('两台机器之间的第一份文件。' + Date.now(), 'utf8');
  writeFileSync(src, payload);
  const wantSha = createHash('sha256').update(payload).digest('hex');
  const attach = await tool(win.tools, 'collab_attach').execute({ path: src, taskId: 't-a', note: '双机测试包' });
  check('上传成功并写了 artifact 事件', attach.ok === true && /[0-9a-f]{32}/.test(attach.text), String(attach.text).slice(0, 160));
  const fileId = String(attach.text || '').match(/([0-9a-f]{32})/)?.[1];

  if (fileId) {
    const dest = join(loseDir, 'got.txt');
    const dl = await tool(lose.tools, 'collab_download').execute({ fileId, dest });
    const gotSha = createHash('sha256').update(readFileSync(dest)).digest('hex');
    check('另一台能下载且落地', dl.ok === true && dl.path === dest);
    check('sha256 一字节不差', gotSha === wantSha, `${wantSha.slice(0, 12)} vs ${gotSha.slice(0, 12)}`);

    // 去重：同一份内容再传一次，Hub 文件库里还是一份
    const again = await tool(lose.tools, 'collab_attach').execute({ path: dest, note: '同一份再传一次' });
    check('同一内容再传一次也成功', again.ok === true, String(again.text).slice(0, 120));
    const filesDir = join(dirA, 'hub-files');
    const n = readdirSync(filesDir).filter((f) => !f.startsWith('.')).length;
    check('Hub 文件库按 sha256 只存一份', n === 1, `${n} 个文件：${readdirSync(filesDir).join(', ')}`);
  }

  console.log('\n第五步：依赖闭环（自动解锁）');
  await tool(A.tools, 'collab_post').execute({
    kind: 'task', id: 't-dep-a', title: '前置卡', status: 'pending', priority: 'normal',
  });
  await tool(A.tools, 'collab_post').execute({
    kind: 'task', id: 't-dep-b', title: '后置卡', status: 'pending', priority: 'normal', dependsOn: ['t-dep-a'],
  });
  // 建卡只是写本机日志，要等一轮推送到 Hub；不然乙去认领会拿到「没有这条任务」
  await until(async () => (await eventsOf(B.routes)).events.some((e) => e.taskId === 't-dep-a' && e.kind === 'task'),
    '依赖卡没同步过去', 10000);
  const blocked = await hit(B.routes, '/collab-board/tasks/claim', { method: 'POST', body: { taskId: 't-dep-b' } });
  check('依赖没完成 → 认领被 blocked（不是静默失败）',
    blocked.status !== 200 && /blocked|依赖/.test(JSON.stringify(blocked.payload)), JSON.stringify(blocked.payload).slice(0, 200));

  const claimA = await hit(B.routes, '/collab-board/tasks/claim', { method: 'POST', body: { taskId: 't-dep-a', leaseMs: 0 } });
  check('乙机认领前置卡', claimA.status === 200 && claimA.payload?.ok === true, JSON.stringify(claimA.payload).slice(0, 160));
  // 完成靠一条 task 事件（owner 是乙自己），Hub 会自动把下游从 blocked 放回 pending
  await tool(B.tools, 'collab_post').execute({
    kind: 'task', id: 't-dep-a', title: '前置卡', status: 'done', owner: bOrigin,
  });
  // 等 done **真推上 Hub**（本机写进日志不等于 Hub 收到了；要等一轮推送）
  await until(async () => (await eventsOf(A.routes)).events
    .some((e) => e.taskId === 't-dep-a' && e.kind === 'task' && e.status === 'done'), 'done 没推上 Hub', 12000);
  const unlockedClaim = await hit(B.routes, '/collab-board/tasks/claim', {
    method: 'POST', body: { taskId: 't-dep-b', leaseMs: 0 },
  });
  if (!(unlockedClaim.status === 200 && unlockedClaim.payload?.ok === true)) {
    // 诊断：Hub 眼里这张卡到底是什么状态、有没有被拒的 note
    const hubView = await eventsOf(A.routes);
    const t = hubView.events.filter((e) => e.taskId === 't-dep-a' && e.kind === 'task');
    console.log('    [诊断] Hub 侧 t-dep-a 事件：', JSON.stringify(t.map((e) => ({ s: e.status, o: e.owner, seq: e.seq }))).slice(0, 300));
    console.log('    [诊断] 乙 origin：', bOrigin, ' 乙 pending：', (await hit(B.routes, '/collab-board/hub')).payload?.pending);
    console.log('    [诊断] Hub warn：', JSON.stringify(hubView.events.filter((e) => e.kind === 'note' && e.level === 'warn').map((e) => e.text)).slice(0, 400));
  }
  check('前置完成 → 后置卡自动可认领',
    unlockedClaim.status === 200 && unlockedClaim.payload?.ok === true,
    JSON.stringify(unlockedClaim.payload).slice(0, 200));

  console.log('\n第六步：断线期间的新事件，重连补齐');
  await hit(B.routes, '/collab-board/hub/leave', { method: 'POST' });
  const bLeft = await hit(B.routes, '/collab-board/hub');
  check('乙机断开成功', bLeft.payload?.client == null, JSON.stringify(bLeft.payload?.client));
  await tool(A.tools, 'collab_post').execute({
    kind: 'task', id: 't-offline', title: '乙断线期间甲建的卡', status: 'pending', priority: 'normal',
  });
  await sleep(1500);
  const bOffline = await eventsOf(B.routes);
  check('断开期间确实没收到（前提成立）', !bOffline.events.some((e) => e.taskId === 't-offline'));
  await hit(B.routes, '/collab-board/hub/join', { method: 'POST', body: { address: hubUrl, code: 'NT2026' } });
  const caughtUp = await until(async () => (await eventsOf(B.routes)).events.some((e) => e.taskId === 't-offline'),
    '重连后没补齐', 12000);
  check('重连后把断开期间的卡补回来', caughtUp);

  console.log('\n收尾');
  for (const c of [...A.cleanups, ...B.cleanups].reverse()) {
    try { c(); } catch { /* 卸载失败不该让测试挂 */ }
  }
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
  // apply 里还有定时器；显式退出，别让脚本挂住
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 300);
}

main().catch((e) => {
  console.error('测试自己炸了：', e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 300);
});
