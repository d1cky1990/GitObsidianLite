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
  shouldAutoScroll, TREE_STATE_KEY,
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
