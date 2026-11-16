// tree.js 的占位契约测试。
//
// #61 只负责把「其余五张票要 import 的接口」先立住，真正的树由 #62 填充。
// 这里钉的是接口形状与「可运行」：导出齐、返回默认值、调用不抛。
// 断言不钉具体实现，#62 换掉内部时这些测试不该被迫改。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTree, sortEntries, refreshTree, getSelectedFolder, setSelectedFolder, selectPath,
  indentFor, ancestorsOf, isAncestor, reconcileState, loadTreeState, saveTreeState,
  shouldAutoScroll, TREE_STATE_KEY, flattenVisible, rowHtml, renderTreeHtml,
  createTreeController, initTree, notifySidebarShown,
} from './tree.js';

test('契约：六个导出都是函数', () => {
  for (const fn of [buildTree, sortEntries, refreshTree, getSelectedFolder, setSelectedFolder, selectPath]) {
    assert.equal(typeof fn, 'function');
  }
});

test('占位可运行：buildTree / sortEntries 返回数组，调用不抛', () => {
  assert.ok(Array.isArray(buildTree(['a/b.md', 'c.md'])));
  const entries = [{ name: 'x', type: 'dir' }, { name: 'y', type: 'note' }];
  const sorted = sortEntries(entries);
  assert.ok(Array.isArray(sorted));
  assert.equal(sorted.length, entries.length);
});

test('占位可运行：选中的文件夹默认仓库根，set/get 成对', () => {
  assert.equal(getSelectedFolder(), '');
  setSelectedFolder('日记/2026');
  assert.equal(getSelectedFolder(), '日记/2026');
  setSelectedFolder(''); // 复位，别把状态漏给别的测试
});

test('占位可运行：refreshTree / selectPath 不抛', () => {
  assert.doesNotThrow(() => refreshTree());
  assert.doesNotThrow(() => selectPath('a/b.md'));
});

// ==========================================================================
// #62 切片 A：排序（文件夹在前 + 拼音序）与从全库名单推嵌套树
// 数据源是 wikilinkIndex.notePaths，零新增取数请求；只画能到达笔记的路径。
// ==========================================================================

test('sortEntries：文件夹在前、名字拼音序，返回新数组且不改入参', () => {
  const input = [
    { name: '张三', type: 'note' },
    { name: '安妮', type: 'dir' },
    { name: '李四', type: 'note' },
    { name: '概览', type: 'dir' },
  ];
  const snapshot = input.map((e) => ({ ...e }));
  const out = sortEntries(input);
  assert.deepEqual(out.map((e) => e.name), ['安妮', '概览', '李四', '张三']);
  assert.notEqual(out, input, '返回新数组');
  assert.deepEqual(input, snapshot, '不改入参');
});

test('sortEntries：中文按拼音序而非字符编码序（不沿用接口原序）', () => {
  // 字符编码序是 张三(U+5F20) < 李四(U+674E)：张三,李四
  // 拼音序是 li < zhang：李四,张三
  const out = sortEntries([
    { name: '张三', type: 'note' }, { name: '李四', type: 'note' },
  ]);
  assert.deepEqual(out.map((e) => e.name), ['李四', '张三']);
});

test('sortEntries：非数组当空数组，元素缺字段不抛', () => {
  assert.deepEqual(sortEntries(null), []);
  assert.deepEqual(sortEntries(undefined), []);
  assert.deepEqual(sortEntries('nope'), []);
});

test('buildTree：文件夹在前 + 拼音序，noteCount 是子树笔记总数', () => {
  const tree = buildTree(['日记/2026/a.md', '日记/b.md', 'c.md']);
  assert.deepEqual(tree.map((n) => n.name), ['日记', 'c']);
  const dir = tree[0];
  assert.equal(dir.type, 'dir');
  assert.equal(dir.path, '日记');
  assert.equal(dir.depth, 1);
  assert.equal(dir.noteCount, 2);
  assert.deepEqual(dir.children.map((n) => n.name), ['2026', 'b']);
  assert.equal(dir.children[0].noteCount, 1);
  assert.equal(tree[1].type, 'note');
  assert.equal(tree[1].path, 'c.md'); // path 保留完整路径
  assert.equal(tree[1].name, 'c');    // 显示名去掉 .md，与搜索结果一致
});

test('buildTree：配置/附件/脚本目录（无 .md 笔记）自动消失，不用黑名单', () => {
  const tree = buildTree([
    '脚本/deploy.sh', '附件/logo.png', '配置/settings.json', '笔记/正文.md',
  ]);
  assert.deepEqual(tree.map((n) => n.name), ['笔记']);
  assert.deepEqual(tree[0].children.map((n) => n.name), ['正文']);
});

test('buildTree：197 篇大目录照直铺、不分段、不造假节点', () => {
  const paths = Array.from({ length: 197 }, (_, i) =>
    '大目录/第' + String(i).padStart(3, '0') + '篇.md');
  const tree = buildTree(paths);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].noteCount, 197);
  assert.equal(tree[0].children.length, 197);
  assert.ok(tree[0].children.every((n) => n.type === 'note'), '不掺分组标题/假节点');
});

test('buildTree：四层路径都画得出来，depth 递增、noteCount 正确', () => {
  const tree = buildTree(['一/二/三/四/深.md', '一/二/浅.md']);
  const d1 = tree[0];
  const d2 = d1.children.find((n) => n.type === 'dir');
  const d3 = d2.children.find((n) => n.type === 'dir');
  assert.equal(d1.depth, 1); assert.equal(d1.noteCount, 2);
  assert.equal(d2.depth, 2); assert.equal(d2.noteCount, 2);
  assert.equal(d3.depth, 3); assert.equal(d3.noteCount, 1);
  assert.equal(d3.children.find((n) => n.type === 'dir').depth, 4);
  assert.equal(d2.children.find((n) => n.type === 'note').name, '浅');
});

test('buildTree：空/非法输入返回空树，跳过非法条目、不改入参', () => {
  assert.deepEqual(buildTree([]), []);
  assert.deepEqual(buildTree(null), []);
  assert.deepEqual(buildTree(undefined), []);
  const paths = ['a.md', 123, null, '', '/'];
  const snapshot = paths.slice();
  const tree = buildTree(paths);
  assert.deepEqual(tree.map((n) => n.name), ['a']);
  assert.deepEqual(paths, snapshot, '不改入参');
});

// ==========================================================================
// #62 切片 B：缩进 / 祖先 / 折叠对账 / 本机持久化 / 自动滚动判定
// 无状态纯函数与只碰注入 storage 的边界函数，可在 node --test 里钉住。
// ==========================================================================

function mockStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test('indentFor：1~4 层 12/26/40/54，第 5 层起固定 54 并加折角记号', () => {
  assert.deepEqual(indentFor(1), { px: 12, corner: false });
  assert.deepEqual(indentFor(2), { px: 26, corner: false });
  assert.deepEqual(indentFor(3), { px: 40, corner: false });
  assert.deepEqual(indentFor(4), { px: 54, corner: false });
  for (const d of [5, 6, 9]) {
    assert.deepEqual(indentFor(d), { px: 54, corner: true }, `第 ${d} 层封顶 + 折角`);
  }
});

test('indentFor：非法/缺失 depth 落到第 1 层，不抛', () => {
  assert.deepEqual(indentFor(0), { px: 12, corner: false });
  assert.deepEqual(indentFor(-3), { px: 12, corner: false });
  assert.deepEqual(indentFor(undefined), { px: 12, corner: false });
  assert.deepEqual(indentFor('x'), { px: 12, corner: false });
  assert.deepEqual(indentFor(null), { px: 12, corner: false });
});

test('ancestorsOf：返回笔记路径的各级祖先目录（不含文件、不含根）', () => {
  assert.deepEqual(ancestorsOf('一/二/三/四.md'), ['一', '一/二', '一/二/三']);
  assert.deepEqual(ancestorsOf('日记/2026/a.md'), ['日记', '日记/2026']);
  assert.deepEqual(ancestorsOf('c.md'), []);
});

test('ancestorsOf：空/非法输入返回空数组', () => {
  assert.deepEqual(ancestorsOf(''), []);
  assert.deepEqual(ancestorsOf(null), []);
  assert.deepEqual(ancestorsOf(123), []);
  assert.deepEqual(ancestorsOf('/'), []);
});

test('isAncestor：目录是笔记的上级才成立，根与同名前缀不算', () => {
  assert.equal(isAncestor('一/二', '一/二/三/四.md'), true);
  assert.equal(isAncestor('一', '一/二/三.md'), true);
  assert.equal(isAncestor('一', '一二/三.md'), false, '不能拿字符串前缀当目录');
  assert.equal(isAncestor('', '一/二.md'), false, '根行不参与折叠判定');
  assert.equal(isAncestor('三', '一/二/三.md'), false, '只认从根起的整段前缀');
});

test('reconcileState：找不到的折叠路径静默丢弃、选中文件夹找不到也静默归零', () => {
  const tree = buildTree(['日记/2026/a.md', '项目/b.md', 'c.md']);
  const state = {
    collapsed: new Set(['日记', '日记/2026', '被改名的目录', '已删除']),
    selectedFolder: '被改名的目录',
    selectionMade: true,
  };
  const r = reconcileState(state, tree);
  assert.deepEqual([...r.collapsed].sort(), ['日记', '日记/2026']);
  assert.equal(r.selectedFolder, '');
  assert.equal(r.selectionMade, false);
  assert.equal(r.changed, true);
  assert.equal(state.collapsed.size, 4, '不改入参');
});

test('reconcileState：路径都在时原样保留 changed=false；根选中是合法值不被清理', () => {
  const tree = buildTree(['日记/2026/a.md', '项目/b.md']);
  const r1 = reconcileState({ collapsed: new Set(['日记', '项目']), selectedFolder: '项目', selectionMade: true }, tree);
  assert.deepEqual([...r1.collapsed].sort(), ['日记', '项目']);
  assert.equal(r1.selectedFolder, '项目');
  assert.equal(r1.changed, false);
  const r2 = reconcileState({ collapsed: new Set(['日记']), selectedFolder: '', selectionMade: true }, tree);
  assert.equal(r2.selectedFolder, '', '选中根＝落点仓库根，不能被当成找不到');
  assert.equal(r2.selectionMade, true);
  assert.equal(r2.changed, false);
});

test('loadTreeState：空/坏值/非法 JSON/无 storage 都安全回落到默认', () => {
  const empty = loadTreeState(mockStorage());
  assert.deepEqual([...empty.collapsed], []);
  assert.equal(empty.selectedFolder, '');
  assert.equal(empty.selectionMade, false);
  assert.deepEqual([...loadTreeState(mockStorage({ [TREE_STATE_KEY]: '{坏 json' })).collapsed], []);
  assert.deepEqual([...loadTreeState(mockStorage({ [TREE_STATE_KEY]: 'null' })).collapsed], []);
  assert.equal(loadTreeState(null).selectedFolder, '');
  const broken = { getItem() { throw new Error('blocked'); } };
  assert.equal(loadTreeState(broken).selectionMade, false);
});

test('loadTreeState：坏类型字段被过滤，只收字符串折叠路径', () => {
  const raw = JSON.stringify({ collapsed: ['日记', 123, null, '', '项目'], selectedFolder: '日记', selectionMade: true });
  const s = loadTreeState(mockStorage({ [TREE_STATE_KEY]: raw }));
  assert.deepEqual([...s.collapsed], ['日记', '项目']);
  assert.equal(s.selectedFolder, '日记');
  assert.equal(s.selectionMade, true);
});

test('saveTreeState：写独立键、只存可序列化字段；storage 抛异常静默不炸', () => {
  const s = mockStorage();
  const state = { collapsed: new Set(['日记', '项目']), selectedFolder: '日记', selectionMade: true };
  assert.equal(saveTreeState(s, state), true);
  const wrote = JSON.parse(s._map.get(TREE_STATE_KEY));
  assert.deepEqual(wrote.collapsed, ['日记', '项目']);
  assert.equal(wrote.selectedFolder, '日记');
  assert.equal(wrote.selectionMade, true);
  assert.equal(saveTreeState(null, state), false);
  const broken = { setItem() { throw new Error('quota'); } };
  assert.equal(saveTreeState(broken, state), false);
});

test('折叠状态单独存、不随仓库版本号失效：save 后改缓存头，load 仍拿得到', () => {
  const s = mockStorage();
  saveTreeState(s, { collapsed: new Set(['日记']), selectedFolder: '日记', selectionMade: true });
  // 模拟仓库版本号变化 / 那份缓存被清空，都碰不到折叠记录
  s.setItem('fileIndexCache.v2', JSON.stringify({ head: 'new-head-after-commit' }));
  s.setItem('fileIndexCache.v2', '{}');
  assert.notEqual(TREE_STATE_KEY, 'fileIndexCache.v2');
  assert.ok(!TREE_STATE_KEY.includes('head'), '折叠记录的键不能带版本号');
  const back = loadTreeState(s);
  assert.deepEqual([...back.collapsed], ['日记']);
  assert.equal(back.selectedFolder, '日记');
  assert.equal(back.selectionMade, true);
});

test('shouldAutoScroll：就绪 + 有当前篇 + 用户没手动滚过才自动定位', () => {
  assert.equal(shouldAutoScroll({ status: 'ready', currentPath: '一/二.md', userScrolled: false }), true);
  assert.equal(shouldAutoScroll({ status: 'ready', currentPath: '一/二.md', userScrolled: true }), false, '手动滚过不抢回');
  assert.equal(shouldAutoScroll({ status: 'loading', currentPath: '一/二.md', userScrolled: false }), false);
  assert.equal(shouldAutoScroll({ status: 'offline', currentPath: '一/二.md', userScrolled: false }), false);
  assert.equal(shouldAutoScroll({ status: 'ready', currentPath: '', userScrolled: false }), false, '没有打开的那篇不定位');
  assert.equal(shouldAutoScroll(null), false);
});

// ==========================================================================
// #62 切片 C：摊平可见行 / 树行 HTML / 加载三态
// 渲染是能从 DOM 抽出来的纯函数：字符串产物能在 node 里钉住结构与记号。
// ==========================================================================

test('flattenVisible：根行在第一行，只有显式选中根时才带 selected', () => {
  const tree = buildTree(['日记/2026/a.md', 'c.md']);
  const rows = flattenVisible(tree, { collapsed: new Set(), currentPath: '', selectedFolder: '', selectionMade: false });
  assert.equal(rows[0].name, '根目录');
  assert.equal(rows[0].path, '');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[0].noteCount, 2);
  assert.equal(rows[0].selected, false, '没显式选中就不高亮');
  const rows2 = flattenVisible(tree, { collapsed: new Set(), selectedFolder: '', selectionMade: true });
  assert.equal(rows2[0].selected, true, '点过根行后根可选中');
});

test('flattenVisible：折叠的目录不铺开子树，展开的照直铺', () => {
  const tree = buildTree(['日记/2026/a.md', '日记/b.md', '项目/c.md']);
  const rows = flattenVisible(tree, { collapsed: new Set(['日记']), currentPath: '' });
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('日记'));
  assert.ok(names.includes('项目'));
  assert.ok(!names.includes('2026'), '折上的目录子树不出现');
  assert.ok(!names.includes('a'));
  assert.ok(!names.includes('b'));
});

test('flattenVisible：打开的那篇压过手动折叠，那一支仍强制展开', () => {
  const tree = buildTree(['日记/2026/a.md', '项目/c.md']);
  const rows = flattenVisible(tree, {
    collapsed: new Set(['日记', '日记/2026']),
    currentPath: '日记/2026/a.md',
  });
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('2026'), '当前篇祖先折不上');
  assert.ok(names.includes('a'));
  assert.equal(rows.find((r) => r.current).path, '日记/2026/a.md');
});

test('flattenVisible：缩进 12/26/40/54 封顶，第 5 层起带折角记号', () => {
  const tree = buildTree(['一/二/三/四/五/六.md', 'top.md']);
  const rows = flattenVisible(tree, { collapsed: new Set(), currentPath: '' });
  const byDepth = {};
  for (const r of rows) if (!r.isRoot) byDepth[r.depth] = r;
  assert.equal(byDepth[1].indentPx, 12);
  assert.equal(byDepth[2].indentPx, 26);
  assert.equal(byDepth[3].indentPx, 40);
  assert.equal(byDepth[4].indentPx, 54);
  assert.equal(byDepth[5].indentPx, 54, '第 5 层不再加缩进');
  assert.equal(byDepth[5].corner, true, '第 5 层加折角记号');
  assert.equal(byDepth[4].corner, false);
});

test('flattenVisible：197 篇大目录照直铺、不分段、不造假节点', () => {
  const paths = Array.from({ length: 197 }, (_, i) => '大目录/第' + String(i).padStart(3, '0') + '篇.md');
  const rows = flattenVisible(buildTree(paths), { collapsed: new Set(), currentPath: '' });
  assert.equal(rows.length, 199, '根行 + 1 个目录 + 197 篇');
  assert.equal(rows.filter((r) => r.type === 'note').length, 197);
  assert.ok(rows.filter((r) => r.type === 'note').every((r) => !r.isRoot));
});

test('flattenVisible：选中文件夹与正在读那篇各带各的记号，互不覆盖', () => {
  const tree = buildTree(['日记/a.md', 'b.md']);
  const rows = flattenVisible(tree, {
    collapsed: new Set(), currentPath: '日记/a.md',
    selectedFolder: '日记', selectionMade: true,
  });
  assert.equal(rows.find((r) => r.path === '日记').selected, true);
  assert.equal(rows.find((r) => r.path === '日记/a.md').current, true);
});

test('rowHtml：文件夹行是带 data-tree-dir 的按钮，笔记行是 #/edit 链接', () => {
  const dirHtml = rowHtml({
    type: 'dir', name: '日记', path: '日记', depth: 1, noteCount: 2,
    indentPx: 12, corner: false, expanded: true, selected: false, current: false,
  });
  assert.match(dirHtml, /<button/);
  assert.match(dirHtml, /data-tree-dir="日记"/);
  assert.match(dirHtml, /style="padding-left:12px"/);
  assert.match(dirHtml, /class="tree-count">2</);
  assert.match(dirHtml, /class="tree-chevron"/);
  assert.match(dirHtml, /width="12"/, '展开箭头 12px');
  assert.match(dirHtml, /width="18"/, '文件夹图标 18px');
  const noteHtml = rowHtml({
    type: 'note', name: 'a', path: '日记/a.md', depth: 2, noteCount: 1,
    indentPx: 26, corner: false, expanded: false, selected: false, current: true,
  });
  assert.match(noteHtml, /<a /);
  assert.match(noteHtml, /href="#\/edit\//);
  assert.match(noteHtml, /data-tree-current="1"/);
  assert.match(noteHtml, /style="padding-left:26px"/);
});

test('rowHtml：第 5 层折角是独立 span、不是图标、不挂点击钩子', () => {
  const html = rowHtml({
    type: 'note', name: '深', path: '一/二/三/四/五.md', depth: 5,
    indentPx: 54, corner: true, expanded: false, selected: false, current: false,
  });
  const m = html.match(/<span class="tree-corner"[^>]*><\/span>/);
  assert.ok(m, '折角记号存在');
  assert.doesNotMatch(m[0], /svg|data-tree-dir|href/);
  assert.doesNotMatch(html, /tree-corner[^>]*data-tree-dir/);
});

test('rowHtml：名字转义、长名字整串保留不截断、计数不压名字', () => {
  const long = '这是一篇非常长的名字'.repeat(10) + '&<"';
  const html = rowHtml({
    type: 'note', name: long, path: 'x.md', depth: 1,
    indentPx: 12, corner: false, selected: false, current: false, expanded: false,
  });
  assert.ok(html.includes('&amp;&lt;&quot;'), '名字里的 HTML 元字符要转义');
  assert.ok(html.includes('这是一篇非常长的名字'.repeat(10)), '长名字整串保留');
  assert.ok(!html.includes('…'), '不做省略号截断');
  assert.match(html, /class="tree-name">/);
  assert.doesNotMatch(html, /class="tree-name"[^>]*>\d+<\/span>/, '计数不塞进名字里');
});

test('rowHtml：树行不挂常驻 ⋯；选中与当前两个记号可同时落一行', () => {
  const both = rowHtml({
    type: 'dir', name: '日记', path: '日记', depth: 1, indentPx: 12,
    corner: false, expanded: true, selected: true, current: true,
  });
  assert.match(both, /is-selected/);
  assert.match(both, /is-current/, '两种记号同时在一行');
  const plain = rowHtml({
    type: 'dir', name: '日记', path: '日记', depth: 1, indentPx: 12,
    corner: false, expanded: true, selected: false, current: false,
  });
  assert.ok(!plain.includes('⋯'), '不挂常驻 ⋯');
  assert.ok(!/data-tree-more|data-act="more"/.test(plain));
});

test('renderTreeHtml：加载态说清在等什么、两条静态占位、不画空树不说没有笔记', () => {
  const html = renderTreeHtml({ status: 'loading', tree: buildTree(['a.md']) });
  assert.match(html, /正在读取笔记名单/);
  assert.equal((html.match(/class="tree-skeleton"/g) || []).length, 2, '两条固定高度占位');
  assert.ok(!html.includes('没有笔记'), '不许说成没有笔记');
  assert.match(html, /data-tree-status="loading"(?![^>]*hidden)/, '加载块可见');
  assert.match(html, /<div class="tree-rows"[^>]* hidden><\/div>/, '树行容器收起且不画一行');
  assert.doesNotMatch(html, /<(button|a)[^>]*tree-row/, '加载态不画任何树行');
  assert.ok(!html.includes('shimmer'), '不用闪烁动画');
});

test('renderTreeHtml：断网明说连不上 + 重试，不说没有笔记、不画空树、不用过期名单', () => {
  const html = renderTreeHtml({ status: 'offline', tree: buildTree(['a.md']) });
  assert.match(html, /连不上/);
  assert.match(html, /data-tree-retry/);
  assert.ok(!html.includes('没有笔记'));
  assert.match(html, /data-tree-status="offline"(?![^>]*hidden)/, '断网块可见');
  assert.match(html, /<div class="tree-rows"[^>]* hidden><\/div>/, '不画树行、不拿过期名单硬画');
  assert.doesNotMatch(html, /<(button|a)[^>]*tree-row/);
});

test('renderTreeHtml：就绪态画树行、两个状态块都收起', () => {
  const html = renderTreeHtml({
    status: 'ready', tree: buildTree(['日记/a.md', 'c.md']), collapsed: new Set(),
    currentPath: '日记/a.md', selectedFolder: '日记', selectionMade: true,
  });
  assert.match(html, /class="tree-row/);
  assert.match(html, /data-tree-dir="日记"/);
  assert.match(html, /data-tree-current="1"/);
  assert.match(html, /data-tree-status="loading"[^>]*hidden/);
  assert.match(html, /data-tree-status="offline"[^>]*hidden/);
  assert.match(html, /<div class="tree-rows">/, '就绪态树行容器可见');
});

test('renderTreeHtml：加载↔就绪切换时三个容器始终常驻，不增删节点不闪', () => {
  const loading = renderTreeHtml({ status: 'loading', tree: [] });
  const ready = renderTreeHtml({ status: 'ready', tree: buildTree(['a.md']) });
  const blocks = (h) => (h.match(/data-tree-status="|class="tree-rows"/g) || []);
  assert.equal(blocks(loading).length, 3);
  assert.equal(blocks(ready).length, 3, '两态容器数量一致，只切 hidden');
  assert.match(loading, /<div class="tree">/);
  assert.match(ready, /<div class="tree">/);
});

// ==========================================================================
// #62 切片 D：状态机 / 跨票接口 / DOM 接线（注入假依赖，可在 node 里跑）
// ==========================================================================

function mockTreeDoc() {
  const nodes = {
    'tree-view': { innerHTML: '' },
    'sidebar-content': { scrollTop: 0 },
  };
  const listeners = {};
  const scrolled = [];
  return {
    getElementById: (id) => nodes[id] || null,
    querySelector: (sel) => (sel === '[data-tree-current="1"]'
      ? { scrollIntoView: (o) => scrolled.push(o || {}) } : null),
    addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); },
    _nodes: nodes, _listeners: listeners, _scrolled: scrolled,
    _emit(type, e) { for (const fn of (listeners[type] || [])) fn(e); },
  };
}

function makeCtl(overrides) {
  const o = overrides || {};
  const doc = o.doc || mockTreeDoc();
  const storage = o.storage || mockStorage();
  const ctl = createTreeController({
    doc, storage,
    getNotePaths: o.getNotePaths || (() => ['日记/a.md', 'c.md']),
    reloadIndex: o.reloadIndex,
    getCurrentNote: o.getCurrentNote || (() => ''),
  });
  return { ctl, doc, storage };
}

test('createTreeController：初始加载态，onLoading 后侧栏说清在等什么、不画空树', () => {
  const { ctl, doc } = makeCtl();
  assert.equal(ctl.model.status, 'loading');
  assert.equal(ctl.model.selectedFolder, '');
  assert.equal(ctl.model.selectionMade, false);
  ctl.onLoading();
  const html = doc._nodes['tree-view'].innerHTML;
  assert.match(html, /正在读取笔记名单/);
  assert.match(html, /<div class="tree-rows"[^>]* hidden><\/div>/);
  assert.doesNotMatch(html, /<(button|a)[^>]*tree-row/);
});

test('onReady：从本机名单建树、切就绪态、画出行，三态容器只切 hidden', () => {
  const { ctl, doc } = makeCtl();
  ctl.onReady();
  assert.equal(ctl.model.status, 'ready');
  assert.deepEqual(ctl.model.notePaths, ['日记/a.md', 'c.md']);
  const html = doc._nodes['tree-view'].innerHTML;
  assert.match(html, /data-tree-dir="日记"/);
  assert.match(html, /href="#\/edit\//);
  assert.match(html, /<div class="tree-rows">/);
  assert.match(html, /data-tree-status="loading"[^>]*hidden/);
  assert.match(html, /data-tree-status="offline"[^>]*hidden/);
});

test('onOffline：明说连不上 + 重试，不画空树、不拿过期名单硬画', () => {
  const { ctl, doc } = makeCtl();
  ctl.onReady();
  ctl.onOffline();
  assert.equal(ctl.model.status, 'offline');
  assert.deepEqual(ctl.model.tree, [], '断网时清掉名单');
  const html = doc._nodes['tree-view'].innerHTML;
  assert.match(html, /连不上/);
  assert.match(html, /data-tree-retry/);
  assert.doesNotMatch(html, /<(button|a)[^>]*tree-row/);
});

test('refreshTree：写后就地重建全库名单，成功后树立刻是新世界，不等切后台', async () => {
  let paths = ['旧/a.md'];
  let reloads = 0;
  const { ctl, doc } = makeCtl({
    getNotePaths: () => paths,
    reloadIndex: () => { reloads += 1; paths = ['旧/a.md', '新/刚建的.md']; return Promise.resolve(); },
  });
  ctl.onReady();
  assert.match(doc._nodes['tree-view'].innerHTML, /旧/);
  ctl.refreshTree();
  assert.equal(reloads, 1, '只经 reloadIndex 重建，零新增取数请求');
  assert.equal(ctl.model.status, 'loading', '重拉期间保持加载态');
  await new Promise((r) => setImmediate(r));
  assert.equal(ctl.model.status, 'ready');
  assert.match(doc._nodes['tree-view'].innerHTML, /刚建的/);
});

test('refreshTree：重拉失败进断网态，不拿过期名单硬画', async () => {
  const { ctl, doc } = makeCtl({
    getNotePaths: () => ['旧/a.md'],
    reloadIndex: () => Promise.reject(new Error('offline')),
  });
  ctl.onReady();
  ctl.refreshTree();
  await new Promise((r) => setImmediate(r));
  assert.equal(ctl.model.status, 'offline');
  assert.match(doc._nodes['tree-view'].innerHTML, /连不上/);
  assert.doesNotMatch(doc._nodes['tree-view'].innerHTML, /旧/);
});

test('setSelectedFolder：选中状态写进本机记录，换 controller 用同一 storage 能读回', () => {
  const storage = mockStorage();
  const first = makeCtl({ storage, doc: mockTreeDoc() });
  first.ctl.onReady();
  first.ctl.setSelectedFolder('日记');
  assert.equal(first.ctl.getSelectedFolder(), '日记');
  const saved = JSON.parse(storage._map.get(TREE_STATE_KEY));
  assert.equal(saved.selectedFolder, '日记');
  assert.equal(saved.selectionMade, true);
  const second = makeCtl({ storage, doc: mockTreeDoc() });
  assert.equal(second.ctl.getSelectedFolder(), '日记', '跨会话恢复');
  assert.equal(second.ctl.model.selectionMade, true);
});

test('selectPath：祖先全展开、那行高亮、选中退回所在文件夹、自动滚到附近', () => {
  const { ctl, doc } = makeCtl({ getNotePaths: () => ['一/二/三/深.md', '项目/x.md'] });
  ctl.onReady();
  ctl.model.collapsed.add('一');
  ctl.model.collapsed.add('一/二');
  ctl.selectPath('一/二/三/深.md');
  assert.equal(ctl.model.currentPath, '一/二/三/深.md');
  assert.equal(ctl.model.selectedFolder, '一/二/三');
  assert.ok(!ctl.model.collapsed.has('一'), '祖先全展开');
  assert.ok(!ctl.model.collapsed.has('一/二'));
  assert.equal(doc._scrolled.length, 1, '滚到当前篇附近');
  assert.match(doc._nodes['tree-view'].innerHTML, /data-tree-current="1"/);
});

test('selectPath：同一次拉开期间手动滚过就不被抢回', () => {
  const { ctl, doc } = makeCtl({ getNotePaths: () => ['一/二/深.md'] });
  ctl.onReady();
  ctl.markUserScrolled();
  ctl.selectPath('一/二/深.md');
  assert.equal(doc._scrolled.length, 0, '用户手动滚过，不自动抢回');
});

test('selectPath：打开的那篇压过手动折叠（那支实际折不上）', () => {
  const { ctl, doc } = makeCtl({ getNotePaths: () => ['日记/2026/a.md'] });
  ctl.onReady();
  ctl.selectPath('日记/2026/a.md');
  ctl.onFolderClick('日记');        // 事后手动折当前篇那一支
  ctl.onFolderClick('日记/2026');
  assert.match(doc._nodes['tree-view'].innerHTML, /data-tree-current="1"/, '当前篇仍展开可见');
});

test('onFolderClick：点一下展开 + 选中同时发生；再点折上但选中与落点保留', () => {
  const { ctl, doc } = makeCtl();
  ctl.onReady();
  ctl.model.collapsed.add('日记');
  ctl.onFolderClick('日记');
  assert.ok(!ctl.model.collapsed.has('日记'), '展开');
  assert.equal(ctl.getSelectedFolder(), '日记', '同时选为选中的文件夹');
  assert.match(doc._nodes['tree-view'].innerHTML, /is-selected/);
  ctl.onFolderClick('日记');
  assert.ok(ctl.model.collapsed.has('日记'), '折上');
  assert.equal(ctl.getSelectedFolder(), '日记', '选中保留');
});

test('onFolderClick：根目录行同样可选中（落点＝根）', () => {
  const { ctl, doc } = makeCtl();
  ctl.onReady();
  ctl.onFolderClick('');
  assert.equal(ctl.getSelectedFolder(), '');
  assert.equal(ctl.model.selectionMade, true);
  assert.match(doc._nodes['tree-view'].innerHTML, /is-selected/);
});

test('DOM 接线：点文件夹行走 data-tree-dir 委托，点重试走 data-tree-retry', () => {
  const { ctl, doc } = makeCtl({
    getNotePaths: () => ['日记/a.md'],
    reloadIndex: () => Promise.resolve(),
  });
  ctl.onReady();
  doc._emit('click', { target: { closest: (sel) => (sel === '[data-tree-dir]' ? { dataset: { treeDir: '日记' } } : null) } });
  assert.equal(ctl.getSelectedFolder(), '日记');
  doc._emit('click', { target: { closest: (sel) => (sel === '[data-tree-retry]' ? {} : null) } });
  assert.equal(ctl.model.status, 'loading', '重试进加载态');
});

test('notifySidebarShown：侧栏每次出现重置滚动保护、按打开的那篇重新摆好', () => {
  const { ctl, doc } = makeCtl({ getNotePaths: () => ['日记/2026/a.md'] });
  ctl.onReady();
  ctl.selectPath('日记/2026/a.md');
  ctl.markUserScrolled();     // 这次拉开里手动滚开
  ctl.onFolderClick('日记');  // 手动把当前篇那支折一下
  ctl.notifySidebarShown();   // 下一次拉开
  assert.equal(ctl.model.userScrolled, false, '新一次拉开重置');
  assert.ok(doc._scrolled.length >= 1, '重新定位');
  assert.match(doc._nodes['tree-view'].innerHTML, /data-tree-current="1"/);
});

test('找不到路径静默丢弃：旧折叠/选中在名单里不存在时不报错不提示', () => {
  const storage = mockStorage();
  saveTreeState(storage, {
    collapsed: new Set(['被改名的目录', '日记']),
    selectedFolder: '被改名的目录', selectionMade: true,
  });
  const { ctl } = makeCtl({ storage, getNotePaths: () => ['日记/a.md', 'c.md'] });
  assert.doesNotThrow(() => ctl.onReady());
  assert.deepEqual([...ctl.model.collapsed], ['日记']);
  assert.equal(ctl.model.selectedFolder, '');
  assert.equal(ctl.model.selectionMade, false);
  const saved = JSON.parse(storage._map.get(TREE_STATE_KEY));
  assert.deepEqual(saved.collapsed, ['日记'], '对账结果静默落盘');
});

test('initTree 模块级转发：导出名指向真实现（选中落本机记录、刷新不抛）', () => {
  const storage = mockStorage();
  const doc = mockTreeDoc();
  initTree({ doc, storage, getNotePaths: () => ['a.md'], reloadIndex: () => Promise.resolve() });
  setSelectedFolder('日记');
  assert.equal(getSelectedFolder(), '日记');
  assert.equal(JSON.parse(storage._map.get(TREE_STATE_KEY)).selectedFolder, '日记');
  assert.doesNotThrow(() => refreshTree());
  assert.doesNotThrow(() => selectPath('a.md'));
  assert.doesNotThrow(() => notifySidebarShown());
});

test('notifySidebarShown：侧栏出现时用最新全库名单重画（配合 recheckRepo 重建）', () => {
  let paths = ['旧/a.md'];
  const { ctl, doc } = makeCtl({ getNotePaths: () => paths });
  ctl.onReady();
  paths = ['新/b.md']; // 模拟切回前台 head 变了、ensureIndex({force:true}) 换了名单
  ctl.notifySidebarShown();
  const html = doc._nodes['tree-view'].innerHTML;
  assert.match(html, /新/);
  assert.doesNotMatch(html, /旧/);
});

test('syncPaths 幂等：名单没换时不重算、状态不丢', () => {
  const paths = ['日记/a.md'];
  const { ctl } = makeCtl({ getNotePaths: () => paths });
  ctl.onReady();
  const treeRef = ctl.model.tree;
  ctl.onReady();
  assert.equal(ctl.model.tree, treeRef, '同一份名单不重建树');
  assert.equal(ctl.model.status, 'ready');
});
