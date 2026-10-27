// `web/src/search.js` 的规则测试。
//
// 现在只剩标题 / 路径这一条路（正文搜索随本机副本一起下架，见 `docs/adr/0003`），
// 所以这里钉的也只有它：名字与路径都算命中、大小写不敏感、组内按路径序、空查询给空。
//
// 排序断言一律用 ASCII 路径：中文路径按 localeCompare 排，结果取决于运行环境的排序表，
// 拿它当判据等于在断言 Node 的 ICU 版本。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchTitles, normalizeQuery } from './search.js';

const PATHS = [
  'b/note-b.md',
  'a/note-a.md',
  'a/deep/note-c.md',
  'assets/pic.png',
  '.obsidian/app.json',
];

test('标题 / 路径命中：名字与路径都算，大小写不敏感', () => {
  assert.deepEqual(searchTitles(PATHS, 'note-a').map((r) => r.path), ['a/note-a.md']);
  assert.deepEqual(searchTitles(PATHS, 'NOTE-A').map((r) => r.path), ['a/note-a.md']);
  // 命中的是目录段（路径命中），不是文件名
  assert.deepEqual(searchTitles(PATHS, 'a/deep').map((r) => r.path), ['a/deep/note-c.md']);
});

test('标题命中：组内按路径序', () => {
  const hits = searchTitles(['b/x.md', 'a/y.md', 'a/deep/z.md'], '');
  assert.deepEqual(hits, []);
  const all = searchTitles(['b/x.md', 'a/y.md', 'a/deep/z.md'], '.md');
  assert.deepEqual(all.map((r) => r.path), ['a/deep/z.md', 'a/y.md', 'b/x.md']);
  assert.deepEqual(all[0], { path: 'a/deep/z.md', name: 'z', dir: 'a/deep' });
});

test('标题命中：空查询给空，不是给全部', () => {
  assert.deepEqual(searchTitles(PATHS, ''), []);
  assert.deepEqual(searchTitles(PATHS, '   '), []);
  assert.equal(normalizeQuery('  x  '), 'x');
});

test('标题命中：带扩展名搜也认（路径里本来就有 .md）', () => {
  assert.deepEqual(searchTitles(PATHS, 'note-a.md').map((r) => r.path), ['a/note-a.md']);
});

test('标题命中：上限是截断不是报错', () => {
  const many = Array.from({ length: 10 }, (_, i) => `n${i}.md`);
  assert.equal(searchTitles(many, '.md', 3).length, 3);
});
