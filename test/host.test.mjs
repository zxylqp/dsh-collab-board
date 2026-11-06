/**
 * 宿主插件集成测试 —— 用假 ctx 加载真的 `apply()`，不重启 DSH。
 *
 * 为什么要有这个：宿主半边和客户端半边都是启动时加载的，改完不重启就没生效，
 * 而「重启一次看看」是分钟级的反馈环。这个脚本把 `apply()` 直接跑起来，
 * 路由、工具、日志全是真的，只有宿主外壳是假的。
 *
 * 跑：node test/host.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/host/index.mjs';
import { createDelivery } from '../src/host/delivery.mjs';
import { shouldWake, maxSeenOf, newerSeen } from '../src/host/wake.mjs';
import { createStore } from '../src/host/store.mjs';
import { claimableTasks, earliestByTask, latestTasks } from '../src/host/selectable.mjs';

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
function makeCtx(services = {}) {
  const routes = [];
  const tools = [];
  const cleanups = [];
  const ctx = {
    /**
     * 假宿主服务表。默认空 —— 唤醒会走「宿主没有 sessionController.prompt」，
     * 这正是 9 节要验的失败路径。9c 在**运行时**往里塞 sessionController，
     * 才能验成功路径（信号要真传给 prompt）。
     */
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined;
    },
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
  const services = {};
  const { ctx, routes, tools, cleanups } = makeCtx(services);

  console.log('1. 加载');
  apply(ctx, { dataDir, syncLanInbox: false });
  check('apply 不抛', true);
  check('注册了路由', routes.length >= 9, `${routes.length} 条`);
  check('注册了 6 个工具', tools.length === 6, tools.map((t) => t.name).join(', '));
  check('有 collab_post', Boolean(findTool(tools, 'collab_post')));
  check('有 collab_claim', Boolean(findTool(tools, 'collab_claim')));
  check('有 collab_hub', Boolean(findTool(tools, 'collab_hub')));
  check('有 collab_attach', Boolean(findTool(tools, 'collab_attach')));
  check('有 collab_download', Boolean(findTool(tools, 'collab_download')));
  check('有 collab_state', Boolean(findTool(tools, 'collab_state')));

  console.log('\n2. 设置与状态');
  const settings = await hit(routes, '/collab-board/settings');
  check('/settings 200', settings.status === 200);
  check('spec 里有 hubPort/hubAddress/hubCode',
    Boolean(settings.payload?.spec?.hubPort && settings.payload?.spec?.hubAddress && settings.payload?.spec?.hubCode));
  check('spec 里有 discoveryPort（0.10.13：UDP 端口可配）',
    settings.payload?.spec?.discoveryPort?.def === 48911
      && settings.payload?.spec?.discoveryPort?.min === 1024);
  check('数据目录指对', settings.payload?.dataDir === dataDir, settings.payload?.dataDir);

  const badDisc = await hit(routes, '/collab-board/settings', {
    method: 'PATCH',
    body: { discoveryPort: 80 },
  });
  check('发现端口低于 1024 → 400', badDisc.status === 400);
  const goodDisc = await hit(routes, '/collab-board/settings', {
    method: 'PATCH',
    body: { discoveryPort: 49911 },
  });
  check('发现端口能改并读回', goodDisc.payload?.settings?.discoveryPort === 49911);
  await hit(routes, '/collab-board/settings', { method: 'PATCH', body: { discoveryPort: 48911 } });

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

  const ver = await hit(routes, '/collab-board/version');
  check('/version 200', ver.status === 200);
  check('/version 报的是宿主包版本', /^\d+\.\d+\.\d+$/.test(String(ver.payload?.version)), String(ver.payload?.version));
  check('/version 带 origin / role / headSeq',
    /^[0-9a-f]{16}$/.test(String(ver.payload?.origin))
    && typeof ver.payload?.role === 'string'
    && 'headSeq' in (ver.payload || {}));

  const identityFile = join(dataDir, 'identity.json');
  check('生成了 identity.json', existsSync(identityFile));
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  check('identity 有 origin 和 groupId',
    /^[0-9a-f]{16}$/.test(identity.origin) && /^[0-9a-f]{16}$/.test(identity.groupId));

  console.log('\n3b. 墓碑删除（0.10.14）');
  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: {
      kind: 'task', taskId: 't-del', title: '机密标题不该留', detail: '机密描述也不该留', status: 'pending',
    },
  });
  const delRes = await hit(routes, '/collab-board/tasks/delete', {
    method: 'POST',
    body: { taskId: 't-del' },
  });
  check('/tasks/delete 成功',
    delRes.payload?.ok === true && (delRes.payload?.deleted || []).includes('t-del'),
    JSON.stringify(delRes.payload));

  const rawLocal = readFileSync(logPath, 'utf8');
  check('本机日志文件里搜不到原文', !rawLocal.includes('机密标题') && !rawLocal.includes('机密描述'));
  const afterDel = await hit(routes, '/collab-board/state');
  const delRows = (afterDel.payload?.events || []).filter((e) => e.kind === 'task' && e.taskId === 't-del');
  check('墓碑事件还在（不删行）', delRows.some((e) => e.deleted === true));
  check('历史行正文被擦空', delRows.every((e) => !String(e.title || '').includes('机密标题')));

  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', taskId: 't-finished', title: '做完的卡', status: 'done', owner: '' },
  });
  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', taskId: 't-live', title: '还在跑的卡', status: 'running' },
  });
  const purge = await hit(routes, '/collab-board/tasks/delete', {
    method: 'POST',
    body: { allFinished: true },
  });
  check('allFinished 只清已结束的卡',
    (purge.payload?.deleted || []).includes('t-finished')
      && !(purge.payload?.deleted || []).includes('t-live'),
    JSON.stringify(purge.payload?.deleted));
  const purgeAgain = await hit(routes, '/collab-board/tasks/delete', {
    method: 'POST',
    body: { taskId: 't-finished' },
  });
  check('重复删是空操作', purgeAgain.payload?.ok === true
    && (purgeAgain.payload?.deleted || []).length === 0, JSON.stringify(purgeAgain.payload));

  console.log('\n4. Hub 控制');
  const hubSolo = await hit(routes, '/collab-board/hub');
  check('solo 时 running=false', hubSolo.payload?.running === false);
  check('solo 时 pending 记着待同步事件', hubSolo.payload?.pending > 0, String(hubSolo.payload?.pending));

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
  // Hub 启动要写一条 hub 事件（系统 origin）。之前把 Hub 名字塞进信封的 name，
  // 校验器一拦就进熔断 —— 这里必须盯住。
  check('Hub 起来后系统写入没熔断',
    started.payload?.status?.server?.systemBroken === false,
    JSON.stringify(started.payload?.status?.server?.systemBroken));
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

  // 认领事件是 Hub 替本机写的（origin 是本机，但本机日志里原本没有）。
  // 等一轮拉取（3 秒）后，它必须落在本机日志里 —— 这是 onPulled 判据的验收。
  await new Promise((r) => setTimeout(r, 4000));
  const afterClaimLog = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('Hub 替本机写的认领事件落进了本机日志',
    afterClaimLog.some((e) => e.kind === 'task' && e.taskId === 't1' && e.status === 'running'),
    `共 ${afterClaimLog.length} 条`);

  const beforeAgain = afterClaimLog.length;
  const claimAgain = await hit(routes, '/collab-board/tasks/claim', {
    method: 'POST',
    body: { taskId: 't1' },
  });
  // 已是自己 + running + 租约没过 → 幂等返回，不写新事件（否则事件流被重复认领撑爆）
  check('重复认领返回幂等', claimAgain.status === 200 && claimAgain.payload?.idempotent === true,
    JSON.stringify(claimAgain.payload).slice(0, 160));
  await new Promise((r) => setTimeout(r, 400));
  const afterAgainLog = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('重复认领不写新事件', afterAgainLog.length === beforeAgain, `${beforeAgain} → ${afterAgainLog.length}`);

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

  console.log('\n7. 自动认领');
  // 用另一个 origin 以成员身份 join，往 Hub 上写一张「别人建的」待认领卡
  const hubInfo = await hit(routes, '/collab-board/hub');
  const hubPort = hubInfo.payload?.server?.port;
  const otherOrigin = 'abcdef0123456789';
  const joinRes = await fetch(`http://127.0.0.1:${hubPort}/collab/v1/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wireProtocol: 1, origin: otherOrigin, name: '另一个成员' }),
  }).then((r) => r.json());
  const otherToken = joinRes?.data?.token;
  check('另一个成员 join 成功', Boolean(otherToken));

  // 在线态只有 Hub 现算得出来（心跳 45 秒窗口），事件流里没有 —— 得从 /members 拿
  const memberList = await hit(routes, '/collab-board/members');
  check('/members 连上 Hub 时返回 connected', memberList.payload?.connected === true,
    JSON.stringify({ connected: memberList.payload?.connected, error: memberList.payload?.error }));
  const seenOther = (memberList.payload?.members || []).find((m) => m.origin === otherOrigin);
  check('/members 里有刚 join 的成员且在线', Boolean(seenOther) && seenOther.online === true,
    JSON.stringify(seenOther || null));
  check('/members 报的在线数和列表一致',
    memberList.payload?.online === (memberList.payload?.members || []).filter((m) => m.online).length);

  await fetch(`http://127.0.0.1:${hubPort}/collab/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({
      events: [{
        eventVersion: 2,
        id: 'ev_abcdef_auto01_aaa',
        origin: otherOrigin,
        name: '另一个成员',
        kind: 'task',
        taskId: 'auto1',
        title: '自动认领测试卡',
        status: 'pending',
        priority: 'normal',
      }],
    }),
  });

  // 把这个间隔压到 1 秒，等自动认领跑一轮
  await hit(routes, '/collab-board/settings', {
    method: 'PATCH',
    body: { patch: { autoClaimMs: 1000 } },
  });
  await new Promise((r) => setTimeout(r, 8000));

  const afterAuto = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const autoEv = afterAuto.filter((e) => e.taskId === 'auto1' && e.kind === 'task');
  const autoLatest = autoEv.sort((a, b) => (a.seq || 0) - (b.seq || 0)).pop();
  check('自动认领了别人建的卡',
    Boolean(autoLatest) && autoLatest.status === 'running' && autoLatest.owner === identity.origin,
    JSON.stringify({ status: autoLatest?.status, owner: autoLatest?.owner, n: autoEv.length }));
  check('写了「自动认领」系统提示',
    afterAuto.some((e) => e.kind === 'note' && String(e.text).includes('自动认领')));
  // 0.11.4：提示要带 taskId，否则卡删掉之后这条会一直挂在动态流里
  const autoNote = afterAuto.find((e) => e.kind === 'note' && String(e.text).includes('自动认领'));
  check('自动认领提示带 taskId（删卡时跟着消失）',
    autoNote?.taskId === 'auto1', JSON.stringify(autoNote?.taskId));

  // 自己建的卡不该被自己抢（否则「我派给别人的活我自己接了」）
  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', id: 'auto2', title: '自己建的卡', status: 'pending' },
  });
  await new Promise((r) => setTimeout(r, 7000));
  const afterSelf = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const selfCard = afterSelf.filter((e) => e.taskId === 'auto2' && e.kind === 'task').pop();
  check('自己建的卡不被自己抢', Boolean(selfCard) && !selfCard.owner,
    JSON.stringify({ owner: selfCard?.owner, status: selfCard?.status }));

  console.log('\n7b. 本地预检：抢卡在写日志之前就被挡掉');
  // 为什么要本地挡：Hub 拒事件时整批拒，脏事件留在日志里会每轮重推、连坐整批。
  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', id: 'guard1', title: '本地预检测试卡', status: 'pending' },
  });
  const postTool = findTool(tools, 'collab_post');
  let stealErr = null;
  try {
    await postTool.execute({
      kind: 'task', id: 'guard1', taskId: 'guard1',
      title: '想抢', status: 'running', owner: otherOrigin,
    });
  } catch (e) { stealErr = e; }
  check('抢卡被本地预检拒掉', Boolean(stealErr) && /别人认领|不能把 owner 写成别人/.test(String(stealErr.message)),
    String(stealErr && stealErr.message));
  const logAfterSteal = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('脏事件没写进日志', !logAfterSteal.some((e) => e.taskId === 'guard1' && e.owner === otherOrigin));

  // 改标题但不传 owner：必须放行，而且事件里**不能带** owner 字段
  // （带了空串就等于「释放」，推给 Hub 会被当成越权拒掉）
  const editRes = await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', id: 'guard1', taskId: 'guard1', title: '改了标题', status: 'pending' },
  });
  check('改标题不传 owner：放行', editRes.status === 200, JSON.stringify(editRes.payload));
  check('落盘事件里没有 owner 字段（让 Hub 沿用当前值）',
    Boolean(editRes.payload?.event) && !('owner' in editRes.payload.event),
    JSON.stringify(editRes.payload?.event));

  console.log('\n7c. 脏事件不堵队列（整批被拒时的逐条降级）');
  // 手工往日志里塞一条 Hub 必拒的事件：新建任务却写着别人的 owner。
  // 模拟旧版本客户端、或者直接改日志写进来的数据 —— 它不该让这台机器失去同步。
  const dirtyId = 'ev_dirty_00001_zzz';
  appendFileSync(logPath, JSON.stringify({
    eventVersion: 2,
    id: dirtyId,
    origin: identity.origin,
    name: '',
    ts: new Date().toISOString(),
    kind: 'task',
    taskId: 'dirty1',
    title: 'Hub 一定不认的一条',
    status: 'pending',
    owner: 'ffffeeeeddddcccc',
  }) + '\n');
  const msgRes = await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'msg', from: '测试', text: '这条必须推得上去' },
  });
  check('合法消息写进日志了', msgRes.status === 200 && msgRes.payload?.ok === true);
  await new Promise((r) => setTimeout(r, 6000));
  const afterDirty = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const legitMsg = afterDirty.find((e) => e.kind === 'msg' && String(e.text || '').includes('这条必须推得上去'));
  // Hub 分的 seq 不回写 events.jsonl（那是只追加的事实源），存在 .synced.json 里。
  // 所以「推上去了没有」看 sidecar，不看日志。
  const syncedMap = JSON.parse(readFileSync(join(dataDir, '.synced.json'), 'utf8'));
  check('合法消息没被脏事件连坐（拿到了 Hub 的 seq）',
    Boolean(legitMsg && syncedMap[legitMsg.id]), JSON.stringify({ id: legitMsg?.id }));
  check('脏事件被跳过（不在 seqMap 里）', !syncedMap[dirtyId], JSON.stringify({ dirty: syncedMap[dirtyId] }));
  // 跳过可以，但必须出声 —— 静默丢弃等于让人以为写成功了
  const rejectNote = afterDirty.find(
    (e) => e.kind === 'note' && e.level === 'warn' && String(e.text || '').includes('被 Hub 拒了'),
  );
  check('被拒事件落了 warn note（面板和 agent 都看得见）',
    Boolean(rejectNote), String(rejectNote?.text || '').slice(0, 90));
  // 0.11.4：这条提示属于 dirty1 那张卡；卡删了它就该跟着走，不能永远挂在动态流里
  check('被拒提示带 taskId（删卡时跟着消失）',
    rejectNote?.taskId === 'dirty1', JSON.stringify(rejectNote?.taskId));

  // 落盘拉黑：不再算待同步、不进看板视图、重启后也不该再推
  const hubAfterDirty = await hit(routes, '/collab-board/hub');
  check('被拒事件不再算「待同步」', Number(hubAfterDirty.payload?.pending) === 0,
    String(hubAfterDirty.payload?.pending));
  const rejectedFile = join(dataDir, '.rejected.json');
  const rejectedIds = existsSync(rejectedFile) ? JSON.parse(readFileSync(rejectedFile, 'utf8')) : null;
  check('被拒 id 落盘（重启后不再重推）',
    Array.isArray(rejectedIds) && rejectedIds.includes(dirtyId), JSON.stringify(rejectedIds));
  const stateAfterDirty = await hit(routes, '/collab-board/state');
  check('被拒事件不进制看板的视图',
    !(stateAfterDirty.payload?.events || []).some((e) => e.id === dirtyId));

  // ── 409 毒丸：改别人建的卡标题（0.10.8 修） ──
  // 以前 `conflict` 不在 isRejection 名单里，409 会走进「网络错误」分支：
  // 整批原样留着、只打一行 warn，下一轮重试还是同一条 409
  // —— 该机器的同步队列就此永久卡死（R10 真机实测，汐汐 18:39 踩中）。
  const beforeRejected = new Set(Array.isArray(rejectedIds) ? rejectedIds : []);
  await fetch(`http://127.0.0.1:${hubPort}/collab/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({
      events: [{
        eventVersion: 2, id: 'ev_abcdef_oc409_aaa', origin: otherOrigin, name: '另一个成员',
        kind: 'task', taskId: 'othercard409', title: '别人建的卡', status: 'pending',
      }],
    }),
  });
  // 等本机拉到这张卡：没有 prevTask 就触发不了 409（判据要「卡已存在」）
  await new Promise((r) => setTimeout(r, 6000));
  const clobberPost = await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', taskId: 'othercard409', title: '本机想改别人卡的标题', status: 'pending' },
  });
  check('改别人卡标题先写进了本地日志', clobberPost.status === 200);
  await new Promise((r) => setTimeout(r, 6000));
  const rejectedAfter409 = existsSync(rejectedFile) ? JSON.parse(readFileSync(rejectedFile, 'utf8')) : [];
  const fresh409 = rejectedAfter409.filter((id) => !beforeRejected.has(id));
  check('409 被逐条拉黑，没有卡住整批', fresh409.length >= 1, JSON.stringify(fresh409));
  const hubAfter409 = await hit(routes, '/collab-board/hub');
  check('409 之后队列没卡死（pending=0）',
    Number(hubAfter409.payload?.pending) === 0, String(hubAfter409.payload?.pending));

  console.log('\n8. 增量读看板（collab_state）');
  const stateTool = findTool(tools, 'collab_state');
  const stateFirst = JSON.parse((await stateTool.execute({})).text);
  check('第一次读能拿到游标', Number.isFinite(stateFirst.cursor?.to) && stateFirst.cursor.to > 0, String(stateFirst.cursor?.to));
  check('第一次读有未读', stateFirst.cursor.unreadTotal > 0, String(stateFirst.cursor.unreadTotal));
  check('归我的卡在 mine 里', Array.isArray(stateFirst.mine) && stateFirst.mine.length >= 1,
    JSON.stringify(stateFirst.mine?.map((t) => t.taskId)));

  // 待认领池要带上「为什么还不能接」——否则 agent 以为每张 pending 都能接
  const auto2Pending = stateFirst.pending.find((t) => t.taskId === 'auto2');
  check('自己建的卡在 pending 里标了不可接',
    Boolean(auto2Pending) && auto2Pending.claimable === false && auto2Pending.blockedBy === 'own',
    JSON.stringify(auto2Pending));

  const stateSecond = JSON.parse((await stateTool.execute({})).text);
  check('游标推进后再读，未读清零', stateSecond.cursor.unreadTotal === 0, String(stateSecond.cursor.unreadTotal));
  check('第二次不再重复给 mine 之外的旧事件',
    Array.isArray(stateSecond.unread) && stateSecond.unread.length === 0);

  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'msg', from: '测试', text: '游标之后的新消息' },
  });
  // 本机写的事件要先推给 Hub 拿到 seq，才会出现在下一轮读里
  await new Promise((r) => setTimeout(r, 4500));
  const stateThird = JSON.parse((await stateTool.execute({})).text);
  check('新消息只出现在下一轮', stateThird.cursor.unreadTotal >= 1
    && stateThird.unread.some((u) => String(u.text || '').includes('游标之后')), JSON.stringify(stateThird.unread));

  console.log('\n9. 自动唤醒护栏');
  await hit(routes, '/collab-board/settings', {
    method: 'PATCH',
    body: { patch: { wakeOnMessage: true, wakeCooldownMs: 60000 } },
  });
  // 用另一个 origin 推一条 msg：会走到唤醒逻辑。测试里没有 sessionController，
  // 所以应该是「唤醒失败但不崩」，看板主流程还能继续响应。
  await fetch(`http://127.0.0.1:${hubPort}/collab/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({
      events: [{
        eventVersion: 2,
        id: 'ev_abcdef_wake01_aaa',
        origin: otherOrigin,
        name: '另一个成员',
        kind: 'msg',
        taskId: 't1',
        text: '这条应该触发唤醒尝试',
      }],
    }),
  });
  await new Promise((r) => setTimeout(r, 4000));
  const afterWake = await hit(routes, '/collab-board/state');
  check('唤醒逻辑失败不影响看板主流程', afterWake.status === 200 && afterWake.payload?.ok !== false);

  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'msg', from: '我自己', text: '自己发的不该唤醒自己' },
  });
  const settingsAfter = await hit(routes, '/collab-board/settings');
  check('自己发消息不会卡住唤醒锁', settingsAfter.status === 200);

  console.log('\n9b. 可认领判据（唯一一份，在 selectable.mjs）');
  const A_ORIGIN = 'aaaaaaaaaaaaaaaa';
  const B_ORIGIN = 'bbbbbbbbbbbbbbbb';
  const mk = (o) => ({ kind: 'task', epoch: 1, ...o });
  const cards = [
    mk({ taskId: 's1', title: 'B 建的空卡', status: 'pending', owner: '', origin: B_ORIGIN, seq: 1, id: 'ev_s1' }),
    mk({ taskId: 's2', title: 'A 建的空卡', status: 'pending', owner: '', origin: A_ORIGIN, seq: 2, id: 'ev_s2' }),
    mk({ taskId: 's3', title: '已经有主', status: 'pending', owner: B_ORIGIN, origin: B_ORIGIN, seq: 3, id: 'ev_s3' }),
    mk({ taskId: 's4', title: '要 gpu', status: 'pending', owner: '', origin: B_ORIGIN, requiredCapabilities: ['gpu'], seq: 4, id: 'ev_s4' }),
    mk({ taskId: 's5', title: '依赖没完成', status: 'pending', owner: '', origin: B_ORIGIN, dependsOn: ['s2'], seq: 5, id: 'ev_s5' }),
  ];
  // s2 被别人改过标题：最新那条事件的 origin 是 B，但建卡人还是 A
  cards.push(mk({ taskId: 's2', title: 'A 建的（被 B 改过）', status: 'pending', owner: '', origin: B_ORIGIN, seq: 6, id: 'ev_s6' }));

  const selRows = claimableTasks(cards, { selfOrigin: A_ORIGIN });
  const reasonOf = new Map(selRows.map((r) => [r.task.taskId, r.reason]));
  check('别人建的空卡可接', reasonOf.get('s1') === '', String(reasonOf.get('s1')));
  check('自己建的卡不可接（哪怕被别人改过标题）', reasonOf.get('s2') === 'own', String(reasonOf.get('s2')));
  check('有主的卡不可接', reasonOf.get('s3') === 'owned');
  // 能力标签已删（0.11.1）：写了 requiredCapabilities 的卡不再挡认领 —— 它就是张普通卡
  check('写了 requiredCapabilities 的卡照样可接', reasonOf.get('s4') === '', String(reasonOf.get('s4')));
  check('依赖没完成不可接', reasonOf.get('s5') === 'deps');
  check('建卡人看的是最早那条的 origin', earliestByTask(cards).get('s2') === A_ORIGIN,
    String(earliestByTask(cards).get('s2')));

  console.log('\n9c. 折叠时继承 owner（改标题不带 owner 的本机视图）');
  const fold = [
    mk({ taskId: 'o1', title: '建卡', status: 'pending', origin: A_ORIGIN, seq: 1, id: 'ev_o1' }),
    mk({ taskId: 'o1', title: '认领', status: 'running', owner: A_ORIGIN, seq: 2, id: 'ev_o2' }),
    mk({ taskId: 'o1', title: '改标题（没有 owner 键）', status: 'pending', seq: 3, id: 'ev_o3' }),
  ];
  check('最新一条缺 owner → 沿用上一版（本机不再显示无主）',
    latestTasks(fold).get('o1').owner === A_ORIGIN, JSON.stringify(latestTasks(fold).get('o1').owner));
  const foldReleased = fold.concat([
    mk({ taskId: 'o1', title: '显式释放', status: 'running', owner: '', seq: 4, id: 'ev_o4' }),
  ]);
  check('显式 owner:"" → 真的变空（释放不被继承挡住）',
    latestTasks(foldReleased).get('o1').owner === '', JSON.stringify(latestTasks(foldReleased).get('o1').owner));
  const foldClaimable = claimableTasks(fold, { selfOrigin: A_ORIGIN });
  check('继承后的卡不会被判成可接（有主）',
    foldClaimable.find((r) => r.task.taskId === 'o1')?.reason === 'owned',
    String(foldClaimable.find((r) => r.task.taskId === 'o1')?.reason));

  console.log('\n9d. 唤醒调用签名（prompt 必须收到 signal）');
  // 0.10.6 死在这：只传了 request，宿主内部 signal.throwIfAborted() 读 undefined。
  // 这个假 prompt 复刻真宿主的第一句 —— signal 缺失就在这里抛，等于把那天的现场搬进测试。
  const wakeCalls = [];
  services.sessionController = {
    list: async () => ({ items: [{ sessionId: 'sess-wake-1', updatedAt: Date.now(), agentAvailable: true }] }),
    prompt: async (request, signal) => {
      wakeCalls.push({ request, signal });
      signal.throwIfAborted();
      return { accepted: true };
    },
  };
  // 先把 Hub 的 seq 垫到本机之后：真机上本机 seq 不会超过 Hub，测试环境会（构造残留）。
  // 不垫的话 9d 的消息 seq 比本机已见小，会被判成历史重放。
  for (const i of [1, 2, 3]) {
    await fetch(`http://127.0.0.1:${hubPort}/collab/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({
        events: [{
          eventVersion: 2,
          id: `ev_abcdef_fill0${i}_ccc`,
          origin: otherOrigin,
          name: '另一个成员',
          kind: 'task',
          taskId: `fill${i}`,
          title: '垫高 seq',
          status: 'pending',
        }],
      }),
    });
  }
  await new Promise((r) => setTimeout(r, 3600));
  const push9d = await fetch(`http://127.0.0.1:${hubPort}/collab/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({
      events: [{
        eventVersion: 2,
        id: 'ev_abcdef_wake02_bbb',
        origin: otherOrigin,
        name: '另一个成员',
        kind: 'msg',
        taskId: 'wake2',
        text: '这条必须把 AbortSignal 带上',
      }],
    }),
  });
  console.log(`  [9d] push ${push9d.status} ${JSON.stringify(await push9d.clone().json().catch(() => null)).slice(0, 160)}`);
  await new Promise((r) => setTimeout(r, 4000));
  check('唤醒真的调到 prompt', wakeCalls.length === 1, `calls=${wakeCalls.length}`);
  check('第二个参数是 AbortSignal',
    Boolean(wakeCalls[0]?.signal) && typeof wakeCalls[0].signal.throwIfAborted === 'function',
    String(wakeCalls[0]?.signal));
  check('request 带 requestId / mode / content',
    Boolean(wakeCalls[0]?.request?.requestId)
    && wakeCalls[0].request.mode === 'queue'
    && wakeCalls[0].request.content?.[0]?.type === 'text',
    JSON.stringify(wakeCalls[0]?.request));
  const verAfterWake = await hit(routes, '/collab-board/version');
  check('唤醒成功后 lastAt 有值',
    Boolean(verAfterWake.payload?.wake?.lastAt) && verAfterWake.payload?.wake?.lastError === '',
    JSON.stringify(verAfterWake.payload?.wake));

  console.log('\n9e. 唤醒判据（(epoch, seq)，唯一一份在 wake.mjs）');
  // 为什么不是测 ts：第一版按「10 分钟年龄」挡历史重放，被汐汐当场否掉 ——
  // 对方关机几小时、开机后才拉到的真消息，ts 也老了。而且那版测试是假绿：
  // 关掉过滤照样全过。这里改成直接测判据本身。
  // 为什么带 epoch：Hub 换代后 seq 从 1 重来，只比 seq 会把新消息全判成历史 ——
  // 那也是汐汐拦的。
  const selfOrigin = 'self-origin';
  const verdict = (ev, m = {}) => shouldWake(ev, { selfOrigin, maxEpoch: 1, maxSeq: 230, ...m });
  check('同 epoch、seq 更大 → 叫（离线期间的真消息）',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 231 }).wake === true);
  check('同 epoch、seq 不大于已见 → 历史重放，不叫',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 13 }).reason === 'history');
  check('同 epoch、seq 相等 → 历史（重复拉取）',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 230 }).wake === false);
  check('epoch 更大、seq 只有 1 → 叫（换代后整批算新的）',
    verdict({ kind: 'msg', origin: 'other', epoch: 2, seq: 1 }).wake === true);
  check('epoch 更小 → 历史，不看 seq',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 999 }, { maxEpoch: 2, maxSeq: 3 }).reason === 'history');
  check('自己发的不叫', verdict({ kind: 'msg', origin: selfOrigin, seq: 999 }).reason === 'self');
  check('没有 seq 的不叫', verdict({ kind: 'msg', origin: 'other' }).reason === 'no-seq');
  check('不是 msg 的不叫', verdict({ kind: 'note', origin: 'other', seq: 999 }).reason === 'not-msg');
  // 定向消息（0.10.15）：依赖解锁发的那条只该叫醒一个人
  check('定向消息叫的是别人 → 不叫',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 231, to: 'somebody-else' }).reason === 'not-for-me');
  check('定向消息叫的就是我 → 叫',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 231, to: selfOrigin }).wake === true);
  check('没写 to 的老消息照旧叫',
    verdict({ kind: 'msg', origin: 'other', epoch: 1, seq: 231 }).wake === true);
  check('maxSeenOf 取 (epoch, seq) 字典序最大',
    JSON.stringify(maxSeenOf([{ epoch: 1, seq: 900 }, { epoch: 2, seq: 3 }, { id: 'x' }])) === '{"epoch":2,"seq":3}',
    JSON.stringify(maxSeenOf([{ epoch: 1, seq: 900 }, { epoch: 2, seq: 3 }])));

  /* ───────────────────── 视图源（0.11.3） ───────────────────── */

  console.log('\n9f. role=hub 时视图读 Hub 全量，不读残缺的本机日志');
  /**
   * 复刻 2026-11-06 真机事故：本机 `events.jsonl` 只剩十几条 member/hub/msg，
   * 全部 `task` 事件落在 seq 断层的缺口里 —— 于是**任务列表空白、动态流正常**
   * （msg/note 恰好都在缺口之后）。而完整历史一直在 Hub 那边。
   *
   * 视图源分支之后：`role === 'hub'` 时面板和 agent 读 Hub 内存里那份全量，
   * 本机日志缺成什么样都不再影响显示。
   */
  const hubBefore = await hit(routes, '/collab-board/hub');
  check('9f 前置：本机是 Hub', hubBefore.payload?.role === 'hub', String(hubBefore.payload?.role));
  const hubEventCount = Number(hubBefore.payload?.server?.events) || 0;
  check('9f 前置：Hub 里有相当多事件', hubEventCount > 5, String(hubEventCount));

  const stateBeforeTrunc = await hit(routes, '/collab-board/state');
  const t1Before = (stateBeforeTrunc.payload?.events || [])
    .find((e) => e && e.kind === 'task' && e.taskId === 't1');
  check('9f 前置：截断前 /state 有 t1 的 task 事件', Boolean(t1Before));

  // 只留 member 事件 —— 就是真机上那十几条的形状（任务、对话、进度全没了）
  const beforeRows = readFileSync(logPath, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
  const membersOnly = beforeRows.filter((e) => e && e.kind === 'member');
  writeFileSync(
    logPath,
    membersOnly.length ? `${membersOnly.map((e) => JSON.stringify(e)).join('\n')}\n` : '',
    'utf8',
  );
  const afterRows = readFileSync(logPath, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
  check('9f 本机日志里确实一条 task 事件都没有了',
    afterRows.filter((e) => e.kind === 'task').length === 0, `${afterRows.length} 条`);

  const stateAfterTrunc = await hit(routes, '/collab-board/state');
  const t1After = (stateAfterTrunc.payload?.events || [])
    .find((e) => e && e.kind === 'task' && e.taskId === 't1');
  check('9f 本机日志残缺时 /state 仍看得见 task（读 Hub 全量）', Boolean(t1After),
    `total=${stateAfterTrunc.payload?.total}`);
  check('9f 看得见的那条带 Hub 分配的 seq（不是本机缓存补出来的）',
    Boolean(t1After) && Number.isFinite(t1After.seq), JSON.stringify(t1After?.seq));
  check('9f /state 总条数覆盖 Hub 全量',
    Number(stateAfterTrunc.payload?.total) >= hubEventCount,
    `${stateAfterTrunc.payload?.total} vs ${hubEventCount}`);

  const boardTool = findTool(tools, 'collab_state');
  const board = await boardTool.execute({ full: true, advance: false, limit: 100 });
  const boardOut = JSON.parse(String(board.text));
  const cardCount = (boardOut.watching || []).length + (boardOut.mine || []).length
    + (boardOut.others || []).length + (boardOut.pending || []).length;
  check('9f agent 读看板也看得见卡（不再是零张）', cardCount > 0,
    JSON.stringify({
      watching: (boardOut.watching || []).length,
      mine: (boardOut.mine || []).length,
      others: (boardOut.others || []).length,
      pending: (boardOut.pending || []).length,
    }));
  check('9f agent 的增量流里也有 task 事件',
    (boardOut.unread || []).some((e) => e.kind === 'task'),
    `${(boardOut.unread || []).length} 条未读`);

  console.log('\n10. 停止 Hub');
  const stop = await hit(routes, '/collab-board/hub/stop', { method: 'POST' });
  check('hub/stop 200', stop.status === 200 && stop.payload?.stopped === true);
  const hubBack = await hit(routes, '/collab-board/hub');
  check('停了以后 running=false', hubBack.payload?.running === false);

  /* ───────────────────── 投递账本（0.10.9） ───────────────────── */

  console.log('\n11. 投递账本（先记账、去重、按项重试）');

  async function waitFor(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  const df = join(mkdtempSync(join(tmpdir(), 'collab-delivery-')), 'inflight.json');
  const calls = [];
  const given = [];
  let failOnce = true;
  const d = createDelivery({
    file: df,
    delayMs: 20,
    retries: () => 3,
    send: async (item) => {
      calls.push(item.eventId);
      // ev_a 第一次失败，模拟「宿主没会话 / 会话忙」
      if (item.eventId === 'ev_a' && failOnce) { failOnce = false; throw new Error('宿主忙'); }
    },
    onGiveUp: (item) => given.push(item.eventId),
  });
  d.offer({ eventId: 'ev_a', taskId: 't1', from: '姐', text: 'x' });
  check('第一次入账成功', d.snapshot().queued === 1 || calls.includes('ev_a'),
    JSON.stringify(d.snapshot()));
  check('同一条再 offer 不会重复入账', d.offer({ eventId: 'ev_a', taskId: 't1', from: '姐', text: 'x' }) === false);
  await waitFor(() => calls.includes('ev_a'));
  check('失败后账本还留着（不是只写日志）', d.snapshot().queued === 1, JSON.stringify(d.snapshot()));
  check('失败信息进了账本', d.snapshot().lastError === '宿主忙', d.snapshot().lastError);

  // 坏项不该堵住后面的：ev_b 立刻能投
  d.offer({ eventId: 'ev_b', taskId: 't2', from: '姐', text: 'y' });
  await waitFor(() => calls.includes('ev_b'));
  check('坏项在队头也不堵后面的消息', calls.includes('ev_b'), JSON.stringify(calls));

  await waitFor(() => calls.filter((x) => x === 'ev_a').length === 2, 1000);
  check('到点自动重试并成功', calls.filter((x) => x === 'ev_a').length === 2, JSON.stringify(calls));
  await waitFor(() => d.snapshot().queued === 0, 1000);
  check('投完账本清空', d.snapshot().queued === 0);
  d.close();

  const df2 = join(mkdtempSync(join(tmpdir(), 'collab-delivery2-')), 'inflight.json');
  const given2 = [];
  const d2 = createDelivery({
    file: df2,
    delayMs: 10,
    retries: () => 2,
    send: async () => { throw new Error('一直送不到'); },
    onGiveUp: (item) => given2.push(item.eventId),
  });
  d2.offer({ eventId: 'ev_dead', taskId: 't3', from: '姐', text: 'z' });
  await waitFor(() => given2.includes('ev_dead'), 2000);
  check('超过 wakeRetries 就放弃', given2.includes('ev_dead'), JSON.stringify(given2));
  check('放弃后账本不堵着', d2.snapshot().queued === 0);
  d2.close();

  // 11b. 冷却期里的消息不再被丢掉（0.10.10）
  const dfc = join(mkdtempSync(join(tmpdir(), 'collab-cool-')), 'inflight.json');
  const coolCalls = [];
  const cool = createDelivery({
    file: dfc,
    delayMs: 10,
    retries: () => 3,
    send: async (item) => { coolCalls.push(item.eventId); },
  });
  const future = Date.now() + 200;
  cool.offer({ eventId: 'ev_c1', taskId: 'tc', from: '姐', text: '第一条', notBefore: future, deferred: true });
  cool.offer({ eventId: 'ev_c2', taskId: 'tc', from: '姐', text: '第二条', notBefore: future });
  await new Promise((r) => setTimeout(r, 60));
  check('冷却期的消息不丢，只是延后', cool.snapshot().queued === 1, JSON.stringify(cool.snapshot()));
  check('同一个 taskId 在账本里合并成一条（没攒成两条）',
    cool.state().items.length === 1 && cool.state().items[0].eventId === 'ev_c2',
    JSON.stringify(cool.state().items.map((it) => it.eventId)));
  check('合并时保留「补叫」标注', cool.state().items[0].deferred === true,
    String(cool.state().items[0].deferred));
  check('冷却没到就不投', coolCalls.length === 0, JSON.stringify(coolCalls));
  await waitFor(() => coolCalls.length === 1, 1000);
  check('到点后补叫一次，触发的是最新那条', coolCalls.length === 1 && coolCalls[0] === 'ev_c2',
    JSON.stringify(coolCalls));
  cool.close();

  console.log('\n12. 重启补投（投递账本接进插件）');
  const restartDir = mkdtempSync(join(tmpdir(), 'collab-restart-'));
  writeFileSync(join(restartDir, 'settings.json'), JSON.stringify({ wakeOnMessage: true }), 'utf8');
  writeFileSync(join(restartDir, 'inflight.json'), JSON.stringify({
    version: 1,
    items: [{
      eventId: 'ev_restart_1',
      taskId: 't-restart',
      from: '姐',
      text: '上次没送到',
      attempts: 1,
      at: Date.now(),
      nextAt: 0,
      lastError: '宿主忙',
    }],
    done: [],
  }), 'utf8');
  const restartCalls = [];
  const services2 = {
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'sess-restart', updatedAt: Date.now(), agentAvailable: true }] }),
      prompt: async (request, signal) => {
        restartCalls.push({ request });
        signal.throwIfAborted();
        return { accepted: true };
      },
    },
  };
  const second = makeCtx(services2);
  apply(second.ctx, { dataDir: restartDir, syncLanInbox: false });
  await new Promise((r) => setTimeout(r, 3600));
  check('重启后真的补投了一次', restartCalls.length === 1, `calls=${restartCalls.length}`);
  check('补投的文本标明是第 2 次',
    String(restartCalls[0]?.request?.content?.[0]?.text || '').includes('第 2 次投递'),
    String(restartCalls[0]?.request?.content?.[0]?.text || '').slice(0, 80));
  const afterRestart = JSON.parse(readFileSync(join(restartDir, 'inflight.json'), 'utf8'));
  check('补投成功后账本清空', Array.isArray(afterRestart.items) && afterRestart.items.length === 0,
    JSON.stringify(afterRestart.items));
  for (const c of second.cleanups.reverse()) {
    try { c(); } catch { /* 忽略 */ }
  }
  rmSync(restartDir, { recursive: true, force: true });

  /* ───────────────────── 自动续跑（0.10.11） ───────────────────── */

  console.log('\n12b. 自动续跑（任务没完成就自己再排一次）');
  const contDir = mkdtempSync(join(tmpdir(), 'collab-continue-'));

  // 先用一次 apply 把 identity.json 生出来：任务卡的 owner 得是「自己」才续跑。
  const probe = makeCtx({});
  apply(probe.ctx, { dataDir: contDir, syncLanInbox: false });
  let contOrigin = '';
  try {
    contOrigin = JSON.parse(readFileSync(join(contDir, 'identity.json'), 'utf8')).origin || '';
  } catch { /* 下面会红 */ }
  for (const c of probe.cleanups.reverse()) {
    try { c(); } catch { /* 忽略 */ }
  }

  writeFileSync(join(contDir, 'settings.json'), JSON.stringify({
    wakeOnMessage: true,
    wakeSelfContinue: true,
    wakeSelfContinueMax: 2,
    wakeCooldownMs: 60000,
  }), 'utf8');
  // 一张还在 running、归自己的卡
  writeFileSync(join(contDir, 'events.jsonl'), JSON.stringify({
    id: 'ev_cont_task_1',
    kind: 'task', taskId: 't-cont', title: '续跑测试', status: 'running', owner: contOrigin,
  }) + '\n', 'utf8');
  // 一条「上次没送到」的唤醒，靠重启补投把它投出去
  writeFileSync(join(contDir, 'inflight.json'), JSON.stringify({
    version: 1,
    items: [{
      eventId: 'ev_cont_1',
      taskId: 't-cont',
      from: '姐',
      text: '上次没送到',
      attempts: 1,
      at: Date.now(),
      nextAt: 0,
      lastError: '宿主忙',
    }],
    done: [],
  }), 'utf8');

  const contCalls = [];
  const contCtx = makeCtx({
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'sess-cont', updatedAt: Date.now(), agentAvailable: true }] }),
      prompt: async (request, signal) => {
        contCalls.push(request);
        signal.throwIfAborted();
        return { accepted: true };
      },
    },
  });
  apply(contCtx.ctx, { dataDir: contDir, syncLanInbox: false });
  await new Promise((r) => setTimeout(r, 3600));

  check('补投那条真的送出去了', contCalls.length === 1, `calls=${contCalls.length}`);
  let contLedger = { items: [] };
  try {
    contLedger = JSON.parse(readFileSync(join(contDir, 'inflight.json'), 'utf8'));
  } catch { /* 下面会红 */ }
  const selfItem = (contLedger.items || []).find((it) => String(it.eventId).startsWith('ev_self_t-cont_'));
  check('任务还在 running → 自己排了下一次唤醒', Boolean(selfItem),
    JSON.stringify((contLedger.items || []).map((it) => it.eventId)));
  check('续跑项标了 kind=self 并带次数',
    selfItem?.kind === 'self' && String(selfItem?.text || '').includes('自动续跑 1/2'),
    String(selfItem?.text || '').slice(0, 80));
  check('续跑排在冷却之后，不是立刻刷',
    (Number(selfItem?.nextAt) || 0) > Date.now() + 30000, String(selfItem?.nextAt));

  // 12c. 任务 done 了就不该再续（同一份账本、同一张卡，把状态改成 done）
  // 先把上一实例关掉：它账上还排着一条 60 秒后的续跑，两个实例不能同时开着一份账本。
  for (const c of contCtx.cleanups.reverse()) { try { c(); } catch { /* 忽略 */ } }
  appendFileSync(join(contDir, 'events.jsonl'), JSON.stringify({
    id: 'ev_cont_task_2',
    kind: 'task', taskId: 't-cont', title: '续跑测试', status: 'done', owner: contOrigin,
  }) + '\n', 'utf8');
  writeFileSync(join(contDir, 'inflight.json'), JSON.stringify({
    version: 1,
    items: [{
      eventId: 'ev_cont_2', taskId: 't-cont', from: '姐', text: '再试一次',
      attempts: 1, at: Date.now(), nextAt: 0, lastError: '宿主忙',
    }],
    done: [],
  }), 'utf8');
  const contCtx2 = makeCtx({
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'sess-cont2', updatedAt: Date.now(), agentAvailable: true }] }),
      prompt: async (request, signal) => {
        contCalls.push(request);
        signal.throwIfAborted();
        return { accepted: true };
      },
    },
  });
  apply(contCtx2.ctx, { dataDir: contDir, syncLanInbox: false });
  await new Promise((r) => setTimeout(r, 3600));
  let doneLedger = { items: [] };
  try {
    doneLedger = JSON.parse(readFileSync(join(contDir, 'inflight.json'), 'utf8'));
  } catch { /* 下面会红 */ }
  check('任务 done 之后不再排续跑', (doneLedger.items || []).length === 0,
    JSON.stringify((doneLedger.items || []).map((it) => it.eventId)));

  for (const c of contCtx2.cleanups.reverse()) { try { c(); } catch { /* 忽略 */ } }
  rmSync(contDir, { recursive: true, force: true });

  /* ───────────────────── 启动接 Hub 失败重试（0.10.12） ───────────────────── */

  console.log('\n12d. 启动接 Hub 失败会退避重试');
  const retryDir = mkdtempSync(join(tmpdir(), 'collab-bootretry-'));
  writeFileSync(join(retryDir, 'settings.json'), JSON.stringify({
    role: 'member',
    hubAddress: 'http://127.0.0.1:1',
  }), 'utf8');
  const warns = [];
  const retryCtx = makeCtx({});
  retryCtx.ctx.logger = { info() {}, warn(msg) { warns.push(String(msg)); } };
  apply(retryCtx.ctx, { dataDir: retryDir, syncLanInbox: false });
  // 首次 800ms，失败后等 3s 再试：4.6 秒内应该看到两条
  await new Promise((r) => setTimeout(r, 4600));
  const hits = warns.filter((w) => w.includes('启动接 Hub 失败'));
  check('第一次失败后会自动重试（4.6 秒内至少两次）', hits.length >= 2, JSON.stringify(hits));
  check('重试日志写明第几次和等待秒数', /第 2 次.*秒后重试/.test(hits[1] || ''), hits[1] || '');
  for (const c of retryCtx.cleanups.reverse()) { try { c(); } catch { /* 忽略 */ } }
  rmSync(retryDir, { recursive: true, force: true });

  /* ───────────────────── 「本机已见」要算上 sidecar（0.10.12） ───────────────────── */

  console.log('\n12e. 日志被裁剪后，本机已见不能偏小');
  const seenDir = mkdtempSync(join(tmpdir(), 'collab-seen-'));
  const seenLog = join(seenDir, 'events.jsonl');
  const seenSeq = join(seenDir, '.synced.json');
  // 模拟 maxEvents 裁剪：日志里只剩到 seq 122，sidecar 却记到了 282
  writeFileSync(seenLog, [
    JSON.stringify({ id: 'ev_a', kind: 'msg', origin: 'other', epoch: 1, seq: 10 }),
    JSON.stringify({ id: 'ev_b', kind: 'msg', origin: 'other', epoch: 1, seq: 122 }),
  ].join('\n') + '\n', 'utf8');
  writeFileSync(seenSeq, JSON.stringify({ ev_c: [1, 282], ev_d: [1, 200] }), 'utf8');
  const seenStore = createStore({
    logPath: seenLog,
    seqFile: seenSeq,
    rejectedFile: join(seenDir, '.rejected.json'),
    origin: () => 'self',
    nameOf: () => '我',
    maxEventsOf: () => 5000,
    localIso: () => new Date().toISOString(),
  });
  const fromLog = maxSeenOf(seenStore.readEvents());
  const fromSide = seenStore.maxSynced();
  const seen = newerSeen(fromLog, fromSide);
  check('只算日志会偏小：只到 122', fromLog.seq === 122, String(fromLog.seq));
  check('sidecar 记得更高：282', fromSide.seq === 282, String(fromSide.seq));
  check('两者取大 → 282', seen.seq === 282, JSON.stringify(seen));
  check('补回来的 seq 200 判成历史，不再叫醒',
    shouldWake({ kind: 'msg', origin: 'other', epoch: 1, seq: 200 },
      { selfOrigin: 'self', maxEpoch: seen.epoch, maxSeq: seen.seq }).reason === 'history');
  check('真新消息 seq 283 仍然会叫',
    shouldWake({ kind: 'msg', origin: 'other', epoch: 1, seq: 283 },
      { selfOrigin: 'self', maxEpoch: seen.epoch, maxSeq: seen.seq }).wake === true);
  rmSync(seenDir, { recursive: true, force: true });

  /* ─────────────── 0.10.17：口令 / 校验 / 定向 ─────────────── */

  console.log('\n12f. 口令不回传、落盘是哈希');
  const setBefore = await hit(routes, '/collab-board/settings');
  check('未设口令时 hubCodeSet=false', setBefore.payload?.settings?.hubCodeSet === false);
  check('GET /settings 不含 hubCode 原文', (setBefore.payload?.settings?.hubCode || '') === '');
  const setCode = await hit(routes, '/collab-board/settings', {
    method: 'PATCH',
    body: { hubCode: 'LOVE' },
  });
  check('PATCH 口令成功', setCode.status === 200, JSON.stringify(setCode.payload));
  check('PATCH 响应里也没有原文', (setCode.payload?.settings?.hubCode || '') === '');
  check('hubCodeSet=true', setCode.payload?.settings?.hubCodeSet === true);
  const rawSettings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
  check('settings.json 里存的是哈希', String(rawSettings.hubCode || '').startsWith('v1$'),
    String(rawSettings.hubCode || ''));
  check('settings.json 里搜不到明文口令', !String(rawSettings.hubCode || '').includes('LOVE'));
  const codeAgain = await hit(routes, '/collab-board/settings', {
    method: 'PATCH',
    body: { hubCode: 'LOVE' },
  });
  check('同一个口令再存一次哈希不变（盐是 groupId，不是随机值）',
    JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).hubCode === rawSettings.hubCode,
    codeAgain.payload?.settings?.hubCodeSet ? '' : 'hubCodeSet 丢了');

  console.log('\n12g. 本地校验：脏事件不落盘');
  const logBefore = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
  const emptyMsg = await hit(routes, '/collab-board/post', {
    method: 'POST', body: { kind: 'msg', text: '   ' },
  });
  check('空 msg 被本地校验挡掉（400）', emptyMsg.status === 400, JSON.stringify(emptyMsg.payload));
  const orphanProgress = await hit(routes, '/collab-board/post', {
    method: 'POST', body: { kind: 'progress', done: 1, total: 2 },
  });
  check('没挂任务的 progress 被挡掉', orphanProgress.status === 400, JSON.stringify(orphanProgress.payload));
  const logAfter = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
  check('两条脏事件都没写进日志', logAfter === logBefore, `${logBefore} → ${logAfter}`);

  console.log('\n12h. @ 定向投递：mentions → to');
  const meVer = await hit(routes, '/collab-board/version');
  const myOrigin = String(meVer.payload?.origin || '');
  // 复用上面已有的 otherOrigin（abcdef0123456789），别重复声明
  await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'member', action: 'join', name: '姐姐', target: otherOrigin },
  });
  const mentionPost = await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'msg', from: '我', text: '@姐姐 看这个', mentions: ['姐姐'] },
  });
  check('带 mentions 的消息写成功', mentionPost.status === 200, JSON.stringify(mentionPost.payload));
  check('mentions 解析成 to（只叫点名的人）', mentionPost.payload?.event?.to === otherOrigin,
    JSON.stringify(mentionPost.payload?.event));
  check('原 mentions 字段保留（看板还显示 @ 了谁）',
    Array.isArray(mentionPost.payload?.event?.mentions)
    && mentionPost.payload.event.mentions[0] === '姐姐');

  // 卡上的普通评论：参与集只含当前 owner —— 手动把一张卡折成「B 在跑」
  appendFileSync(logPath, JSON.stringify({
    eventVersion: 2, id: 'ev_bbbbbb_relay001_aaa', origin: otherOrigin, name: '姐姐',
    ts: new Date().toISOString(), kind: 'task', taskId: 'relay1', title: '别人的卡',
    status: 'running', owner: otherOrigin, detail: '', epoch: 1, seq: 99001,
  }) + '\n', 'utf8');
  const relayPost = await hit(routes, '/collab-board/post', {
    method: 'POST', body: { kind: 'msg', from: '我', text: '这张卡怎么样了', taskId: 'relay1' },
  });
  check('卡上评论定向到当前 owner', relayPost.payload?.event?.to === otherOrigin,
    JSON.stringify(relayPost.payload?.event));
  const ownCard = await hit(routes, '/collab-board/post', {
    method: 'POST',
    body: { kind: 'task', taskId: 'watch1', title: '我自己的卡', status: 'running', owner: myOrigin },
  });
  check('自己认领的卡写成功', ownCard.status === 200, JSON.stringify(ownCard.payload));
  const stateWatchTool = findTool(tools, 'collab_state');
  const stateOut = await stateWatchTool.execute({ since: 0, advance: false });
  const stateWatch = JSON.parse(stateOut.text);
  check('collab_state 带 watching（参与集）',
    Array.isArray(stateWatch.watching)
    && stateWatch.watching.some((t) => t.taskId === 'watch1'),
    JSON.stringify(stateWatch.watching || []).slice(0, 200));
  check('collab_state 带 others（别人 running 卡的 owner）',
    Array.isArray(stateWatch.others)
    && stateWatch.others.some((t) => t.taskId === 'relay1' && t.owner === otherOrigin),
    JSON.stringify(stateWatch.others || []).slice(0, 200));

  console.log('\n12i. 启动迁移：明文口令 → 哈希');
  const migDir = mkdtempSync(join(tmpdir(), 'collab-mig-'));
  writeFileSync(join(migDir, 'settings.json'), JSON.stringify({ hubCode: 'MIGRATE' }), 'utf8');
  const mig = makeCtx({});
  apply(mig.ctx, { dataDir: migDir, syncLanInbox: false });
  const migSettings = JSON.parse(readFileSync(join(migDir, 'settings.json'), 'utf8'));
  check('明文已迁移成 v1$ 哈希',
    String(migSettings.hubCode || '').startsWith('v1$'), String(migSettings.hubCode || ''));
  check('迁移后文件里搜不到明文', !String(migSettings.hubCode || '').includes('MIGRATE'));
  for (const c of mig.cleanups.reverse()) {
    try { c(); } catch { /* 卸载失败不该让测试挂 */ }
  }
  rmSync(migDir, { recursive: true, force: true });

  /* ───────────────── 事件日志增量读（0.11.2） ───────────────── */

  console.log('\n12j. 事件日志增量读：只读新增的那段');
  const incDir = mkdtempSync(join(tmpdir(), 'collab-incr-'));
  const incLog = join(incDir, 'events.jsonl');
  const incSeq = join(incDir, '.synced.json');
  const incRej = join(incDir, '.rejected.json');
  const mkInc = () => createStore({
    logPath: incLog,
    seqFile: incSeq,
    rejectedFile: incRej,
    origin: () => 'self',
    nameOf: () => '我',
    maxEventsOf: () => 5000,
    localIso: () => new Date().toISOString(),
  });

  writeFileSync(incLog, ['a', 'b', 'c']
    .map((x) => JSON.stringify({ id: `ev_${x}`, kind: 'msg', origin: 'self', text: x }))
    .join('\n') + '\n', 'utf8');

  const inc = mkInc();
  check('首次读是全量，3 条', inc.readEvents().length === 3 && inc.stats().fullReads === 1,
    JSON.stringify(inc.stats()));
  inc.readEvents();
  check('没变化就不再读文件', inc.stats().fullReads === 1 && inc.stats().incrReads === 0,
    JSON.stringify(inc.stats()));

  inc.appendEvent({ id: 'ev_d', kind: 'msg', text: 'd' });
  check('自己追加不触发重读', inc.stats().fullReads === 1 && inc.stats().incrReads === 0,
    JSON.stringify(inc.stats()));
  check('追加后立刻读到 4 条', inc.readEvents().length === 4, String(inc.readEvents().length));

  appendFileSync(incLog,
    JSON.stringify({ id: 'ev_e', kind: 'msg', origin: 'other', text: 'e' }) + '\n', 'utf8');
  const incAfter = inc.readEvents();
  check('外部追加走增量读（全量次数不变）',
    inc.stats().incrReads === 1 && inc.stats().fullReads === 1, JSON.stringify(inc.stats()));
  check('增量拿到第 5 条', incAfter.length === 5 && incAfter.some((e) => e.id === 'ev_e'),
    String(incAfter.length));

  appendFileSync(incLog, '{"id":"ev_f","kind":"msg","ori', 'utf8');
  check('半截行不算事件', inc.readEvents().length === 5, String(inc.readEvents().length));
  appendFileSync(incLog, 'gin":"other","text":"f"}\n', 'utf8');
  check('补齐后立刻出现（半行没丢）',
    inc.readEvents().length === 6 && inc.readEvents().some((e) => e.id === 'ev_f'));

  inc.markSynced([{ id: 'ev_d', epoch: 3, seq: 30 }]);
  const syncedEv = inc.readEvents().find((e) => e.id === 'ev_d');
  check('markSynced 就地补戳、不整份重读',
    syncedEv?.seq === 30 && inc.stats().fullReads === 1,
    JSON.stringify({ seq: syncedEv?.seq, ...inc.stats() }));

  // 文件末尾没有换行（手工编辑 / 外部工具写出来的）：最后一条不能永久卡在 tail 里
  const noEolLog = join(incDir, 'noeol.jsonl');
  writeFileSync(noEolLog,
    JSON.stringify({ id: 'ev_noeol', kind: 'msg', origin: 'self', text: 'x' }), 'utf8');
  const noEol = createStore({
    logPath: noEolLog,
    seqFile: join(incDir, '.noeol-synced.json'),
    rejectedFile: null,
    origin: () => 'self',
    nameOf: () => '我',
    maxEventsOf: () => 5000,
    localIso: () => new Date().toISOString(),
  });
  check('末尾缺换行时最后一条照样读得到',
    noEol.readEvents().length === 1, String(noEol.readEvents().length));

  console.log('\n12k. 裁剪按余量摊薄，不是每条都重写整份日志');
  const trimLog = join(incDir, 'trim.jsonl');
  const trim = createStore({
    logPath: trimLog,
    seqFile: join(incDir, '.trim-synced.json'),
    rejectedFile: join(incDir, '.trim-rejected.json'),
    origin: () => 'self',
    nameOf: () => '我',
    maxEventsOf: () => 10,
    localIso: () => new Date().toISOString(),
  });
  for (let i = 0; i < 80; i += 1) trim.appendEvent({ kind: 'msg', text: `m${i}` });
  const trimStats = trim.stats();
  const trimEvents = trim.readEvents();
  check('80 条追加只触发少量全量重写', trimStats.fullReads <= 5, JSON.stringify(trimStats));
  check('追加路径不再有增量读（都走缓存）', trimStats.incrReads === 0, JSON.stringify(trimStats));
  check('裁剪后不超过「上限 + 余量」', trimEvents.length <= 61, String(trimEvents.length));
  check('最新一条还在（裁的是老的）', trimEvents[trimEvents.length - 1]?.text === 'm79',
    String(trimEvents[trimEvents.length - 1]?.text));

  rmSync(incDir, { recursive: true, force: true });

  console.log('\n13. 卸载');
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
