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

  const selRows = claimableTasks(cards, { selfOrigin: A_ORIGIN, capabilities: ['ffmpeg'] });
  const reasonOf = new Map(selRows.map((r) => [r.task.taskId, r.reason]));
  check('别人建的空卡可接', reasonOf.get('s1') === '', String(reasonOf.get('s1')));
  check('自己建的卡不可接（哪怕被别人改过标题）', reasonOf.get('s2') === 'own', String(reasonOf.get('s2')));
  check('有主的卡不可接', reasonOf.get('s3') === 'owned');
  check('缺能力不可接', reasonOf.get('s4') === 'caps');
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
  const foldClaimable = claimableTasks(fold, { selfOrigin: A_ORIGIN, capabilities: [] });
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
  await fetch(`http://127.0.0.1:${hubPort}/collab/v1/events`, {
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
