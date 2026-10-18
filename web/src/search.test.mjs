// `web/src/search.js` 的规则测试。
// #33 的判据里，能在纯函数这一层钉住的：只搜 `.md`、标题/路径命中、正文命中与片段、
// 组内按路径序、一篇一处。
//
// 排序断言一律用 ASCII 路径：中文路径按 localeCompare 排，结果取决于运行环境的排序表，
// 拿它当判据等于在断言 Node 的 ICU 版本。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchTitles, searchBodies, findSnippet, normalizeQuery, isNote, bodyGroupView, coveredCount } from './search.js';

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

/* ---------- 正文那一组该怎么说话（#38 改的口径：副本没备齐也允许参与搜索） ----------
 *
 * 这组断言盯的是一件事：**「还没备到」不许说成「没有命中」**。
 * 那条规矩原来靠「整组不出」实现（#32 §5）；#38 按限流现实改成「出已到手的那部分」，
 * 于是这层防线从「不出」挪到了「措辞」上——它比原来更容易被写坏，所以钉在这里。
 */

test('正文组：开关没开就整组不出现', () => {
  const g = bodyGroupView({ enabled: false, covered: 100, total: 877, loaded: true, hitCount: 3 });
  assert.equal(g.kind, 'hidden');
  assert.equal(g.note, '');
});

test('正文组：一篇都还没到手 → 说清为什么，不是「没有命中」', () => {
  const g = bodyGroupView({ enabled: true, covered: 0, total: 877, loaded: false, hitCount: 0 });
  assert.equal(g.kind, 'no-copy');
  assert.doesNotMatch(g.note, /没有命中/);
});

test('正文组：手上有正文但还没读出来 → loading，也不下结论', () => {
  const g = bodyGroupView({ enabled: true, covered: 10, total: 877, loaded: false, hitCount: 0 });
  assert.equal(g.kind, 'loading');
});

test('正文组：只备了一部分且有命中 → 出结果，并说清只覆盖了多少篇', () => {
  const g = bodyGroupView({ enabled: true, covered: 210, total: 877, loaded: true, hitCount: 2 });
  assert.equal(g.kind, 'partial-hits');
  assert.equal(g.complete, false);
  assert.match(g.note, /210/);
  assert.match(g.note, /877/);
});

test('正文组：只备了一部分、这部分没命中 → 不许多说一个字「没有命中」', () => {
  const g = bodyGroupView({ enabled: true, covered: 210, total: 877, loaded: true, hitCount: 0 });
  assert.equal(g.kind, 'partial-empty');
  assert.doesNotMatch(g.note, /没有命中|没找到|没有相关/);
  // 必须把「还有多少篇没看过」说出来，否则读起来仍像「真的没有」
  assert.match(g.note, /667/);
});

test('正文组：与远端对齐了，这时「没有命中」才是真的没有', () => {
  const g = bodyGroupView({ enabled: true, covered: 877, total: 877, loaded: true, hitCount: 0 });
  assert.equal(g.kind, 'empty');
  assert.equal(g.complete, true);
});

test('正文组：对齐了且有命中 → 出结果，不必再解释范围', () => {
  const g = bodyGroupView({ enabled: true, covered: 877, total: 877, loaded: true, hitCount: 5 });
  assert.equal(g.kind, 'hits');
  assert.equal(g.note, '');
});

test('正文组：清单还没到手（总数未知）时，绝不冒充「对齐了」', () => {
  const g = bodyGroupView({ enabled: true, covered: 0, total: 0, loaded: false, hitCount: 0 });
  assert.equal(g.complete, false);
  assert.equal(g.kind, 'no-copy');
});

test('正文组：手上有正文、但远端清单还没到手 → 不编出「共 0 篇」这种数', () => {
  // 打开应用的头几秒就是这个状态：本地副本已经读出来了，整棵树（3~5 秒）还没回来。
  // 此时说「只备了 870 / 共 0 篇」比什么都不说更糟——那个 0 是假的。
  const g = bodyGroupView({ enabled: true, covered: 870, total: 0, loaded: true, hitCount: 0 });
  assert.equal(g.kind, 'unknown-scope');
  assert.equal(g.complete, false);
  assert.match(g.note, /870/);
  assert.doesNotMatch(g.note, /共 0/, '不许把「不知道」写成「共 0 篇」');
});

test('覆盖范围按路径求交集：本地多出的废记录不算覆盖', () => {
  // 远端有 a/b/c 三篇，本地存着 a/b 加一条远端已删的 zzz。
  // 条数比（3 === 3）会假对齐，然后大胆说「正文里没有命中」；交集说 2。
  assert.equal(coveredCount(['a.md', 'b.md', 'c.md'], ['a.md', 'b.md', 'zzz.md']), 2);
  assert.equal(coveredCount(['a.md', 'b.md', 'c.md'], new Set(['a.md', 'b.md', 'c.md'])), 3);
  assert.equal(coveredCount([], ['a.md']), 0);
  assert.equal(coveredCount(['a.md'], []), 0);
});
