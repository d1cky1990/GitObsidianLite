// recent.js 的规则测试（#64）。
//
// 工单 #64「最近打开」可单测内核：只记路径、5 条置顶去重截断、不按时间过期、
// 改名/移动换路径、删除去掉、失效三档互不冒充、同一批路径一分钟内不重复核对。
// 全是纯逻辑或注入了假依赖的编排，不碰 DOM / 真网络，能在 node --test 里钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_KEY, VERIFY_KEY, MAX_RECENT, VERIFY_TTL_MS,
  addRecent, removeRecent, replaceRecentPath, recentEntry,
  readRecent, writeRecent, readVerifyRecord, writeVerifyRecord,
  verifySignature, shouldVerify, classifyProbe, applyVerification,
  checkRecents, recheckOne,
} from './recent.js';

function mockStorage(init = {}) {
  const data = { ...init };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

/* ---------- 5 条置顶 / 去重 / 截断，只记路径 ---------- */

test('addRecent：最后打开的置顶、去重、截断到 5 条', () => {
  assert.equal(MAX_RECENT, 5);
  let p = [];
  for (const x of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md']) p = addRecent(p, x);
  assert.deepEqual(p, ['f.md', 'e.md', 'd.md', 'c.md', 'b.md'], '正好 5 条、按打开顺序倒序');
  p = addRecent(p, 'c.md');
  assert.deepEqual(p, ['c.md', 'f.md', 'e.md', 'd.md', 'b.md'], '再打开中间一条：置顶且不重复');
});

test('addRecent：空路径不进列表；不按时间过期（不读时间）', () => {
  assert.deepEqual(addRecent([], ''), []);
  assert.deepEqual(addRecent(['a.md'], '   '), ['a.md']);
  // 没有时间戳参与：同样的输入永远同样的输出
  assert.deepEqual(addRecent(['a.md'], 'b.md'), addRecent(['a.md'], 'b.md'));
});

test('recentEntry：名字 + 浅色父目录，112 组同名靠父目录分得开', () => {
  assert.deepEqual(recentEntry('日记/2026/05-14.md'), { name: '05-14.md', parent: '日记/2026' });
  assert.deepEqual(recentEntry('日记/2025/05-14.md'), { name: '05-14.md', parent: '日记/2025' });
  assert.notEqual(recentEntry('日记/2026/05-14.md').parent, recentEntry('日记/2025/05-14.md').parent);
  assert.deepEqual(recentEntry('根笔记.md'), { name: '根笔记.md', parent: '根目录' });
});

test('removeRecent：删掉正在读的那篇 → 那条去掉，其余顺序不变', () => {
  assert.deepEqual(removeRecent(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(removeRecent(['a', 'b'], 'z'), ['a', 'b']);
});

test('replaceRecentPath：改名/移动换成新路径、保留位置、撞已有项去重', () => {
  assert.deepEqual(
    replaceRecentPath(['a/b.md', 'x.md', 'c.md'], 'a/b.md', 'a/b2.md'),
    ['a/b2.md', 'x.md', 'c.md']);
  // 新路径已经在列表里 → 不产生两条
  assert.deepEqual(
    replaceRecentPath(['a/b.md', 'x.md', 'c.md'], 'a/b.md', 'c.md'),
    ['c.md', 'x.md']);
  // from 不在列表里（搬走的笔记不追）→ 原样
  assert.deepEqual(replaceRecentPath(['a', 'b'], 'z', 'y'), ['a', 'b']);
  assert.deepEqual(replaceRecentPath(['a', 'b'], 'a', 'a'), ['a', 'b']);
});

/* ---------- 本机存储：只有路径，找不到内容指纹或正文 ---------- */

test('writeRecent / readRecent：只序列化路径数组，坏值容错', () => {
  const s = mockStorage();
  writeRecent(['日记/2026/05-14.md', 'x.md'], s);
  const raw = s._data[RECENT_KEY];
  assert.ok(raw, '写到了约定的键');
  assert.ok(!/content|fingerprint|sha|body|draft|正文/i.test(raw), '不许存正文或内容指纹');
  assert.deepEqual(JSON.parse(raw), ['日记/2026/05-14.md', 'x.md']);
  assert.deepEqual(readRecent(s), ['日记/2026/05-14.md', 'x.md']);
});

test('readRecent：坏 JSON / 非数组 / 超长 / 脏元素都收敛成合法路径数组', () => {
  const s = mockStorage({ [RECENT_KEY]: '{bad json' });
  assert.deepEqual(readRecent(s), []);
  s.setItem(RECENT_KEY, JSON.stringify({ nope: 1 }));
  assert.deepEqual(readRecent(s), []);
  s.setItem(RECENT_KEY, JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g']));
  assert.equal(readRecent(s).length, MAX_RECENT);
  s.setItem(RECENT_KEY, JSON.stringify(['a', 5, '', null, 'b', 'a']));
  assert.deepEqual(readRecent(s), ['a', 'b'], '滤掉非字符串 / 空 / 重复');
  assert.deepEqual(readRecent(mockStorage()), [], '没有记录 → 空数组，不是出错');
});

/* ---------- 失效核对：三档互不冒充、一分钟内不重复 ---------- */

test('verifySignature：一批路径的签名与顺序无关（置顶后仍算同一批）', () => {
  assert.equal(verifySignature(['a.md', 'b.md']), verifySignature(['b.md', 'a.md']));
  assert.notEqual(verifySignature(['a.md', 'b.md']), verifySignature(['a.md', 'c.md']));
});

test('shouldVerify：同一批路径一分钟内不重复，换一批或满一分钟才再问', () => {
  const paths = ['a.md', 'b.md'];
  const rec = { key: verifySignature(paths), at: 1000 };
  assert.equal(shouldVerify(paths, rec, 1000 + VERIFY_TTL_MS - 1), false);
  assert.equal(shouldVerify(paths, rec, 1000 + VERIFY_TTL_MS), true);
  assert.equal(shouldVerify(['a.md', 'c.md'], rec, 1001), true, '换了一批 → 重新核对');
  assert.equal(shouldVerify(paths, null, 1000), true, '没有记录 → 核对');
  assert.equal(shouldVerify([], rec, 1001), false, '空列表不必核对');
  assert.equal(VERIFY_TTL_MS, 60_000);
});

test('readVerifyRecord / writeVerifyRecord：坏值当没有记录', () => {
  const s = mockStorage();
  assert.equal(readVerifyRecord(s), null);
  writeVerifyRecord({ key: 'k', at: 123 }, s);
  assert.deepEqual(readVerifyRecord(s), { key: 'k', at: 123 });
  s.setItem(VERIFY_KEY, 'not json');
  assert.equal(readVerifyRecord(s), null);
  s.setItem(VERIFY_KEY, JSON.stringify({ key: 'k' }));
  assert.equal(readVerifyRecord(s), null, '缺 at 的坏记录当没有');
});

test('classifyProbe：在 / 确认真不在 / 问不到，三档互不冒充', () => {
  assert.equal(classifyProbe(null), 'exists');
  assert.equal(classifyProbe(undefined), 'exists');
  assert.equal(classifyProbe({ notFound: true, status: 404 }), 'missing');
  assert.equal(classifyProbe({ status: 404 }), 'missing');
  assert.equal(classifyProbe({ status: 500 }), 'unknown', '服务端报错 ≠ 不在了');
  assert.equal(classifyProbe({ message: 'Failed to fetch' }), 'unknown', '断网 ≠ 不在了');
  assert.equal(classifyProbe({ auth: true, status: 401 }), 'unknown', '要密码也问不到在不在');
});

test('applyVerification：确认真不在才标失效；整批有一个问不到就不标任何失效', () => {
  assert.deepEqual(applyVerification([
    { path: 'a', kind: 'exists' }, { path: 'b', kind: 'missing' }, { path: 'c', kind: 'exists' },
  ]), ['b']);
  assert.deepEqual(applyVerification([
    { path: 'a', kind: 'exists' }, { path: 'b', kind: 'exists' },
  ]), []);
  assert.equal(applyVerification([
    { path: 'a', kind: 'missing' }, { path: 'b', kind: 'unknown' },
  ]), null, 'null = 整批结论不可信，保持不变（不标失效、不弹提示）');
});

test('checkRecents：5 条并行各问一次；一分钟内同批不发第二次请求', async () => {
  const s = mockStorage();
  let calls = 0;
  const probe = async (path) => {
    calls++;
    return path === 'gone.md' ? { status: 404, notFound: true } : null;
  };
  const paths = ['a.md', 'gone.md', 'c.md'];
  const r1 = await checkRecents(paths, { probe, now: 1000, storage: s });
  assert.equal(calls, paths.length, '每条各问一次，一起来');
  assert.equal(r1.ran, true);
  assert.deepEqual(r1.invalid, ['gone.md']);
  assert.equal(r1.unknownBatch, false);

  const r2 = await checkRecents(paths, { probe, now: 1000 + VERIFY_TTL_MS - 1, storage: s });
  assert.equal(calls, paths.length, '一分钟内反复出现不发第二次核对请求');
  assert.equal(r2.ran, false);
  assert.equal(r2.invalid, null, '跳过核对时不改标注');

  const r3 = await checkRecents(paths, { probe, now: 1000 + VERIFY_TTL_MS, storage: s });
  assert.equal(calls, paths.length * 2, '满一分钟才重新核对');
  assert.equal(r3.ran, true);
});

test('checkRecents：断网 / 服务端报错 → 整批不标失效、不要求弹提示', async () => {
  const s = mockStorage();
  const probe = async () => ({ message: 'Failed to fetch' });
  const r = await checkRecents(['a.md', 'b.md'], { probe, now: 1000, storage: s });
  assert.equal(r.ran, true);
  assert.equal(r.invalid, null, '整批不许标失效');
  assert.equal(r.unknownBatch, true);
});

test('checkRecents：核对时间戳落本机，换一批路径会重新核对', async () => {
  const s = mockStorage();
  let calls = 0;
  const probe = async () => { calls++; return null; };
  await checkRecents(['a.md'], { probe, now: 1000, storage: s });
  assert.deepEqual(readVerifyRecord(s), { key: verifySignature(['a.md']), at: 1000 });
  await checkRecents(['a.md', 'b.md'], { probe, now: 1001, storage: s });
  assert.equal(calls, 3, '换一批立刻重新核对');
});

test('recheckOne：点已失效那条重新问一次，三档各自分明', async () => {
  assert.equal(await recheckOne('a.md', { probe: async () => null }), 'exists', '回来了 → 正常打开');
  assert.equal(await recheckOne('a.md', { probe: async () => ({ status: 404, notFound: true }) }), 'missing');
  assert.equal(await recheckOne('a.md', { probe: async () => ({ status: 500 }) }), 'unknown');
  assert.equal(await recheckOne('a.md', { probe: async () => { throw new Error('offline'); } }), 'unknown');
});
