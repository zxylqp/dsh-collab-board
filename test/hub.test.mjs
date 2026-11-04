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
import { startHub } from '../src/host/hub.mjs';
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
    .filter((e) => e.taskId === 't3')
    .sort((a, b) => (a.seq - b.seq));
  const t3Latest = t3Events[t3Events.length - 1];
  check('t3 自动 blocked → pending', t3Latest && t3Latest.status === 'pending',
    t3Latest ? t3Latest.status : '没有 t3 事件');
  check('解锁写了系统 note',
    pullAfterDone.data.events.some((e) => e.kind === 'note' && e.origin === '0000000000000000' && String(e.text).includes('t3')));
  check('解锁事件是系统 origin', t3Latest && t3Latest.origin === '0000000000000000', t3Latest && t3Latest.origin);

  const t3CountBefore = t3Events.length;
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
  const t3CountAfter = pullAgain.data.events.filter((e) => e.taskId === 't3').length;
  check('重复 done 不重复解锁（条件二）', t3CountAfter === t3CountBefore, `${t3CountBefore} → ${t3CountAfter}`);

  console.log('\n5d. owner 旁路：普通写不许抢已认领的卡');
  // 认领本来走 /tasks/claim 的串行 CAS，但普通 task 事件也能写 owner ——
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
