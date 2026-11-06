/**
 * Hub 端到端测试 —— 起真服务、走真 HTTP，不用桩。
 *
 * 覆盖：
 *   1. /info 探活（不要 token）
 *   2. join 换 token；错口令被拒
 *   3. 推事件 → Hub 分配 (epoch, seq) → 别的成员拉得到
 *   4. 同 id 重投不重复编号（幂等）
 *   5. 认领串行：第二个人拿 conflict
 *   6. 认领幂等：同一个 claimId 再来一次，返回上次结果
 *   7. 依赖未完成 → blocked（和 conflict 分开）
 *   8. 租约：leaseMs 越界 → bad-param；0 = 不开租约
 *   9. 成员不能伪造 claimedAt（403）
 *  10. 重启后 seq 接续（不倒退、不重号）
 *
 * 跑：node test/hub.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startHub, leaseEndAt, leaseRenewAt } from '../src/host/hub.mjs';
import { broadcastTargets, signPacket, createHubWatch, createDiscovery } from '../src/host/discovery.mjs';

const GROUP = 'a1b2c3d4e5f60718';
const ORIGIN_A = '1111111111111111';
const ORIGIN_B = '2222222222222222';
const ORIGIN_C = '3333333333333333';

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

async function call(base, path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/collab/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  return { status: res.status, ...payload };
}

function dir() {
  return mkdtempSync(join(tmpdir(), 'collab-hub-'));
}

async function main() {
  const dataDir = dir();
  console.log(`数据目录：${dataDir}\n`);

  let hub = await startHub({
    dir: dataDir,
    groupId: GROUP,
    origin: ORIGIN_A,
    name: '测试 Hub',
    port: 0,
    code: 'LOVE',
    log: () => {},
  });
  const base = `http://127.0.0.1:${hub.info.port}`;

  console.log('1. 探活与加入');
  const info = await call(base, '/info');
  check('/info 不用 token', info.ok === true && info.data.groupId === GROUP);
  check('/info 带 epoch/headSeq', Number.isInteger(info.data.epoch) && Number.isInteger(info.data.headSeq));

  const badJoin = await call(base, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'WRONG' },
  });
  check('错口令拒（bad-code）', badJoin.status === 401 && badJoin.error.code === 'bad-code');

  const joinA = await call(base, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_A, name: 'A', code: 'LOVE' },
  });
  const joinB = await call(base, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE', capabilities: ['gpu', 'python'] },
  });
  const joinC = await call(base, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_C, name: 'C', code: 'LOVE' },
  });
  check('三个成员都换到 token', Boolean(joinA.data?.token && joinB.data?.token && joinC.data?.token));

  const tokenA = joinA.data.token;
  const tokenB = joinB.data.token;
  const tokenC = joinC.data.token;

  console.log('\n2. 推事件与拉取');
  const taskEv = {
    eventVersion: 2,
    id: 'ev_aaaaaa_t1k00001_aaa',
    origin: ORIGIN_A,
    name: 'A',
    ts: new Date().toISOString(),
    kind: 'task',
    taskId: 't1',
    title: '把插件装到姐姐那台',
    status: 'pending',
    detail: '离线包 + 安装说明',
    requiredCapabilities: ['gpu', 'ffmpeg'],
    priority: 'high',
  };
  const pushA = await call(base, '/events', { method: 'POST', token: tokenA, body: { events: [taskEv] } });
  check('A 推任务卡成功', pushA.ok === true && pushA.data.accepted.length === 1);
  check('Hub 分配了 epoch/seq', pushA.data.accepted[0].seq >= 1 && pushA.data.accepted[0].epoch >= 1);

  const pullB = await call(base, '/events?since=0', { token: tokenB });
  check('B 拉得到任务卡', pullB.data.events.some((e) => e.taskId === 't1'));

  // 幂等重投
  const repush = await call(base, '/events', { method: 'POST', token: tokenA, body: { events: [taskEv] } });
  check('同 id 重投不重复编号', repush.data.accepted[0].duplicate === true);
  // duplicate 必须把原来的 epoch/seq 一起回 —— 否则客户端拿不到序号，
  // 在它的本地 sidecar 里这条永远是「待同步」（R10 真机实测的第二个 bug）
  check('duplicate 带回 epoch/seq',
    Number.isFinite(repush.data.accepted[0].epoch) && Number.isFinite(repush.data.accepted[0].seq),
    JSON.stringify(repush.data.accepted[0]));
  check('duplicate 回的 seq 是原事件的，不是新编号',
    repush.data.accepted[0].seq === pushA.data.accepted[0].seq,
    `${repush.data.accepted[0].seq} vs ${pushA.data.accepted[0].seq}`);

  console.log('\n3. 认领串行');
  const claimB = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenB,
    body: { taskId: 't1', claimId: 'cl_b_1', leaseMs: 600000 },
  });
  check('B 认领成功', claimB.ok === true && claimB.data.taskId === 't1');
  check('warnings 按 requiredCapabilities 原顺序', JSON.stringify(claimB.data.warnings) === JSON.stringify(['缺 ffmpeg']),
    JSON.stringify(claimB.data.warnings));
  check('matchedMembers 只含具备全部标签的人', Array.isArray(claimB.data.matchedMembers));

  const claimC = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenC,
    body: { taskId: 't1', claimId: 'cl_c_1' },
  });
  check('C 再认领 → conflict', claimC.status === 409 && claimC.error.code === 'conflict');
  check('conflict 带 owner', claimC.error.owner === ORIGIN_B);

  const claimAgain = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenB,
    body: { taskId: 't1', claimId: 'cl_b_1' },
  });
  check('同 claimId 重来 → 幂等返回', claimAgain.ok === true && claimAgain.data.idempotent === true);

  console.log('\n4. 参数与权限');
  const badLease = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenB,
    body: { taskId: 't1', leaseMs: 999999999 },
  });
  check('leaseMs 越界 → bad-param', badLease.status === 400 && badLease.error.code === 'bad-param');
  check('bad-param 带 field', badLease.error.field === 'leaseMs');

  const forge = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00009_zzz',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 't2',
        title: '伪造认领',
        claimedAt: new Date().toISOString(),
        leaseMs: 600000,
      }],
    },
  });
  check('成员伪造 claimedAt → 403', forge.status === 403 && forge.error.code === 'forbidden');
  check('403 带 field', forge.error.field === 'claimedAt');

  const wrongOrigin = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: { events: [{ id: 'ev_bbbbbb_t1k00002_bbb', origin: ORIGIN_B, kind: 'note', text: '冒名' }] },
  });
  check('事件 origin 与 token 不符 → 403', wrongOrigin.status === 403);

  console.log('\n5. 依赖阻塞');
  await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00003_ccc',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 't3',
        title: '依赖 t1',
        // §6.9：创建时依赖未完成 → status 必须是 blocked（客户端自动置）
        status: 'blocked',
        dependsOn: ['t1'],
      }],
    },
  });
  const claimBlocked = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenC,
    body: { taskId: 't3', claimId: 'cl_c_3' },
  });
  check('依赖未完成 → blocked', claimBlocked.status === 409 && claimBlocked.error.code === 'blocked');
  check('blocked 带 blockedBy', JSON.stringify(claimBlocked.error.blockedBy) === JSON.stringify(['t1']));

  console.log('\n5b. 依赖环检测');
  const cyc1 = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: { events: [{ id: 'ev_aaaaaa_t1k00004_ddd', origin: ORIGIN_A, kind: 'task', taskId: 'c1', title: '环1', status: 'pending', dependsOn: ['c2'] }] },
  });
  check('依赖还不存在的任务：允许', cyc1.ok === true, JSON.stringify(cyc1).slice(0, 100));

  const cyc2 = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: { events: [{ id: 'ev_aaaaaa_t1k00005_eee', origin: ORIGIN_A, kind: 'task', taskId: 'c2', title: '环2', status: 'blocked', dependsOn: ['c1'] }] },
  });
  check('反向依赖成环 → cycle 400', cyc2.status === 400 && cyc2.error.code === 'cycle', JSON.stringify(cyc2.error));

  const cyc3 = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: { events: [{ id: 'ev_aaaaaa_t1k00006_fff', origin: ORIGIN_A, kind: 'task', taskId: 'c3', title: '自环', status: 'blocked', dependsOn: ['c3'] }] },
  });
  check('自环 → cycle 400', cyc3.status === 400 && cyc3.error.code === 'cycle', JSON.stringify(cyc3.error));

  console.log('\n5c. 依赖自动解锁');
  const doneT1 = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_t1k00007_ggg',
        origin: ORIGIN_B,
        name: 'B',
        kind: 'task',
        taskId: 't1',
        title: '把插件装到姐姐那台',
        status: 'done',
        owner: ORIGIN_B,
      }],
    },
  });
  check('B 把 t1 标完成', doneT1.ok === true, JSON.stringify(doneT1.error || doneT1).slice(0, 300));

  const pullAfterDone = await call(base, '/events?since=0', { token: tokenC });
  const t3Events = pullAfterDone.data.events
    // 只看 task 事件：解锁现在会额外写一条 msg（0.10.15），不该混进「最新状态」
    .filter((e) => e.taskId === 't3' && e.kind === 'task')
    .sort((a, b) => (a.seq - b.seq));
  const t3Latest = t3Events[t3Events.length - 1];
  check('t3 自动 blocked → pending', t3Latest && t3Latest.status === 'pending',
    t3Latest ? t3Latest.status : '没有 t3 事件');
  check('解锁写了系统 note',
    pullAfterDone.data.events.some((e) => e.kind === 'note' && e.origin === '0000000000000000' && String(e.text).includes('t3')));
  check('解锁事件是系统 origin', t3Latest && t3Latest.origin === '0000000000000000', t3Latest && t3Latest.origin);

  // 0.10.15：解锁要真的把人叫醒 —— 系统 msg，定向 to，不是广播
  const unlockMsgs = pullAfterDone.data.events.filter(
    (e) => e.kind === 'msg' && e.taskId === 't3' && e.origin === '0000000000000000',
  );
  check('解锁发了一条系统 msg（叫醒下游）', unlockMsgs.length === 1, String(unlockMsgs.length));
  const unlockMsg = unlockMsgs[0];
  check('这条 msg 指向 t3 的创建者 A', Boolean(unlockMsg) && unlockMsg.to === ORIGIN_A,
    unlockMsg ? String(unlockMsg.to) : '没有 msg');
  check('这条 msg 不是广播（to 非空）', Boolean(unlockMsg) && Boolean(unlockMsg.to));
  check('这条 msg 带得上 taskId（能挂回卡上）', Boolean(unlockMsg) && unlockMsg.taskId === 't3');

  const t3CountBefore = t3Events.length;
  const msgCountBefore = pullAfterDone.data.events.filter((e) => e.kind === 'msg' && e.taskId === 't3').length;
  await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_t1k00008_hhh',
        origin: ORIGIN_B,
        name: 'B',
        kind: 'task',
        taskId: 't1',
        title: '把插件装到姐姐那台',
        status: 'done',
        owner: ORIGIN_B,
      }],
    },
  });
  const pullAgain = await call(base, '/events?since=0', { token: tokenC });
  const t3CountAfter = pullAgain.data.events.filter((e) => e.taskId === 't3' && e.kind === 'task').length;
  check('重复 done 不重复解锁（条件二）', t3CountAfter === t3CountBefore, `${t3CountBefore} → ${t3CountAfter}`);
  const msgCountAfter = pullAgain.data.events.filter((e) => e.kind === 'msg' && e.taskId === 't3').length;
  check('重复 done 不重复发唤醒 msg', msgCountAfter === msgCountBefore, `${msgCountBefore} → ${msgCountAfter}`);

  const badTo = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: { events: [{ id: 'ev_aaaaaa_t1k00009_iii', origin: ORIGIN_A, kind: 'msg', text: 'to 不合法', to: 'not-a-hex-origin' }] },
  });
  check('msg 的 to 不是合法 origin → 400', badTo.status === 400, JSON.stringify(badTo.error));

  console.log('\n5d. owner 旁路：普通写不许抢已认领的卡');  // 认领本来走 /tasks/claim 的串行 CAS，但普通 task 事件也能写 owner ——
  // 不堵住的话，任何人推一条事件就能把别人的卡抢走。
  await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00009_ooo',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own1',
        title: 'owner 旁路测试卡',
        status: 'pending',
      }],
    },
  });
  const claimOwn = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenB,
    body: { taskId: 'own1', claimId: 'cl_own_b' },
  });
  check('B 认领了 own1', claimOwn.ok === true, JSON.stringify(claimOwn.error));

  const steal = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00010_sss',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own1',
        title: '抢过来',
        status: 'running',
        owner: ORIGIN_A,
      }],
    },
  });
  check('普通写抢别人认领的卡 → 403', steal.status === 403 && steal.error.code === 'forbidden',
    JSON.stringify(steal.error));
  check('403 带 field=owner', steal.error.field === 'owner');

  // 改标题时不该被迫带上 owner，也不该因为没带就被当成「释放」
  const editNoOwner = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00011_ttt',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own1',
        title: '改了标题',
        status: 'running',
      }],
    },
  });
  check('不带 owner 的改标题：放行', editNoOwner.ok === true, JSON.stringify(editNoOwner.error));
  const pullOwn = await call(base, '/events?since=0', { token: tokenC });
  const ownLatest = pullOwn.data.events
    .filter((e) => e.taskId === 'own1')
    .sort((a, b) => a.seq - b.seq)
    .pop();
  check('owner 被继承，没被清掉', ownLatest && ownLatest.owner === ORIGIN_B, ownLatest && ownLatest.owner);

  const releaseOther = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00012_uuu',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own1',
        title: '改了标题',
        status: 'running',
        owner: '',
      }],
    },
  });
  check('替别人释放 → 403', releaseOther.status === 403);

  const releaseSelf = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_t1k00013_vvv',
        origin: ORIGIN_B,
        kind: 'task',
        taskId: 'own1',
        title: '改了标题',
        status: 'pending',
        owner: '',
      }],
    },
  });
  check('自己释放自己认领的卡：放行', releaseSelf.ok === true, JSON.stringify(releaseSelf.error));

  console.log('\n5b. 身份撞号：taskId 归创建者');
  const mkOwn2 = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00014_www',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own2',
        title: 'A 的卡',
        detail: '原描述',
        status: 'pending',
      }],
    },
  });
  check('A 建 own2', mkOwn2.ok === true, JSON.stringify(mkOwn2.error));

  const clobber = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_t1k00015_xxx',
        origin: ORIGIN_B,
        kind: 'task',
        taskId: 'own2',
        title: 'B 想整条覆盖',
        status: 'pending',
      }],
    },
  });
  check('非创建者改标题 → 409 conflict', clobber.status === 409 && clobber.error.code === 'conflict',
    JSON.stringify(clobber.error));
  check('409 带 field=taskId', clobber.error.field === 'taskId');

  const doneByB = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_t1k00016_yyy',
        origin: ORIGIN_B,
        kind: 'task',
        taskId: 'own2',
        title: 'A 的卡',
        detail: '原描述',
        status: 'done',
      }],
    },
  });
  check('非创建者标完成（标题没动）→ 放行', doneByB.ok === true, JSON.stringify(doneByB.error));

  const renameByA = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00017_zzz',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own2',
        title: 'A 改了标题',
        detail: '原描述',
        status: 'done',
      }],
    },
  });
  check('创建者改自己的卡 → 放行', renameByA.ok === true, JSON.stringify(renameByA.error));

  console.log('\n5e. 租约续约（0.10.13）');
  // 纯算法：不依赖计时器，先把边界定死
  const t0 = '2026-01-01T00:00:00.000Z';
  const t0ms = new Date(t0).getTime();
  check('终点 = 认领时间 + 时长', leaseEndAt({ claimedAt: t0, leaseMs: 60000 }) === t0ms + 60000);
  check('续约水印晚于认领终点时取水印',
    leaseEndAt({ claimedAt: t0, leaseMs: 60000, renewedUntil: t0ms + 180000 }) === t0ms + 180000);
  check('续约不越过 4 倍上限',
    leaseRenewAt({ claimedAt: t0, leaseMs: 60000, now: t0ms + 230000 }) === t0ms + 240000);
  check('续约 = 现在 + 时长（没到上限时）',
    leaseRenewAt({ claimedAt: t0, leaseMs: 60000, now: t0ms + 30000 }) === t0ms + 90000);
  check('没开租约的卡不算终点', leaseEndAt({ claimedAt: t0, leaseMs: 0 }) === 0);

  // 真行为：短租约的 Hub，进度推上来要能续命
  const leaseDir = dir();
  const leaseHub = await startHub({
    dir: leaseDir,
    groupId: GROUP,
    origin: ORIGIN_C,
    name: '租约 Hub',
    port: 0,
    log: () => {},
    leaseTickMs: 50,
    noDiscovery: true,
  });
  const leaseBase = `http://127.0.0.1:${leaseHub.info.port}`;
  const lj = await call(leaseBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_A, name: 'A', code: '' },
  });
  const lTok = lj.data.token;
  await call(leaseBase, '/events', {
    method: 'POST',
    token: lTok,
    body: {
      events: [{
        eventVersion: 2,
        id: 'ev_lease_t1_000001',
        origin: ORIGIN_A,
        name: 'A',
        ts: new Date().toISOString(),
        kind: 'task',
        taskId: 't-lease',
        title: '长任务：不许做到一半被抢走',
        status: 'pending',
        detail: '',
        owner: '',
      }],
    },
  });
  const claimed = await call(leaseBase, '/tasks/claim', {
    method: 'POST',
    token: lTok,
    body: { taskId: 't-lease', leaseMs: 800 },
  });
  check('短租约认领成功', claimed.ok === true, JSON.stringify(claimed.error));

  const latestTask = async () => {
    const r = await call(leaseBase, '/events?since=0&limit=500', { token: lTok });
    const rows = (r.data?.events || []).filter((e) => e.kind === 'task' && e.taskId === 't-lease');
    return rows.sort((a, b) => (a.seq || 0) - (b.seq || 0)).pop() || null;
  };

  // 800ms 的租约过 600ms 再推进度：续到 600+800=1400，比原来 800 的终点晚
  await new Promise((r) => setTimeout(r, 600));
  await call(leaseBase, '/events', {
    method: 'POST',
    token: lTok,
    body: {
      events: [{
        eventVersion: 2,
        id: 'ev_lease_p1_000001',
        origin: ORIGIN_A,
        name: 'A',
        ts: new Date().toISOString(),
        kind: 'progress',
        taskId: 't-lease',
        done: 1,
        total: 2,
        note: '干到一半',
      }],
    },
  });
  await new Promise((r) => setTimeout(r, 250));
  const savedState = JSON.parse(readFileSync(join(leaseDir, 'hub.json'), 'utf8'));
  const savedLease = (savedState.leases || []).find((l) => l.taskId === 't-lease');
  check('续约水印落盘了（重启才认得出长任务）', Boolean(savedLease) && savedLease.until > 0,
    JSON.stringify(savedLease || null));

  await new Promise((r) => setTimeout(r, 500));
  const midway = await latestTask();
  check('写过进度 → 过了原租约也没被释放', Boolean(midway && midway.status === 'running'),
    JSON.stringify(midway?.status));

  await new Promise((r) => setTimeout(r, 1400));
  const expired = await latestTask();
  check('续约也会到期 → 照样退回待认领，不无限续',
    Boolean(expired && expired.status === 'pending'), JSON.stringify(expired?.status));

  const leaseLog = readFileSync(join(leaseDir, 'hub-events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  check('释放前先发过「租约快到期」提醒',
    leaseLog.some((e) => e.kind === 'note' && String(e.text).includes('租约还剩')));
  check('提醒是 warn 级', leaseLog.some((e) => e.kind === 'note' && e.level === 'warn'));
  await leaseHub.controller.close();
  rmSync(leaseDir, { recursive: true, force: true });

  console.log('\n5f. 墓碑删除（0.10.14）');
  // 一张带敏感正文的卡，由 A 创建
  const tombCreated = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        eventVersion: 2,
        id: 'ev_tomb_create_000001',
        origin: ORIGIN_A,
        name: 'A',
        ts: new Date().toISOString(),
        kind: 'task',
        taskId: 't-tomb',
        title: '机密标题不该留',
        status: 'pending',
        detail: '机密描述也不该留',
        tags: ['敏感'],
      }],
    },
  });
  check('待删的卡建好了', tombCreated.ok === true, JSON.stringify(tombCreated.error));

  // 由 B（不是创建者）来删：墓碑必须豁免「非创建者不能改标题」这条
  const tombEv = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        eventVersion: 2,
        id: 'ev_tomb_live_000001',
        origin: ORIGIN_B,
        name: 'B',
        ts: new Date().toISOString(),
        kind: 'task',
        taskId: 't-tomb',
        title: '',
        status: 'cancelled',
        deleted: true,
        deletedAt: new Date().toISOString(),
      }],
    },
  });
  check('别人也能删（墓碑豁免改标题保护）', tombEv.ok === true, JSON.stringify(tombEv.error));

  const tombDump = await call(base, '/events?since=0&limit=500', { token: tokenA });
  const tombRows = (tombDump.data?.events || []).filter((e) => e.kind === 'task' && e.taskId === 't-tomb');
  check('该卡的历史事件还在（不删行）', tombRows.length >= 2, String(tombRows.length));
  check('历史正文已擦空', tombRows.every((e) => !String(e.title || '').includes('机密标题')),
    JSON.stringify(tombRows.map((e) => e.title)));
  check('墓碑带 deletedAt / 谁删的', tombRows.some((e) => e.deleted === true && e.deletedAt && e.origin === ORIGIN_B));

  const rawHub = readFileSync(join(dataDir, 'hub-events.jsonl'), 'utf8');
  check('Hub 日志文件里搜不到原文', !rawHub.includes('机密标题') && !rawHub.includes('机密描述'));

  // 已删除的卡不能再认领
  const claimDeleted = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenC,
    body: { taskId: 't-tomb', leaseMs: 0 },
  });
  check('已删除的卡拒绝认领', claimDeleted.status === 409, JSON.stringify(claimDeleted.error));

  console.log('\n6. 重启接续');
  const beforeSeq = hub.controller.info().headSeq;
  const beforeEpoch = hub.controller.info().epoch;
  await hub.controller.close();

  hub = await startHub({
    dir: dataDir,
    groupId: GROUP,
    origin: ORIGIN_A,
    name: '测试 Hub',
    port: 0,
    code: 'LOVE',
    log: () => {},
  });
  const base2 = `http://127.0.0.1:${hub.info.port}`;
  const after = hub.controller.info();
  check('重启后 epoch 不变', after.epoch === beforeEpoch, `${beforeEpoch} → ${after.epoch}`);
  check('重启后 headSeq 不倒退', after.headSeq >= beforeSeq, `${beforeSeq} → ${after.headSeq}`);
  check('重启后日志还在', after.events >= 3, String(after.events));

  const info2 = await call(base2, '/info');
  check('重启后 /info 可用', info2.ok === true);

  // 重新 join（token 是内存态，重启后失效 —— 这是设计）
  const rejoin = await call(base2, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
  });
  check('重启后要重新 join', Boolean(rejoin.data?.token));

  const oldToken = await call(base2, '/events?since=0', { token: tokenB });
  check('旧 token 失效 → 401', oldToken.status === 401);

  console.log('\n7. 启动探测（P0-3b）');
  const otherDir = dir();
  let rejected = null;
  try {
    await startHub({
      dir: otherDir,
      groupId: GROUP,
      origin: ORIGIN_C,
      port: 0,
      probeUrl: base2,
      log: () => {},
    });
  } catch (e) {
    rejected = e;
  }
  check('同组已有 Hub → 拒绝起第二个', Boolean(rejected) && rejected.code === 'already-running',
    rejected ? rejected.message : '居然起来了');
  rmSync(otherDir, { recursive: true, force: true });

  const forcedDir = dir();
  let forced = null;
  try {
    forced = await startHub({
      dir: forcedDir,
      groupId: GROUP,
      origin: ORIGIN_C,
      port: 0,
      probeUrl: base2,
      force: true,
      log: () => {},
    });
  } catch { /* 强起不该失败 */ }
  check('force=true 能强起', Boolean(forced));
  if (forced) await forced.controller.close();
  rmSync(forcedDir, { recursive: true, force: true });

  await hub.controller.close();
  rmSync(dataDir, { recursive: true, force: true });

  console.log('\n8. 文件配额与引用裁剪（§17 决策 5）');
  const quotaDir = dir();
  const quotaHub = await startHub({
    dir: quotaDir,
    groupId: GROUP,
    origin: ORIGIN_A,
    port: 0,
    code: 'LOVE',
    maxStoreBytes: 1000, // 小配额，逼出裁剪
    log: () => {},
  });
  const qBase = `http://127.0.0.1:${quotaHub.info.port}`;
  const qJoin = await call(qBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
  });
  const qToken = qJoin.data.token;

  const mkBuf = (size, ch) => Buffer.alloc(size, ch);
  const shaOf = (b) => createHash('sha256').update(b).digest('hex');
  const upload = (buf, name) => call(qBase, '/files', {
    method: 'POST',
    token: qToken,
    body: { name, sha256: shaOf(buf), size: buf.length, data: buf.toString('base64') },
  });

  const fileA = mkBuf(600, 'a');
  const upA = await upload(fileA, 'a.bin');
  check('第一个文件传上去', upA.ok === true, String(JSON.stringify(upA.error)).slice(0, 120));

  // A 没被任何 artifact 引用 → 可以裁
  const fileB = mkBuf(600, 'b');
  const upB = await upload(fileB, 'b.bin');
  check('配额满时裁掉未引用的旧文件', upB.ok === true, String(JSON.stringify(upB.error)).slice(0, 120));

  const aId = shaOf(fileA).slice(0, 32);
  const aAfter = await call(qBase, `/files/${aId}`, { token: qToken });
  check('旧文件确实被裁掉了', aAfter.status === 404, String(aAfter.status));

  // 现在 B 占了 500；把它标成被引用，再传一个必须裁 B 的文件
  const bId = shaOf(fileB).slice(0, 32);
  await call(qBase, '/events', {
    method: 'POST',
    token: qToken,
    body: {
      events: [{
        id: 'ev_bbbbbb_t1k00010_qqq',
        origin: ORIGIN_B,
        name: 'B',
        kind: 'artifact',
        taskId: 'x1',
        path: 'b.bin',
        transfer: { mode: 'hub', fileId: bId, size: 600, name: 'b.bin' },
      }],
    },
  });

  const fileC = mkBuf(600, 'c');
  const upC = await upload(fileC, 'c.bin');
  check('剩下都被引用 → 507 而不是裁掉在用的', upC.status === 507 && upC.error.code === 'insufficient-storage',
    String(JSON.stringify(upC.error)).slice(0, 120));

  const bStill = await call(qBase, `/files/${bId}`, { token: qToken });
  check('被引用的文件还在', bStill.status === 200, String(bStill.status));

  await quotaHub.controller.close();
  rmSync(quotaDir, { recursive: true, force: true });

  console.log('\n9. 发现与双 Hub 告警（§8 / §12.4.1）');
  const targets = broadcastTargets();
  check('广播目标含全局广播地址', targets.includes('255.255.255.255'), targets.join(','));
  check('签名是确定的',
    signPacket('k', { groupId: 'a', origin: 'b', port: 1, epoch: 1 })
    === signPacket('k', { groupId: 'a', origin: 'b', port: 1, epoch: 1 }));
  check('无口令不签名', signPacket('', { groupId: 'a', origin: 'b', port: 1, epoch: 1 }) === '');

  const forked = [];
  const watch = createHubWatch({ threshold: 2, minDurationMs: 50, onFork: (i) => forked.push(i) });
  watch.observe({ origin: 'e'.repeat(16), host: '10.0.0.9', port: 48910 }, 1000);
  check('1 次广播不够门槛', forked.length === 0);
  watch.observe({ origin: 'e'.repeat(16), host: '10.0.0.9', port: 48910 }, 1100);
  check('2 次 + 持续 100ms → 触发', forked.length === 1, JSON.stringify(forked));
  watch.observe({ origin: 'e'.repeat(16), host: '10.0.0.9', port: 48910 }, 1200);
  check('同一 origin 不重复告警', forked.length === 1);

  const discDir = dir();
  const discHub = await startHub({
    dir: discDir,
    groupId: GROUP,
    origin: ORIGIN_A,
    port: 0,
    noDiscovery: true, // 同机测试不开 UDP，避免端口冲突；直接喂广播
    watchThreshold: 2,
    watchMinDurationMs: 50,
    log: () => {},
  });
  check('刚起时没有分叉', discHub.controller.fork() === null);

  const fakePeer = { origin: 'eeeeeeeeeeeeeeee', name: '另一个 Hub', host: '10.0.0.9', port: 48910, epoch: 1 };
  discHub.controller.observePeer(fakePeer, 1000);
  check('喂 1 次还不告警', discHub.controller.fork() === null);
  discHub.controller.observePeer(fakePeer, 1100);
  const forkState = discHub.controller.fork();
  check('喂 2 次 → 判定双 Hub', Boolean(forkState) && forkState.origin === fakePeer.origin,
    JSON.stringify(forkState));

  const discLog = readFileSync(join(discDir, 'hub-events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  check('写了系统告警 note',
    discLog.some((e) => e.kind === 'note' && e.origin === '0000000000000000' && String(e.text).includes('复活')));
  check('告警是 warn 级', discLog.some((e) => e.kind === 'note' && e.level === 'warn'));

  discHub.controller.clearFork();
  check('「忽略」后清掉状态', discHub.controller.fork() === null);
  await discHub.controller.close();
  rmSync(discDir, { recursive: true, force: true });

  // 真实 UDP：一个听、一个发，走回环，验证包格式和接收都通
  const recv = await createDiscovery({
    groupId: GROUP, origin: 'c'.repeat(16), discoveryPort: 0, quiet: true, log: () => {},
  });
  const sender = await createDiscovery({
    groupId: GROUP, origin: 'd'.repeat(16), name: '发送方', port: 48910,
    discoveryPort: 0, quiet: false, targets: ['127.0.0.1'], targetPort: recv.port, log: () => {},
  });
  await new Promise((r) => setTimeout(r, 400));
  const heard = recv.allPeers();
  check('真实 UDP 收到对方广播', heard.length >= 1, `${heard.length} 个`);
  check('广播里带齐字段',
    Boolean(heard[0] && heard[0].origin === 'd'.repeat(16) && heard[0].port === 48910 && heard[0].host),
    JSON.stringify(heard[0] || {}));
  await sender.close();
  await recv.close();

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自己炸了：', e);
  process.exitCode = 1;
});
