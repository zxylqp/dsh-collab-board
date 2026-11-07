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
import { createSocket } from 'node:dgram';
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
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
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

  /**
   * `eventsSince` 是 `role === 'hub'` 时面板/agent 的视图源（0.11.3）。
   *
   * 单独立一条的理由：宿主侧调它时包了 try/catch（读不到就退回本机日志，
   * 宁可视图旧一点也别让面板白掉）—— 那个兜底会把「访问器被删掉或改名」
   * 静默退化成老 bug（本机日志残缺 → 任务列表空白）。这里钉死契约。
   */
  const viewAll = hub.controller.eventsSince(0);
  const viewFrom1 = hub.controller.eventsSince(1);
  const hubTotal = hub.controller.info().events;
  check('eventsSince(0) 给出 Hub 内存里的全量', viewAll.length === hubTotal && hubTotal >= 1,
    `${viewAll.length} vs ${hubTotal}`);
  check('eventsSince(n) 跳过前 n 条', viewFrom1.length === hubTotal - 1,
    `${viewFrom1.length} vs ${hubTotal}`);
  check('eventsSince 返回副本：改它不影响 Hub 自己那份', (() => {
    viewFrom1.push({ kind: 'msg', text: '不该进 Hub' });
    return hub.controller.info().events === hubTotal;
  })());

  console.log('\n3. 认领串行');
  const claimB = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenB,
    body: { taskId: 't1', claimId: 'cl_b_1', leaseMs: 600000 },
  });
  check('B 认领成功', claimB.ok === true && claimB.data.taskId === 't1');
  // 能力标签已删（0.11.1）：老 peer 发的 requiredCapabilities 照收不误（字段兼容），
  // 但认领结果里不再有 warnings / matchedMembers —— 没人消费，留着只会误导。
  check('认领返回不再带 warnings', claimB.data.warnings === undefined, JSON.stringify(claimB.data.warnings));
  check('认领返回不再带 matchedMembers', claimB.data.matchedMembers === undefined,
    JSON.stringify(claimB.data.matchedMembers));

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

  console.log('\n5d2. 只改状态的事件不抹掉其他字段（0.11.10）');
  /**
   * 汐汐 2026-11-07 实测：done 事件只带 title/status/taskId，
   * Hub 折叠用 `{...ev}` → owner/detail/tags 全被清，collab_state 的 mine 里当场少一张。
   * task 事件是增量覆盖，没带的字段应该从上一版继承。
   */
  await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_full00001_aaa',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'full1',
        title: '全字段卡',
        detail: '描述不能丢',
        tags: ['甲', '乙'],
        priority: 'high',
        status: 'pending',
      }],
    },
  });
  const claimFull = await call(base, '/tasks/claim', {
    method: 'POST',
    token: tokenB,
    body: { taskId: 'full1' },
  });
  check('B 认领 full1', claimFull.ok === true, JSON.stringify(claimFull.error));

  const fullAfterClaim = hub.controller.tasks().find((t) => t.taskId === 'full1');
  check('认领后 detail/tags 没被抹掉',
    fullAfterClaim && fullAfterClaim.detail === '描述不能丢'
      && Array.isArray(fullAfterClaim.tags) && fullAfterClaim.tags.length === 2,
    JSON.stringify({ detail: fullAfterClaim?.detail, tags: fullAfterClaim?.tags }));

  // 只带 title + status 的 done（不带 owner，也不带 detail/tags）
  await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_full00002_bbb',
        origin: ORIGIN_B,
        kind: 'task',
        taskId: 'full1',
        title: '全字段卡',
        status: 'done',
      }],
    },
  });
  const fullDone = hub.controller.tasks().find((t) => t.taskId === 'full1');
  check('done 后 owner 还在', fullDone && fullDone.owner === ORIGIN_B, String(fullDone?.owner));
  check('done 后 detail/tags/priority 还在',
    fullDone && fullDone.detail === '描述不能丢'
      && Array.isArray(fullDone.tags) && fullDone.tags.length === 2
      && fullDone.priority === 'high',
    JSON.stringify({ detail: fullDone?.detail, tags: fullDone?.tags, priority: fullDone?.priority }));

  console.log('\n5d3. done 只许 owner 或创建者写（0.11.11）');
  await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_perm00001_aaa',
        origin: ORIGIN_A, kind: 'task', taskId: 'perm1', title: '完成权限卡', status: 'pending',
      }],
    },
  });
  await call(base, '/tasks/claim', { method: 'POST', token: tokenB, body: { taskId: 'perm1' } });

  // C 既不是 owner（B）也不是创建者（A）→ 拒
  const doneByC = await call(base, '/events', {
    method: 'POST',
    token: tokenC,
    body: {
      events: [{
        id: 'ev_cccccc_perm00002_ccc',
        origin: ORIGIN_C, kind: 'task', taskId: 'perm1', title: '完成权限卡', status: 'done',
      }],
    },
  });
  check('C 替别人标 done → 403 forbidden',
    doneByC.status === 403 && doneByC.error.code === 'forbidden',
    JSON.stringify(doneByC.error || doneByC));
  check('403 指向 status 字段', doneByC.error?.field === 'status');

  const doneByOwner = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_perm00003_bbb',
        origin: ORIGIN_B, kind: 'task', taskId: 'perm1', title: '完成权限卡', status: 'done',
      }],
    },
  });
  check('owner B 标 done → 放行', doneByOwner.ok === true, JSON.stringify(doneByOwner.error));

  // 创建者也可以替自己派的活收尾
  await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_perm00004_bbb',
        origin: ORIGIN_B, kind: 'task', taskId: 'perm2', title: 'B 建的卡', status: 'pending',
      }],
    },
  });
  await call(base, '/tasks/claim', { method: 'POST', token: tokenA, body: { taskId: 'perm2' } });
  const doneByCreator = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        id: 'ev_bbbbbb_perm00005_bbb',
        origin: ORIGIN_B, kind: 'task', taskId: 'perm2', title: 'B 建的卡', status: 'done',
      }],
    },
  });
  check('创建者 B 标 A 的卡 done → 放行（创建者有权收自己的活）',
    doneByCreator.ok === true, JSON.stringify(doneByCreator.error));

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
  // 0.11.11 收紧：这张卡 owner 是空、创建者是 A，B 两样都不是 —— 不能替它收尾
  check('非创建者 / 非 owner 标完成 → 403（0.11.11 起）',
    doneByB.status === 403 && doneByB.error.code === 'forbidden', JSON.stringify(doneByB.error));
  const doneByCreatorA = await call(base, '/events', {
    method: 'POST',
    token: tokenA,
    body: {
      events: [{
        id: 'ev_aaaaaa_t1k00016b_yyy',
        origin: ORIGIN_A,
        kind: 'task',
        taskId: 'own2',
        title: 'A 的卡',
        detail: '原描述',
        status: 'done',
      }],
    },
  });
  check('创建者 A 标完成 → 放行', doneByCreatorA.ok === true, JSON.stringify(doneByCreatorA.error));

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

  /**
   * 墓碑之后写普通 task 事件（0.11.5）。
   *
   * 以前这条落到「非创建者不能改标题」检查上，报 409 说「别的成员不能改标题/描述/依赖」
   * —— 方向反了：根本不是权限问题。更危险的是**放行也不行**：`applyIndex` 是
   * `{...prevF, ...ev}`，放进来正文就当场复活。所以现在明确回「已删除」。
   */
  const writeToTomb = await call(base, '/events', {
    method: 'POST',
    token: tokenB,
    body: {
      events: [{
        eventVersion: 2,
        id: 'ev_tomb_after_00001',
        origin: ORIGIN_B,
        name: 'B',
        ts: new Date().toISOString(),
        kind: 'task',
        taskId: 't-tomb',
        title: '想把正文写回来',
        status: 'pending',
      }],
    },
  });
  check('墓碑之后写普通 task 事件被拒', writeToTomb.ok === false && writeToTomb.status === 409,
    JSON.stringify(writeToTomb.error));
  check('拒的理由是「已删除」，不是「不能改标题」',
    /已删除/.test(String(writeToTomb.error?.message || writeToTomb.error || '')),
    JSON.stringify(writeToTomb.error));
  const tombStillEmpty = await call(base, '/events?since=0&limit=500', { token: tokenA });
  const tombAfter = (tombStillEmpty.data.events || []).filter((e) => e.taskId === 't-tomb');
  check('正文没被写回来（仍然是空壳）',
    tombAfter.every((e) => !String(e.title || '').includes('想把正文写回来')),
    JSON.stringify(tombAfter.map((e) => e.title)));

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

  /* ─────────────── 10. 口令哈希（0.10.17） ─────────────── */

  console.log('\n10. 口令哈希：Hub 存哈希，明文和哈希都能过');
  const hashedLove = 'v1$' + createHash('sha256').update(GROUP + 'LOVE', 'utf8').digest('hex');
  const codeDir = dir();
  const codeHub = await startHub({
    dir: codeDir,
    groupId: GROUP,
    origin: ORIGIN_A,
    port: 0,
    code: hashedLove, // 落盘/比对用的都是哈希
    noDiscovery: true,
    log: () => {},
  });
  const codeBase = `http://127.0.0.1:${codeHub.info.port}`;
  const joinPlain = await call(codeBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
  });
  check('成员发明文 → Hub 用盐算一遍比对通过', Boolean(joinPlain.data?.token), JSON.stringify(joinPlain.error));
  const joinBearer = await call(codeBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_C, name: 'C', code: hashedLove },
  });
  check('成员重启后只能发哈希（bearer）→ 通过', Boolean(joinBearer.data?.token), JSON.stringify(joinBearer.error));
  const joinWrong = await call(codeBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_A, name: 'A', code: 'NOPE' },
  });
  check('错口令仍然 401', joinWrong.status === 401 && joinWrong.error.code === 'bad-code');
  check('/info 的 needCode 不因为存的是哈希就变假', (await call(codeBase, '/info')).data.needCode === true);

  console.log('\n10b. 运行中换口令（0.11.7）');
  // 以前 `code` 是 createHub 里的 const：设置里改了口令，跑着的 Hub 还比旧值
  const newHash = 'v1$' + createHash('sha256').update(GROUP + 'NEWPASS', 'utf8').digest('hex');
  check('setCode 返回 needCode=true', codeHub.controller.setCode(newHash).needCode === true);
  check('/info 立刻说要口令', (await call(codeBase, '/info')).data.needCode === true);
  const oldPlain = await call(codeBase, '/join', {
    method: 'POST', body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
  });
  check('旧口令当场失效', oldPlain.status === 401 && oldPlain.error.code === 'bad-code');
  const newPlain = await call(codeBase, '/join', {
    method: 'POST', body: { wireProtocol: 1, origin: ORIGIN_C, name: 'C', code: 'NEWPASS' },
  });
  check('新口令当场可用', Boolean(newPlain.data?.token), JSON.stringify(newPlain.error));
  codeHub.controller.setCode('');
  check('清空口令后 /info needCode=false', (await call(codeBase, '/info')).data.needCode === false);
  const noCodeJoin = await call(codeBase, '/join', {
    method: 'POST', body: { wireProtocol: 1, origin: ORIGIN_A, name: 'A', code: '' },
  });
  check('清空后不带口令能进', Boolean(noCodeJoin.data?.token), JSON.stringify(noCodeJoin.error));

  await codeHub.controller.close();
  rmSync(codeDir, { recursive: true, force: true });

  /* ─────────────── 11. 活动口径：note 不续约 ─────────────── */

  console.log('\n11. 活动口径：note 不续约，owner 的 task 事件续约');
  const actDir = dir();
  const actHub = await startHub({
    dir: actDir, groupId: GROUP, origin: ORIGIN_C, port: 0, noDiscovery: true, leaseTickMs: 50, log: () => {},
  });
  const actBase = `http://127.0.0.1:${actHub.info.port}`;
  const actJoin = await call(actBase, '/join', {
    method: 'POST', body: { wireProtocol: 1, origin: ORIGIN_A, name: 'A', code: '' },
  });
  const actTok = actJoin.data.token;
  const mkTask = (taskId, idSuffix) => ({
    eventVersion: 2, id: `ev_aaaaaa_${idSuffix}_aaa`, origin: ORIGIN_A, name: 'A',
    ts: new Date().toISOString(), kind: 'task', taskId, title: `任务 ${taskId}`,
    status: 'pending', detail: '', owner: '',
  });
  const latestOf = async (taskId) => {
    const r = await call(actBase, '/events?since=0&limit=500', { token: actTok });
    return (r.data?.events || []).filter((e) => e.kind === 'task' && e.taskId === taskId)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0)).pop() || null;
  };

  await call(actBase, '/events', { method: 'POST', token: actTok, body: { events: [mkTask('t-note', 'mkdir0001')] } });
  await call(actBase, '/tasks/claim', { method: 'POST', token: actTok, body: { taskId: 't-note', leaseMs: 800 } });
  await new Promise((r) => setTimeout(r, 600));
  await call(actBase, '/events', {
    method: 'POST', token: actTok,
    body: {
      events: [{
        eventVersion: 2, id: 'ev_aaaaaa_note0001_aaa', origin: ORIGIN_A, name: 'A',
        ts: new Date().toISOString(), kind: 'note', taskId: 't-note', text: '写到一半了',
      }],
    },
  });
  // 900ms > 原租约 800ms，但 < 「note 也续约」才会到的 1400ms
  await new Promise((r) => setTimeout(r, 300));
  const afterNote = await latestOf('t-note');
  check('note 不续约：过了原租约就退回待认领', afterNote && afterNote.status === 'pending',
    JSON.stringify(afterNote?.status));

  await call(actBase, '/events', { method: 'POST', token: actTok, body: { events: [mkTask('t-task', 'mkdir0002')] } });
  await call(actBase, '/tasks/claim', { method: 'POST', token: actTok, body: { taskId: 't-task', leaseMs: 800 } });
  await new Promise((r) => setTimeout(r, 600));
  await call(actBase, '/events', {
    method: 'POST', token: actTok,
    body: {
      events: [{
        eventVersion: 2, id: 'ev_aaaaaa_tstatus1_aaa', origin: ORIGIN_A, name: 'A',
        ts: new Date().toISOString(), kind: 'task', taskId: 't-task', title: '任务 t-task',
        status: 'running', detail: '',
      }],
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  const afterTask = await latestOf('t-task');
  check('owner 的 task 事件算活动：续到 1400ms，900ms 时还在 running',
    afterTask && afterTask.status === 'running', JSON.stringify(afterTask?.status));
  await new Promise((r) => setTimeout(r, 700));
  const ended = await latestOf('t-task');
  check('续约也会到期（4× 上限照样收）', ended && ended.status === 'pending', JSON.stringify(ended?.status));

  // lease-exhausted：一直写进度把租约顶到上限，再看到期时的 note
  console.log('11b. lease-exhausted：续到 4× 上限和「没写进度」分得开');
  await call(actBase, '/events', { method: 'POST', token: actTok, body: { events: [mkTask('t-max', 'mkdir0003')] } });
  await call(actBase, '/tasks/claim', { method: 'POST', token: actTok, body: { taskId: 't-max', leaseMs: 500 } });
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    await call(actBase, '/events', {
      method: 'POST', token: actTok,
      body: {
        events: [{
          eventVersion: 2, id: `ev_aaaaaa_prog00${i}_aaa`, origin: ORIGIN_A, name: 'A',
          ts: new Date().toISOString(), kind: 'progress', taskId: 't-max', done: i, total: 99, note: '',
        }],
      },
    });
  }
  await new Promise((r) => setTimeout(r, 800));
  const maxLog = readFileSync(join(actDir, 'hub-events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  check('到期时写了「续约已到上限」的 warn note',
    maxLog.some((e) => e.kind === 'note' && e.level === 'warn' && String(e.text).includes('续约已到上限')));
  check('还写了「没写进度」的普通 note（另一种到期）',
    maxLog.some((e) => e.kind === 'note' && e.level === 'info' && String(e.text).includes('没有写入 progress')));
  await actHub.controller.close();
  rmSync(actDir, { recursive: true, force: true });

  /* ─────────────── 12. 认领附言 / to 数组 ─────────────── */

  console.log('\n12. 认领附言 reason/plan，msg.to 支持数组');
  const reasonDir = dir();
  const reasonHub = await startHub({
    dir: reasonDir, groupId: GROUP, origin: ORIGIN_C, port: 0, noDiscovery: true, log: () => {},
  });
  const rBase = `http://127.0.0.1:${reasonHub.info.port}`;
  const rJoin = await call(rBase, '/join', {
    method: 'POST', body: { wireProtocol: 1, origin: ORIGIN_A, name: 'A', code: '' },
  });
  const rTok = rJoin.data.token;
  await call(rBase, '/events', {
    method: 'POST',
    token: rTok,
    body: {
      events: [{
        eventVersion: 2, id: 'ev_aaaaaa_reason01_aaa', origin: ORIGIN_A, name: 'A',
        ts: new Date().toISOString(), kind: 'task', taskId: 't-reason',
        title: '带附言的卡', status: 'pending', detail: '',
      }],
    },
  });
  const claimReason = await call(rBase, '/tasks/claim', {
    method: 'POST',
    token: rTok,
    body: { taskId: 't-reason', leaseMs: 60000, reason: '这个我熟', plan: '先跑测试再改' },
  });
  check('带 reason/plan 的认领成功', claimReason.ok === true, JSON.stringify(claimReason.error));
  const reasonPull = await call(rBase, '/events?since=0&limit=500', { token: rTok });
  const runningEv = (reasonPull.data?.events || [])
    .filter((e) => e.kind === 'task' && e.taskId === 't-reason' && e.status === 'running')
    .pop();
  check('reason/plan 写进了 running 事件',
    runningEv?.reason === '这个我熟' && runningEv?.plan === '先跑测试再改', JSON.stringify(runningEv));

  const toArray = await call(rBase, '/events', {
    method: 'POST',
    token: rTok,
    body: {
      events: [{
        eventVersion: 2, id: 'ev_aaaaaa_tomulti1_aaa', origin: ORIGIN_A, name: 'A',
        ts: new Date().toISOString(), kind: 'msg', text: '叫你们两个', to: [ORIGIN_B, ORIGIN_C],
      }],
    },
  });
  check('msg.to 允许数组', toArray.ok === true, JSON.stringify(toArray.error));
  const toBad = await call(rBase, '/events', {
    method: 'POST',
    token: rTok,
    body: {
      events: [{
        eventVersion: 2, id: 'ev_aaaaaa_tobad001_aaa', origin: ORIGIN_A, name: 'A',
        ts: new Date().toISOString(), kind: 'msg', text: '坏的', to: ['xxx', ORIGIN_B],
      }],
    },
  });
  check('msg.to 数组里有坏值 → 400', toBad.status === 400 && toBad.error.code === 'bad-param');
  await reasonHub.controller.close();
  rmSync(reasonDir, { recursive: true, force: true });

  console.log('\n11. /join 失败限流（0.11.2）');
  const rlDir = dir();
  const rlHub = await startHub({
    dir: rlDir,
    groupId: GROUP,
    origin: ORIGIN_A,
    port: 0,
    code: 'LOVE',
    noDiscovery: true,
    joinRateLimit: { maxFailures: 5, baseDelayMs: 1500, maxDelayMs: 5000 },
    log: () => {},
  });
  const rlBase = `http://127.0.0.1:${rlHub.info.port}`;
  const wrongJoin = () => call(rlBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'NOPE' },
  });
  let wrong = null;
  for (let i = 0; i < 4; i += 1) wrong = await wrongJoin();
  check('前 4 次只回 401，不带退避', wrong.status === 401 && !wrong.error?.retryAfterMs,
    JSON.stringify(wrong.error));
  const fifth = await wrongJoin();
  check('第 5 次开始退避（仍回 401，带 retryAfterMs）',
    fifth.status === 401 && Number(fifth.error?.retryAfterMs) > 0, JSON.stringify(fifth.error));
  const blocked = await wrongJoin();
  check('第 6 次直接 429', blocked.status === 429 && blocked.error?.code === 'too-many-requests',
    JSON.stringify(blocked.error));
  const blockedRight = await call(rlBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
  });
  check('退避期内连对口令也拒（不给爆破免费的 oracle）',
    blockedRight.status === 429, JSON.stringify(blockedRight.error));
  await new Promise((r) => setTimeout(r, 1700));
  const afterWait = await call(rlBase, '/join', {
    method: 'POST',
    body: { wireProtocol: 1, origin: ORIGIN_B, name: 'B', code: 'LOVE' },
  });
  check('退避过后正确口令能进', afterWait.ok === true && Boolean(afterWait.data?.token),
    JSON.stringify(afterWait.error));
  const rlToken = afterWait.data?.token || '';
  // 成功清零：再连错 4 次仍然只是 401 —— 别让正常成员背着之前的失败计数
  let cleared = null;
  for (let i = 0; i < 4; i += 1) cleared = await wrongJoin();
  check('成功一次后计数清零（再错 4 次仍只是 401）',
    cleared.status === 401 && !cleared.error?.retryAfterMs, JSON.stringify(cleared.error));

  console.log('\n12. 请求体超限（413）');
  const hugeBody = { events: [], pad: 'x'.repeat(1400 * 1024) };
  const tooBig = await call(rlBase, '/events', { method: 'POST', token: rlToken, body: hugeBody });
  check('超限回 413（不是无声断连接）', tooBig.status === 413 && tooBig.error?.code === 'too-large',
    JSON.stringify(tooBig.status) + ' ' + JSON.stringify(tooBig.error));
  const aliveAfter = await call(rlBase, '/info');
  check('413 之后 Hub 还活着', aliveAfter.ok === true);
  await rlHub.controller.close();
  rmSync(rlDir, { recursive: true, force: true });

  console.log('\n13. UDP 广播验签：伪造包丢弃');
  const recvAuth = await createDiscovery({
    groupId: GROUP, origin: 'c'.repeat(16), code: 'LOVE', discoveryPort: 0, quiet: true, log: () => {},
  });
  const recvOpen = await createDiscovery({
    groupId: GROUP, origin: 'c'.repeat(16), code: '', discoveryPort: 0, quiet: true, log: () => {},
  });
  const fakeSock = createSocket({ type: 'udp4' });
  const sendPkt = (port, obj) => new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    fakeSock.send(buf, 0, buf.length, port, '127.0.0.1', (e) => (e ? reject(e) : resolve()));
  });
  const spoofOrigin = 'f'.repeat(16);
  const basePkt = {
    t: 'hub', wireProtocol: 1, groupId: GROUP, origin: spoofOrigin,
    name: '伪造 Hub', port: 48910, needCode: true, epoch: 1,
  };
  await sendPkt(recvAuth.port, { ...basePkt, hmac: 'deadbeefdeadbeef' });
  await new Promise((r) => setTimeout(r, 200));
  check('错签名的广播不进 peers（有口令时）', recvAuth.allPeers().length === 0,
    JSON.stringify(recvAuth.allPeers()));
  const goodSig = signPacket('LOVE', { groupId: GROUP, origin: spoofOrigin, port: 48910, epoch: 1 });
  await sendPkt(recvAuth.port, { ...basePkt, hmac: goodSig });
  await new Promise((r) => setTimeout(r, 200));
  check('正确签名的广播能收到',
    recvAuth.allPeers().length === 1 && recvAuth.allPeers()[0].origin === spoofOrigin,
    JSON.stringify(recvAuth.allPeers()));
  await sendPkt(recvOpen.port, { ...basePkt, origin: 'a'.repeat(16) });
  await new Promise((r) => setTimeout(r, 200));
  check('无口令时不验签 —— 已知边界，钉住它（别哪天顺手补个默认口令）',
    recvOpen.allPeers().length === 1, JSON.stringify(recvOpen.allPeers()));
  await recvAuth.close();
  await recvOpen.close();
  fakeSock.close();

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自己炸了：', e);
  process.exitCode = 1;
});
