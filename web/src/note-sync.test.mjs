// `web/src/note-sync.js` 的规则测试。
// 这里钉的是 #33 里最容易被「看起来在动」蒙过去的那几件：只补缺的、指纹变了要重取、
// 仓库里没有的要删、上限**只拦新增绝不回删**、单篇失败不拖垮整趟、以及
// 「HEAD 没变且本地已齐 → 什么都不做」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { noteShaMap, planSync, createBodySync } from './note-sync.js';

/* ---------- 假件：一个内存 store、一个记账的远端 ---------- */

/** 假指纹就取内容长度——够区分本测试里那些内容不同的样本 */
const shaOf = (content) => 'sha-' + content.length;

function fakeStore(init = []) {
  const notes = new Map(init.map((r) => [r.path, { sha: r.sha, content: r.content }]));
  return {
    notes,
    async put({ path, sha, content }) { notes.set(path, { sha, content }); },
    async remove(path) { notes.delete(path); },
    async count() { return notes.size; },
    async index() {
      const shas = new Map(), sizes = new Map();
      let bytes = 0;
      for (const [p, v] of notes) {
        shas.set(p, v.sha);
        const s = v.content.length;
        sizes.set(p, s);
        bytes += s;
      }
      return { shas, sizes, count: notes.size, bytes };
    },
  };
}

const treeOf = (map) =>
  Object.entries(map).map(([path, sha]) => ({ path, type: 'blob', sha, mode: '100644' }));

/** 起一个同步器：remote 是 {path: 内容}，指纹由 shaOf 算出来 */
function harness({ local = [], remote = {}, capBytes = 20 * 1024 * 1024, batchSize = 25, break_ = [] } = {}) {
  const store = fakeStore(local);
  const remoteMap = {};
  for (const [path, content] of Object.entries(remote)) remoteMap[path] = shaOf(content);
  const asked = [];
  const sync = createBodySync({
    store,
    loadTree: async () => ({ head: 'h1', tree: treeOf(remoteMap) }),
    fetchBlobs: async (files) => {
      asked.push(files.map((f) => f.path));
      const blobs = [], failed = [];
      for (const f of files) {
        if (break_.includes(f.path)) { failed.push({ path: f.path, error: 'Blob not found' }); continue; }
        blobs.push({ path: f.path, sha: f.sha, content: remote[f.path] });
      }
      return { blobs, failed };
    },
    getCapBytes: () => capBytes,
    onProgress: () => {},
    batchSize,
    batchGapMs: 0,
  });
  return { store, sync, asked };
}

/* ---------- 形状与计划 ---------- */

test('noteShaMap：只收 .md 的 blob，缺 sha 的不收', () => {
  const m = noteShaMap([
    { path: 'a.md', type: 'blob', sha: 's1' },
    { path: 'pic.png', type: 'blob', sha: 's2' },
    { path: 'dir', type: 'tree', sha: 's3' },
    { path: 'b.md', type: 'blob' },
    { path: 'c.MD', type: 'blob', sha: 's4' },
  ]);
  assert.deepEqual([...m.entries()], [['a.md', 's1'], ['c.MD', 's4']]);
});

test('planSync：缺的取、指纹变了的重取、一样的不动、少了的删', () => {
  const remote = new Map([['a.md', 's1'], ['b.md', 's2'], ['c.md', 's3']]);
  const local = new Map([['a.md', 's1'], ['b.md', 'old'], ['z.md', 's9']]);
  const { fetch, remove } = planSync(remote, local);
  assert.deepEqual(fetch, [{ path: 'b.md', sha: 's2' }, { path: 'c.md', sha: 's3' }]);
  assert.deepEqual(remove, ['z.md']);
});

/* ---------- 一趟同步 ---------- */

test('全量：取全部、存全部，进度走到 done', async () => {
  const { store, sync, asked } = harness({ remote: { 'a.md': '甲', 'b.md': '乙丙' } });
  await sync.sync();
  assert.equal(sync.state.status, 'done');
  assert.equal(sync.state.total, 2);
  assert.equal(sync.state.done, 2);
  assert.equal(sync.state.failed, 0);
  assert.deepEqual(asked, [['a.md', 'b.md']]);
  assert.equal(store.notes.get('a.md').content, '甲');
  assert.equal(sync.running, false);
});

test('增量：只补缺的，指纹一样的连请求都不发', async () => {
  const { store, sync, asked } = harness({
    local: [{ path: 'a.md', sha: shaOf('甲'), content: '甲' }],
    remote: { 'a.md': '甲', 'b.md': '乙' },
  });
  await sync.sync();
  assert.deepEqual(asked, [['b.md']], '只有 b 该被请求');
  assert.equal(sync.state.total, 1, '「共 Y 篇」是这一趟的篇数，不是全库篇数');
  assert.equal(store.notes.size, 2);
});

test('指纹变了要重取：同一路径的旧副本被换掉，不是又存一份', async () => {
  const { store, sync, asked } = harness({
    local: [{ path: 'a.md', sha: shaOf('甲'), content: '甲' }],
    remote: { 'a.md': '甲甲' },
  });
  await sync.sync();
  assert.deepEqual(asked, [['a.md']]);
  assert.equal(store.notes.size, 1);
  assert.equal(store.notes.get('a.md').content, '甲甲');
  assert.equal(store.notes.get('a.md').sha, shaOf('甲甲'));
});

test('仓库里已经没有的：本地那份删掉（全库名单不在这个库里，不受影响）', async () => {
  const { store, sync } = harness({ local: [{ path: 'z.md', sha: 'sha-2', content: '旧的' }] });
  await sync.sync();
  assert.equal(store.notes.size, 0);
});

test('仓库里一篇笔记都没有：status 走 done，不是卡在 running', async () => {
  const { sync } = harness();
  await sync.sync();
  assert.equal(sync.state.status, 'done');
  assert.equal(sync.state.total, 0);
});

test('上限：只拦新增、绝不回删；到了就停并如实报 capped', async () => {
  const keep = '留存';
  const { store, sync } = harness({
    local: [{ path: 'keep.md', sha: shaOf(keep), content: keep }],   // 已用 2 字节
    remote: { 'keep.md': keep, 'a.md': 'aaaa', 'b.md': 'bbbb' },
    capBytes: 7,                                                     // 2 + 4 放得下，再 +4 超
  });
  await sync.sync();
  assert.equal(sync.state.status, 'capped');
  assert.equal(sync.state.total, 2);
  assert.equal(sync.state.done, 1);
  assert.ok(store.notes.has('keep.md'), '上限到了也不能删已有的');
  assert.ok(store.notes.has('a.md'));
  assert.ok(!store.notes.has('b.md'));
});

test('上限：到的那一篇为止，之后的都不存', async () => {
  const { store, sync, asked } = harness({
    remote: { 'a.md': 'aaaa', 'b.md': 'bbbb', 'c.md': 'cccc' },
    capBytes: 10,
  });
  await sync.sync();
  assert.equal(sync.state.status, 'capped');
  assert.deepEqual([...store.notes.keys()], ['a.md', 'b.md']);
  assert.equal(sync.state.done, 2);
  assert.equal(sync.state.total, 3);
  assert.deepEqual(asked, [['a.md', 'b.md', 'c.md']], '一批取回来、逐条按上限决定存不存');
});

test('单篇失败不拖垮整批：其余照存，失败计数如实报出', async () => {
  const { store, sync, asked } = harness({
    remote: { 'a.md': '甲', 'b.md': '乙', 'c.md': '丙' },
    break_: ['b.md'],
  });
  await sync.sync();
  assert.deepEqual(asked, [['a.md', 'b.md', 'c.md']]);
  assert.deepEqual([...store.notes.keys()], ['a.md', 'c.md']);
  assert.equal(sync.state.failed, 1);
  assert.equal(sync.state.status, 'done');
});

test('分批：一批的大小按 batchSize 走（断点续传的粒度就是它）', async () => {
  const { sync, asked } = harness({
    remote: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd', 'e.md': 'e' },
    batchSize: 2,
  });
  await sync.sync();
  assert.deepEqual(asked, [['a.md', 'b.md'], ['c.md', 'd.md'], ['e.md']]);
});

test('整批一篇都没拿到：停在这一趟，不接着撞上游', async () => {
  const { store, sync, asked } = harness({
    remote: { 'a.md': '甲', 'b.md': '乙', 'c.md': '丙', 'd.md': '丁' },
    break_: ['a.md', 'b.md', 'c.md', 'd.md'],
    batchSize: 2,
  });
  await sync.sync();
  assert.equal(sync.state.status, 'blocked');
  assert.equal(store.notes.size, 0);
  assert.deepEqual(asked, [['a.md', 'b.md']], '撞墙之后不再发第二批');
  assert.match(sync.state.error, /Blob not found/);
});

test('批间隔：批与批之间会等一等（上游会限流）', async () => {
  const store = fakeStore();
  const at = [];
  const sync = createBodySync({
    store,
    loadTree: async () => ({ head: 'h1', tree: treeOf({ 'a.md': 's1', 'b.md': 's2', 'c.md': 's3' }) }),
    fetchBlobs: async (files) => { at.push(Date.now()); return { blobs: files.map((f) => ({ ...f, content: 'x' })), failed: [] }; },
    getCapBytes: () => 1e9,
    batchSize: 1,
    batchGapMs: 120,
  });
  await sync.sync();
  assert.equal(at.length, 3);
  assert.ok(at[1] - at[0] >= 100, '第一批与第二批之间至少等了一个间隔：' + (at[1] - at[0]) + 'ms');
});

test('取不到清单：报 error，不装成「同步完成」', async () => {
  const store = fakeStore();
  const sync = createBodySync({
    store,
    loadTree: async () => { throw new Error('断网了'); },
    fetchBlobs: async () => ({ blobs: [], failed: [] }),
    getCapBytes: () => 1e9,
    batchGapMs: 0,
  });
  await sync.sync();
  assert.equal(sync.state.status, 'error');
  assert.match(sync.state.error, /断网了/);
});

test('并发调用只跑一趟', async () => {
  let calls = 0;
  const store = fakeStore();
  const sync = createBodySync({
    store,
    loadTree: async () => { calls += 1; return { head: 'h1', tree: treeOf({ 'a.md': 's' }) }; },
    fetchBlobs: async (files) => ({ blobs: files.map((f) => ({ ...f, content: 'x' })), failed: [] }),
    getCapBytes: () => 1e9,
    batchGapMs: 0,
  });
  await Promise.all([sync.sync(), sync.sync(), sync.sync()]);
  assert.equal(calls, 1);
});

/* ---------- 顺风车 ---------- */

test('consider：HEAD 没变且本地已齐 → 连清单都不拉', async () => {
  let treeCalls = 0;
  const store = fakeStore([{ path: 'a.md', sha: 's', content: '甲' }]);
  const sync = createBodySync({
    store,
    loadTree: async () => { treeCalls += 1; return { head: 'h1', tree: treeOf({ 'a.md': 's' }) }; },
    fetchBlobs: async (files) => ({ blobs: files.map((f) => ({ ...f, content: 'x' })), failed: [] }),
    getCapBytes: () => 1e9,
    batchGapMs: 0,
  });
  await sync.consider({ reused: true, noteCount: 1 });
  assert.equal(treeCalls, 0);
  assert.equal(sync.state.status, 'idle');
});

test('consider：本地不齐 → 拉清单并补齐', async () => {
  let treeCalls = 0;
  const store = fakeStore([{ path: 'a.md', sha: 's', content: '甲' }]);
  const sync = createBodySync({
    store,
    loadTree: async () => {
      treeCalls += 1;
      return { head: 'h1', tree: treeOf({ 'a.md': 's', 'b.md': 't' }) };
    },
    fetchBlobs: async (files) => ({ blobs: files.map((f) => ({ ...f, content: 'x' })), failed: [] }),
    getCapBytes: () => 1e9,
    batchGapMs: 0,
  });
  await sync.consider({ reused: true, noteCount: 2 });
  assert.equal(treeCalls, 1);
  assert.equal(store.notes.size, 2);
});

test('consider：HEAD 变了，本地已齐也要重查一遍', async () => {
  let treeCalls = 0;
  const store = fakeStore([
    { path: 'a.md', sha: 's', content: '甲' },
    { path: 'b.md', sha: 't', content: '乙' },
  ]);
  const sync = createBodySync({
    store,
    loadTree: async () => { treeCalls += 1; return { head: 'h1', tree: treeOf({ 'a.md': 's', 'b.md': 't' }) }; },
    fetchBlobs: async (files) => ({ blobs: files.map((f) => ({ ...f, content: 'x' })), failed: [] }),
    getCapBytes: () => 1e9,
    batchGapMs: 0,
  });
  await sync.consider({ reused: false, noteCount: 2 });
  assert.equal(treeCalls, 1);
});
