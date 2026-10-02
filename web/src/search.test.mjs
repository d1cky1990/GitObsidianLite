// `web/src/search.js` 的规则测试。
// #33 的判据里，能在纯函数这一层钉住的：只搜 `.md`、标题/路径命中、正文命中与片段、
// 组内按路径序、一篇一处。
//
// 排序断言一律用 ASCII 路径：中文路径按 localeCompare 排，结果取决于运行环境的排序表，
// 拿它当判据等于在断言 Node 的 ICU 版本。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchTitles, searchBodies, findSnippet, normalizeQuery, isNote } from './search.js';

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

test('片段：三段切开、命中处原样保留大小写', () => {
  const s = findSnippet('前面的话 Alpha 后面的话', 'alpha');
  assert.deepEqual(s, { before: '前面的话 ', match: 'Alpha', after: ' 后面的话' });
});

test('片段：省略号只在真截断的那一侧出现', () => {
  const short = '甲'.repeat(80) + '目标' + '乙'.repeat(80);
  const s = findSnippet(short, '目标', 10);
  assert.equal(s.before, '…' + '甲'.repeat(10));
  assert.equal(s.after, '乙'.repeat(10) + '…');
  // 命中就在开头、结尾也没截断时，两边都不该有省略号
  assert.deepEqual(findSnippet('目标', '目标', 10), { before: '', match: '目标', after: '' });
});

test('片段：找不到就是 null，不是空片段', () => {
  assert.equal(findSnippet('abc', 'zzz'), null);
  assert.equal(findSnippet('abc', ''), null);
});

test('正文命中：一篇只报一处，组内按路径序', () => {
  const notes = [
    { path: 'b.md', content: '无关\n命中目标一次\n命中目标两次' },
    { path: 'a.md', content: '开头就命中目标' },
    { path: 'c.md', content: '这里没有' },
  ];
  const hits = searchBodies(notes, '目标');
  assert.deepEqual(hits.map((r) => r.path), ['a.md', 'b.md']);
  assert.equal(hits[1].snippet.match, '目标');
  assert.equal(hits[1].name, 'b');
});

test('正文命中：上限是截断不是报错', () => {
  const notes = Array.from({ length: 10 }, (_, i) => ({ path: `n${i}.md`, content: '目标' }));
  assert.equal(searchBodies(notes, '目标', { limit: 3 }).length, 3);
});

test('只搜笔记：附件与配置目录不进结果', () => {
  assert.equal(isNote('a/b.md'), true);
  assert.equal(isNote('a/b.MD'), true);
  assert.equal(isNote('a/b.png'), false);
  assert.equal(isNote('a/.obsidian/app.json'), false);
});
