// `web/src/pending-checks.js` 的测试（#60）。
// 盯的是工单「要做的」与「验收判据」里点名的那几条：意图按篇聚合、只存意图不存正文、
// 补发套行、送不到判定、按最后一行选词、本机序列化的边界。全部通过模块的公共接口验，
// 不另写一份复刻被测逻辑的复算脚本；tasks.js 的切换规则由被测模块自己 import 后整体跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeIntent, applyLines, lastDone, createStore, createPendingChecks, allowToast,
} from './pending-checks.js';

/** 一个最小可用的 localStorage 替身，测试里注入，模块顶层不碰真实的 localStorage。 */
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _raw: m,
  };
}

const THREE = '- [ ] 一\n- [ ] 二\n- [ ] 三';

test('mergeIntent：按篇聚合，一篇只有一条，反复勾仍是一条，改不动入参', () => {
  const empty = {};
  const r1 = mergeIntent(empty, { path: '甲.md', sha: 's1', line: 0, done: true });
  assert.deepEqual(Object.keys(r1), ['甲.md']);
  assert.deepEqual(r1['甲.md'], { path: '甲.md', sha: 's1', lines: [{ line: 0, done: true }] });
  assert.deepEqual(empty, {}, 'mergeIntent 不该改传入的 records');

  const r2 = mergeIntent(r1, { path: '甲.md', sha: 's1', line: 2, done: false });
  assert.deepEqual(Object.keys(r2), ['甲.md'], '同一篇反复勾仍只有一条记录');
  assert.deepEqual(r2['甲.md'].lines, [{ line: 0, done: true }, { line: 2, done: false }]);

  const r3 = mergeIntent(r2, { path: '乙.md', sha: 'b1', line: 1, done: true });
  assert.deepEqual(Object.keys(r3).sort(), ['乙.md', '甲.md'].sort(), '另一篇各自成一条');
  assert.deepEqual(r3['甲.md'].lines, [{ line: 0, done: true }, { line: 2, done: false }], '乙篇不牵连甲篇');
});

test('mergeIntent：待发合并后仍用第一笔那一刻的版本号做基准', () => {
  // 连勾发生在第一笔落地之前，屏幕上那篇的 sha 一直没换；即便后一笔误带了新的 sha，
  // 基准也该锁定第一笔那刻——补发的「整篇没变」必须对着同一个版本号核对。
  let r = mergeIntent({}, { path: '甲.md', sha: 's1', line: 0, done: true });
  r = mergeIntent(r, { path: '甲.md', sha: 's2', line: 1, done: true });
  assert.equal(r['甲.md'].sha, 's1');
});

test('mergeIntent / 序列化：只取意图字段，那一刻的正文进不了待发记录', () => {
  const r = mergeIntent({}, {
    path: '甲.md', sha: 's1', line: 0, done: true, content: '这一整篇正文绝不能落本机',
  });
  assert.ok(!('content' in r['甲.md']), '记录结构里根本没有 content 这一项');
  assert.ok(!JSON.stringify(r).includes('正文'), '序列化结果里翻不出正文');

  const storage = memoryStorage();
  createStore(storage).save(r);
  const raw = storage.getItem('pendingChecks.v1');
  assert.ok(!raw.includes('正文'), '写进本机存储的字符串里没有正文');
  assert.deepEqual(Object.keys(JSON.parse(raw)['甲.md']).sort(), ['lines', 'path', 'sha']);
});

test('applyLines：把几行一起套到基准正文上，一次成型', () => {
  const r = applyLines(THREE, [
    { line: 0, done: true }, { line: 1, done: true }, { line: 2, done: true },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.content, '- [x] 一\n- [x] 二\n- [x] 三');
});

test('applyLines：同一行点两次按序列重放回到原样，别的字节一个不碰', () => {
  const base = '- [ ] 买牛奶 ✅ 2026-01-01\n普通段落不动';
  const once = applyLines(base, [{ line: 0, done: true }]);
  assert.equal(once.ok, true);
  // 切换只翻行首状态字符，行尾文字与普通段落原样；完成日期手术由 tasks.js 既有规则决定
  assert.match(once.content, /^- \[x\] 买牛奶/);
  assert.match(once.content, /普通段落不动$/);
  const twice = applyLines(base, [{ line: 0, done: true }, { line: 0, done: false }]);
  assert.equal(twice.ok, true);
  assert.equal(twice.content.split('\n')[1], '普通段落不动');
});

test('applyLines：那一行没了 / 不再是任务项 → 判定送不到', () => {
  assert.deepEqual(applyLines('普通段落', [{ line: 0, done: true }]), { ok: false, reason: 'line-gone' });
  assert.deepEqual(applyLines(THREE, [{ line: 99, done: true }]), { ok: false, reason: 'line-gone' });
});

test('lastDone：合并发送按最后一行改动的结果选词，空记录回落 false', () => {
  assert.equal(lastDone([]), false);
  assert.equal(lastDone([{ done: true }]), true);
  assert.equal(lastDone([{ done: true }, { done: false }]), false, '以最后一下为准');
  assert.equal(lastDone([{ done: false }, { done: true }]), true);
});

test('createStore：空存储 load 为空对象，save 后能原样 load 回来', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  assert.deepEqual(store.load(), {});
  const records = {
    '甲.md': { path: '甲.md', sha: 's1', lines: [{ line: 0, done: true }] },
  };
  store.save(records);
  assert.deepEqual(store.load(), records);
});

test('createStore：脏数据（坏 JSON / 缺字段 / 非法行）逐条丢弃，不整份崩掉', () => {
  const storage = memoryStorage();
  storage.setItem('pendingChecks.v1', '{ 不是 json');
  assert.deepEqual(createStore(storage).load(), {});

  storage.setItem('pendingChecks.v1', JSON.stringify({
    '好.md': { path: '好.md', sha: 's1', lines: [{ line: 0, done: true }] },
    '缺sha.md': { path: '缺sha.md', lines: [{ line: 0, done: true }] },
    '坏行.md': { path: '坏行.md', sha: 's2', lines: [{ line: -1, done: true }, { line: 'x', done: true }] },
    '空行.md': { path: '空行.md', sha: 's3', lines: [] },
  }));
  assert.deepEqual(createStore(storage).load(), {
    '好.md': { path: '好.md', sha: 's1', lines: [{ line: 0, done: true }] },
  });
});

/* ---------- 编排层：createPendingChecks（外部边界全换成假的） ---------- */

const c1 = '- [x] 一\n- [ ] 二\n- [ ] 三';
const c2 = '- [x] 一\n- [x] 二\n- [ ] 三';
const c3 = '- [x] 一\n- [x] 二\n- [x] 三';

/** 把 readFile / writeFile / 提示条 / 屏幕全换成假的，逐条走编排的每个分支。 */
function harness() {
  const storage = memoryStorage();
  const calls = { readFile: [], writeFile: [], toast: [], openNote: [], setScreenSha: [] };
  const remote = new Map([['甲.md', { path: '甲.md', sha: 's1', content: THREE }]]);
  const writeErrors = new Map();
  let readError = null;
  let screen = { view: 'editor', path: '甲.md', mode: 'read' };

  const checks = createPendingChecks({
    storage,
    readFile: async (p) => {
      calls.readFile.push(p);
      if (readError) throw readError;
      const f = remote.get(p);
      if (!f) { const e = new Error('不在了'); e.notFound = true; throw e; }
      return { ...f };
    },
    writeFile: async (p, content, sha, message) => {
      calls.writeFile.push({ p, content, sha, message });
      const e = writeErrors.get(p);
      if (e) throw e;
      return { sha: 'after-' + sha };
    },
    toast: (msg, action = null) => calls.toast.push({ msg, action }),
    openNote: (p) => calls.openNote.push(p),
    getScreen: () => ({ ...screen }),
    setScreenSha: (sha) => calls.setScreenSha.push(sha),
  });

  return {
    checks, calls,
    store: () => createStore(storage).load(),
    screen: (s) => { screen = s; },
    remote: (p, f) => remote.set(p, f),
    dropRemote: (p) => remote.delete(p),
    readFails: (e) => { readError = e; },
    writeFails: (p, e) => writeErrors.set(p, e),
    writeOk: (p) => writeErrors.delete(p),
    lastWrite: () => calls.writeFile[calls.writeFile.length - 1],
  };
}

const rec = (line, done, content) => ({ path: '甲.md', sha: 's1', line, done, content });

test('record：点下即发，带那一刻的 path / sha / 正文与按结果选词，成功后划掉', async () => {
  const h = harness();
  await h.checks.record(rec(0, true, c1));
  assert.equal(h.calls.writeFile.length, 1, '点一下就发一次（点一个存一个不动）');
  assert.equal(h.calls.readFile.length, 0, '在线提交不读远端');
  const w = h.calls.writeFile[0];
  assert.equal(w.p, '甲.md');
  assert.equal(w.sha, 's1');
  assert.equal(w.content, c1, '写的是那一刻内存里的正文');
  assert.match(w.message, /（勾选待办）/);
  assert.deepEqual(h.store(), {}, '送到就划掉');
  assert.deepEqual(h.calls.toast, [{ msg: '已保存', action: null }], '屏幕就是那篇，不点名');
  assert.deepEqual(h.calls.setScreenSha, ['after-s1'], '版本号同步换掉，下回保存不报假冲突');
});

test('record：换篇后这一笔仍归甲篇，提交不读屏幕，乙篇版本号一字未动，成功点名', async () => {
  const h = harness();
  h.screen({ view: 'editor', path: '乙.md', mode: 'read' });
  await h.checks.record(rec(0, true, c1));
  const w = h.calls.writeFile[0];
  assert.equal(w.p, '甲.md', '归的是点下那一刻那篇，不是屏幕上那篇');
  assert.equal(w.sha, 's1');
  assert.deepEqual(h.calls.setScreenSha, [], '乙篇版本号没被改写');
  assert.equal(h.calls.toast[0].msg, '已保存 · 甲.md', '写的不是屏幕上那篇时点名');
});

test('record：断网可补发——留一条、只提示一次；连勾三下仍一条、三行并在一起', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1));
  await h.checks.record(rec(1, true, c2));
  await h.checks.record(rec(2, true, c3));
  assert.equal(h.calls.writeFile.length, 1, '断网期间只发第一下那次，后两下并入同一条，不各发一次');
  assert.equal(Object.keys(h.store()).length, 1, '一篇只有一条');
  assert.equal(h.store()['甲.md'].lines.length, 3, '三行一起躺着，没有一笔单独落地');
  assert.equal(h.store()['甲.md'].sha, 's1', '基准版本号仍是第一笔那刻');
  const retry = h.calls.toast.filter((t) => t.msg === '还没送到，联网后自动再试');
  assert.equal(retry.length, 1, '只提示一次');
});

test('replay：恢复网络切回前台，整篇没变才一次写出三行、点名、全程不报冲突', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1));
  await h.checks.record(rec(1, true, c2));
  await h.checks.record(rec(2, false, c3));
  h.writeOk('甲.md');
  h.screen({ view: 'editor', path: '乙.md', mode: 'read' });
  const before = h.calls.writeFile.length;
  await h.checks.replay();
  assert.equal(h.calls.readFile.length, 1, '补发重新拿那篇最新正文');
  assert.equal(h.calls.writeFile.length - before, 1, '三行合成一次写出，不是三次');
  const w = h.lastWrite();
  assert.equal(w.p, '甲.md');
  assert.equal(w.sha, 's1');
  assert.equal(w.content, '- [x] 一\n- [x] 二\n- [x] 三', '三行一起套到最新正文上');
  assert.match(w.message, /（取消勾选待办）/, '合并发送按最后一行 done=false 选词');
  assert.deepEqual(h.store(), {}, '落地后清掉那一条');
  assert.ok(h.calls.toast.some((t) => /已保存/.test(t.msg) && t.msg.includes('甲.md')), '补发成功点名');
  assert.ok(!h.calls.toast.some((t) => /冲突/.test(t.msg)), '全程不出现冲突提示');
});

test('replay：补发前那篇在别处被整篇改过 → 核对不过，丢弃并点名+打开，不写入', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1));
  h.writeOk('甲.md');
  h.remote('甲.md', { path: '甲.md', sha: 's-changed', content: THREE });
  const before = h.calls.writeFile.length;
  await h.checks.replay();
  assert.equal(h.calls.writeFile.length, before, '整篇版本号没对上，不写入');
  assert.deepEqual(h.store(), {}, '当场清掉那一条，不再反复试');
  const dead = h.calls.toast.find((t) => t.action && t.action.label === '打开');
  assert.ok(dead, '点名 + 打开');
  assert.ok(dead.msg.includes('甲.md'));
  assert.equal(dead.action.sticky, true, '这条不许被后续普通提示顶掉');
});

test('replay：那篇不见了 / 那一行被删 → 送不到，清掉并点名+打开', async () => {
  const gone = harness();
  gone.writeFails('甲.md', new Error('断网'));
  await gone.checks.record(rec(0, true, c1));
  gone.writeOk('甲.md'); gone.dropRemote('甲.md');
  await gone.checks.replay();
  assert.ok(gone.calls.toast.some((t) => t.action && t.action.label === '打开' && t.action.sticky));
  assert.deepEqual(gone.store(), {});

  const lineGone = harness();
  lineGone.writeFails('甲.md', new Error('断网'));
  await lineGone.checks.record(rec(0, true, c1));
  lineGone.writeOk('甲.md');
  // 版本号没变、那行却不再是任务项行 → 重放时判「那行没了」，不能盲写
  lineGone.remote('甲.md', { path: '甲.md', sha: 's1', content: '普通段落\n没有任务项了' });
  await lineGone.checks.replay();
  assert.ok(lineGone.calls.toast.some((t) => t.action && t.action.label === '打开'));
  assert.deepEqual(lineGone.store(), {});
});

test('replay：正在编辑那篇时不补发，退出编辑后的下一次补发才写，并同步屏幕版本号', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1));
  h.writeOk('甲.md');
  h.screen({ view: 'editor', path: '甲.md', mode: 'edit' });
  const before = h.calls.writeFile.length;
  await h.checks.replay();
  assert.equal(h.calls.writeFile.length, before, '编辑中不补发');
  assert.ok(h.store()['甲.md'], '记录还留着');
  h.screen({ view: 'editor', path: '甲.md', mode: 'read' });
  await h.checks.replay();
  assert.equal(h.calls.writeFile.length, before + 1, '退出编辑后的下一次补发才写');
  assert.deepEqual(h.calls.setScreenSha, ['after-s1'], '补发成功、屏幕正开那篇阅读态 → 同步版本号');
});

test('按篇各自成串：甲篇那条失败，那几行一起没落地；另一篇照常提交', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1));
  await h.checks.record(rec(1, true, c2));
  await h.checks.record({ path: '乙.md', sha: 'b1', line: 0, done: true, content: '- [x] 乙' });
  assert.equal(h.store()['甲.md'].lines.length, 2, '甲篇两行一起躺着，不出现一笔成一笔不成');
  assert.ok(!h.store()['乙.md'], '乙篇照常落地，不受甲篇牵连');
});

test('replay：断网连不上（readFile 也问不到）→ 问不到就不猜，保留记录可再补发', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1));
  h.writeOk('甲.md'); h.readFails(new Error('还没联网'));
  const before = h.calls.writeFile.length;
  await h.checks.replay();
  assert.equal(h.calls.writeFile.length, before, '问不到最新正文就不写');
  assert.ok(h.store()['甲.md'], '记录留着，联网后再补发');
});

test('allowToast：sticky 的「送不到」期间挡住普通提示，放行另一条 sticky', () => {
  const sticky = { label: '打开', sticky: true };
  assert.equal(allowToast(sticky, null), false, '普通「已保存」顶不掉');
  assert.equal(allowToast(sticky, { label: '撤销' }), false, '普通带动作也顶不掉');
  assert.equal(allowToast(sticky, sticky), true, '另一篇也送不到，放行新的 sticky');
  assert.equal(allowToast(null, null), true);
  assert.equal(allowToast({ label: '撤销' }, null), true, '普通提示期间照常放行');
});

// 判据 5 后半：main.js 的 backToRead() 在退出编辑这一刻会触发一次 replay。这里把
// getScreen 从 edit 切到 read，断言这一次 replay 不再跳过、当场把那篇补发出去。
test('replay：退出编辑（edit → read）后单次 replay 不再跳过，照常补发那篇', async () => {
  const h = harness();
  h.writeFails('甲.md', new Error('断网'));
  await h.checks.record(rec(0, true, c1)); // 编辑期间甲篇留着一笔没送到
  h.writeOk('甲.md');
  h.screen({ view: 'editor', path: '甲.md', mode: 'edit' });
  // 退出编辑：屏幕切回 read，backToRead() 触发的这次补发
  h.screen({ view: 'editor', path: '甲.md', mode: 'read' });
  const before = h.calls.writeFile.length;
  await h.checks.replay();
  assert.equal(h.calls.writeFile.length, before + 1, '退出编辑这一刻就补发，不必等切前台 / 冷启动');
  assert.equal(h.lastWrite().p, '甲.md');
  assert.deepEqual(h.store(), {}, '送成后划掉');
  assert.deepEqual(h.calls.setScreenSha, ['after-s1'], '屏幕正开那篇阅读态，版本号跟着换');
});
