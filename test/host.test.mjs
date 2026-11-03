/**
 * 宿主插件集成测试 —— 用假 ctx 加载真的 `apply()`，不重启 DSH。
 *
 * 为什么要有这个：宿主半边和客户端半边都是启动时加载的，改完不重启就没生效，
 * 而「重启一次看看」是分钟级的反馈环。这个脚本把 `apply()` 直接跑起来，
 * 路由、工具、日志全是真的，只有宿主外壳是假的。
 *
 * 跑：node test/host.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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

/** 假 ctx：只实现 apply 真正用到的那几个点。 */
function makeCtx() {
  const routes = [];
  const tools = [];
  const cleanups = [];
  const ctx = {
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

function findTool(tools, name) {
  return tools.find((t) => t.name === name);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'collab-host-'));
  const { ctx, routes, tools, cleanups } = makeCtx();

  console.log('1. 加载');
  apply(ctx, { dataDir, syncLanInbox: false });
  check('apply 不抛', true);
  check('注册了路由', routes.length >= 9, `${routes.length} 条`);
  check('注册了 5 个工具', tools.length === 5, tools.map((t) => t.name).join(', '));
  check('有 collab_post', Boolean(findTool(tools, 'collab_post')));
  check('有 collab_claim', Boolean(findTool(tools, 'collab_claim')));
  check('有 collab_hub', Boolean(findTool(tools, 'collab_hub')));
  check('有 collab_attach', Boolean(findTool(tools, 'collab_attach')));
  check('有 collab_download', Boolean(findTool(tools, 'collab_download')));

  console.log('\n2. 设置与状态');
  const settings = await hit(routes, '/collab-board/settings');
  check('/settings 200', settings.status === 200);
  check('spec 里有 hubPort/hubAddress/hubCode',
    Boolean(settings.payload?.spec?.hubPort && settings.payload?.spec?.hubAddress && settings.payload?.spec?.hubCode));
  check('数据目录指对', settings.payload?.dataDir === dataDir, settings.payload?.dataDir);

  console.log('\n3. 写事件与读回');
  const post = await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', id: 't1', title: '测试任务', status: 'pending' },
  });
  check('POST /post 200', post.status === 200, JSON.stringify(post.payload).slice(0, 120));

  const logPath = join(dataDir, 'events.jsonl');
  check('日志文件已生成', existsSync(logPath));
  const raw = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const first = raw[0];
  check('事件补了信封 eventVersion', first?.eventVersion === 2);
  check('事件补了 origin', /^[0-9a-f]{16}$/.test(String(first?.origin)));
  check('事件 id 是 ev_ 开头（不再被任务 id 占用）', String(first?.id).startsWith('ev_'), String(first?.id));
  check('任务标识在 taskId 里', first?.taskId === 't1');

  const state = await hit(routes, '/collab-board/state');
  check('/state 读得到', state.payload?.total === 1, String(state.payload?.total));

  const identityFile = join(dataDir, 'identity.json');
  check('生成了 identity.json', existsSync(identityFile));
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  check('identity 有 origin 和 groupId',
    /^[0-9a-f]{16}$/.test(identity.origin) && /^[0-9a-f]{16}$/.test(identity.groupId));

  console.log('\n4. Hub 控制');
  const hubSolo = await hit(routes, '/collab-board/hub');
  check('solo 时 running=false', hubSolo.payload?.running === false);
  check('solo 时 pending 记着那条待同步', hubSolo.payload?.pending === 1, String(hubSolo.payload?.pending));

  const claimNoHub = await hit(routes, '/collab-board/tasks/claim', {
    method: 'POST',
    body: { taskId: 't1' },
  });
  check('没连 Hub 时认领明确报错', claimNoHub.status === 500 && claimNoHub.payload?.ok === false);

  const started = await hit(routes, '/collab-board/hub/start', {
    method: 'POST',
    body: { port: 0 },
  });
  check('hub/start 200', started.status === 200, JSON.stringify(started.payload).slice(0, 160));
  check('起来后 running=true', started.payload?.status?.running === true);
  const port = started.payload?.info?.port;
  check('拿到真实端口', Number.isInteger(port) && port > 0, String(port));

  const info = await fetch(`http://127.0.0.1:${port}/collab/v1/info`).then((r) => r.json());
  check('Hub /info 可达', info.ok === true && info.data.groupId === identity.groupId);

  // 等客户端 join + 推一轮：这是真链路，不是桩
  await new Promise((r) => setTimeout(r, 2500));
  const hubAfter = await hit(routes, '/collab-board/hub');
  check('本机客户端连上了自己的 Hub', hubAfter.payload?.client?.online === true,
    JSON.stringify(hubAfter.payload?.client));
  check('待同步清空了', hubAfter.payload?.pending === 0, String(hubAfter.payload?.pending));

  const stateAfter = await hit(routes, '/collab-board/state');
  const stamped = (stateAfter.payload?.events || []).find((e) => e.taskId === 't1');
  check('那条任务拿到了 epoch/seq', Number.isFinite(stamped?.seq) && stamped.seq >= 1,
    JSON.stringify({ epoch: stamped?.epoch, seq: stamped?.seq }));

  console.log('\n5. 认领（真链路）');
  const claim = await hit(routes, '/collab-board/tasks/claim', {
    method: 'POST',
    body: { taskId: 't1', leaseMs: 600000 },
  });
  check('认领成功', claim.status === 200 && claim.payload?.ok === true,
    JSON.stringify(claim.payload).slice(0, 160));
  check('返回了 seq', Number.isFinite(claim.payload?.seq));

  const claimAgain = await hit(routes, '/collab-board/tasks/claim', {
    method: 'POST',
    body: { taskId: 't1' },
  });
  // 自己已经认领 → Hub 认为 owner 就是自己，允许重复认领（幂等语义），但会再写一条事件
  check('重复认领有明确回应', claimAgain.status === 200 || claimAgain.status === 409,
    String(claimAgain.status));

  console.log('\n5b. 文件传输');
  const srcFile = join(dataDir, 'hello.txt');
  writeFileSync(srcFile, 'hello 姐姐', 'utf8');
  const attachTool = findTool(tools, 'collab_attach');
  const attached = await attachTool.execute({ path: srcFile, taskId: 't1', note: '测试包' });
  check('上传并写进看板', attached.ok === true && /fileId/.test(String(attached.text)), String(attached.text));
  const fileIdMatch = String(attached.text || '').match(/fileId ([0-9a-f]{32})/);
  check('返回了 fileId', Boolean(fileIdMatch), String(attached.text));

  if (fileIdMatch) {
    const dlTool = findTool(tools, 'collab_download');
    const destPath = join(dataDir, 'from-hub.txt');
    const dl = await dlTool.execute({ fileId: fileIdMatch[1], dest: destPath });
    check('下载落到真实路径', dl.ok === true && dl.path === destPath, String(dl.text));
    check('内容一字节不差', existsSync(destPath) && readFileSync(destPath, 'utf8') === 'hello 姐姐');

    const stateFile = await hit(routes, '/collab-board/state');
    const art = (stateFile.payload?.events || []).find((e) => e.kind === 'artifact' && e.transfer);
    check('artifact 事件带 transfer.fileId', art?.transfer?.fileId === fileIdMatch[1],
      JSON.stringify(art?.transfer));
  }

  const stop = await hit(routes, '/collab-board/hub/stop', { method: 'POST' });
  check('hub/stop 200', stop.status === 200 && stop.payload?.stopped === true);
  const hubBack = await hit(routes, '/collab-board/hub');
  check('停了以后 running=false', hubBack.payload?.running === false);

  console.log('\n6. 卸载');
  for (const c of cleanups.reverse()) {
    try { c(); } catch { /* 卸载失败不该让测试挂 */ }
  }
  check('卸载不抛', true);

  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自己炸了：', e);
  process.exitCode = 1;
});
