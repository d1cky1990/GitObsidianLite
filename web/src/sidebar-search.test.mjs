// sidebar-search.js 的规则测试（#63）。
//
// 工单 #63 里能从 DOM 抽出来的纯逻辑：放大镜 ↔ 输入框的六行点/滑决策、
// 框外判定、搜索四态文案、只搜标题与路径且不截断、结果 HTML、新建按钮隐藏、
// 点叉只清词。断言的是行为 / 文案 / 结构（附录 C 定稿字面），不是重算实现。
// DOM 交互、跨模块接线、真输入法组字、点击坐标留真浏览器 / 真机验。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_COPY, GESTURES,
  decideOutsideGesture, classifyTapRegion,
  runTitleSearch, searchStatus, searchResultHtml, searchResultsHtml,
  shouldHideNewButton, decideClear,
} from './sidebar-search.js';

/* ---------- 四态文案（附录 C 定稿字面，互不冒充） ---------- */

test('SEARCH_COPY：四态文案是定值、两两不同、语气合规', () => {
  assert.equal(SEARCH_COPY.checking, '正在确认网络…');
  assert.equal(SEARCH_COPY.offline, '连不上服务端，搜索暂时用不了。恢复联网后再试。');
  assert.equal(SEARCH_COPY.empty, '标题和路径里都没有');
  assert.equal(SEARCH_COPY.loading, '文件名单还在加载…');
  const vals = Object.values(SEARCH_COPY);
  assert.equal(new Set(vals).size, 4, '四态两两不同，不许互相冒充');
  for (const v of vals) assert.ok(!/[!！]/.test(v), '不用感叹号：' + v);
});

test('GESTURES：三种手势定值', () => {
  assert.deepEqual(GESTURES, ['tap-blank', 'tap-clickable', 'scroll']);
});

/* ---------- 六行点/滑表（设计任务书 §3.2） ---------- */

test('点/滑六行：框空 / 有词 × 点空白 / 点可点物 / 滑，逐行对表', () => {
  // 框空三种 → 收成放大镜；blur 恒真；keepQuery 为假
  for (const gesture of GESTURES) {
    const d = decideOutsideGesture({ hasQuery: false, gesture });
    assert.equal(d.collapse, true, '框空 ' + gesture + '：收成放大镜');
    assert.equal(d.keepQuery, false, '框空 ' + gesture + '：词与结果不留');
    assert.equal(d.blur, true, '框空 ' + gesture + '：取消输入状态');
  }
  // 有词三种 → 只失焦、框与词与结果都留着（不收）
  for (const gesture of GESTURES) {
    const d = decideOutsideGesture({ hasQuery: true, gesture });
    assert.equal(d.collapse, false, '有词 ' + gesture + '：不收成放大镜');
    assert.equal(d.keepQuery, true, '有词 ' + gesture + '：框与词与结果留着');
    assert.equal(d.blur, true, '有词 ' + gesture + '：只取消输入状态（失焦）');
  }
});

test('点/滑六行：点可点物叠加执行、滑动照常滚，收起不打断滚动', () => {
  for (const hasQuery of [false, true]) {
    const clickable = decideOutsideGesture({ hasQuery, gesture: 'tap-clickable' });
    assert.equal(clickable.letClickableRun, true, '那个东西照常触发');
    assert.equal(clickable.letScrollRun, false);
    const scroll = decideOutsideGesture({ hasQuery, gesture: 'scroll' });
    assert.equal(scroll.letScrollRun, true, '列表照常滚');
    assert.equal(scroll.letClickableRun, false);
  }
});

test('点/滑六行：只有「框空 + 点空白」回目录树；点可点物 / 滑动不抢 view', () => {
  // 点可点物（点设置 / 点结果 / 点新建 / 点关闭键 / 点遮罩）由那个东西决定 view，
  // 滑动时列表照常滚、收起不打断滚动 —— 这两种都不该顺手把 view 抢回树。
  assert.equal(decideOutsideGesture({ hasQuery: false, gesture: 'tap-blank' }).backToTree, true);
  assert.equal(decideOutsideGesture({ hasQuery: false, gesture: 'tap-clickable' }).backToTree, false);
  assert.equal(decideOutsideGesture({ hasQuery: false, gesture: 'scroll' }).backToTree, false);
  for (const gesture of GESTURES) {
    assert.equal(decideOutsideGesture({ hasQuery: true, gesture }).backToTree, false);
  }
});

test('点/滑六行：未知手势按「点空白」兜底，不抛', () => {
  const d = decideOutsideGesture({ hasQuery: false, gesture: 'whatever' });
  assert.equal(d.collapse, true);
  assert.equal(d.backToTree, false, '未知手势不擅自抢 view');
});

/* ---------- 框外判定 ---------- */

test('classifyTapRegion：点叉、点框内、输入法键盘都不算框外', () => {
  assert.deepEqual(
    classifyTapRegion({ inSearchRow: true, onClearButton: true, isImeKeyboard: false }),
    { outside: false, isClear: true }, '点叉不算框外，且是要清词');
  assert.equal(classifyTapRegion({ inSearchRow: true }).outside, false, '点搜索框内部不算框外');
  assert.equal(classifyTapRegion({ isImeKeyboard: true }).outside, false, '输入法键盘不算框外');
  assert.equal(classifyTapRegion({}).outside, true, '其余都算框外');
  assert.equal(classifyTapRegion({ onClearButton: true, isImeKeyboard: true }).isClear, true,
    '点叉优先级最高');
});

/* ---------- 只搜标题与路径、零新增请求、结果不截断、按路径序 ---------- */

test('runTitleSearch：905 篇量级搜常见词一条不少（不许截成 60/100 条）', () => {
  // searchTitles 默认 limit=100；本票必须显式传不截断。造 150 篇全部命中。
  const paths = Array.from({ length: 150 }, (_, i) =>
    '笔记/' + String(i).padStart(3, '0') + '.md');
  const hits = runTitleSearch(paths, '笔记');
  assert.equal(hits.length, 150, '一条不少');
  assert.ok(hits.every((h) => h.path.startsWith('笔记/')), '命中都来自标题/路径');
});

test('runTitleSearch：结果按路径序、大小写不敏感、空词返回空', () => {
  const paths = ['b/z.md', 'a/中.md', 'b/a.md', 'a/a.md'];
  const hits = runTitleSearch(paths, 'a');
  const seq = hits.map((h) => h.path);
  assert.deepEqual(seq, [...seq].sort((x, y) => x.localeCompare(y)), '按路径序，一组不分组');
  assert.deepEqual(runTitleSearch(['ABC.md', 'xyz.md'], 'abc').map((h) => h.path), ['ABC.md']);
  assert.deepEqual(runTitleSearch(paths, ''), []);
  assert.deepEqual(runTitleSearch(paths, '   '), []);
});

test('runTitleSearch：坏输入不抛（名单为 null / 非数组）', () => {
  assert.deepEqual(runTitleSearch(null, 'a'), []);
  assert.deepEqual(runTitleSearch(undefined, 'a'), []);
});

/* ---------- 四态判定：互不冒充、断网不硬搜 ---------- */

test('searchStatus：S-1 正在确认网络（online=null）', () => {
  const s = searchStatus({ online: null, indexReady: true, hits: [{ path: 'a.md' }] });
  assert.equal(s.kind, 'checking');
  assert.equal(s.text, SEARCH_COPY.checking);
});

test('searchStatus：S-2 断网优先于结果，不许拿过期名单硬搜', () => {
  const s = searchStatus({ online: false, indexReady: true, hits: [{ path: 'a.md' }] });
  assert.equal(s.kind, 'offline');
  assert.equal(s.text, SEARCH_COPY.offline);
  assert.ok(!s.text.includes('标题和路径里都没有'), '断网不冒充无结果');
});

test('searchStatus：S-4 名单未到（online 且 index 未就绪）', () => {
  const s = searchStatus({ online: true, indexReady: false, hits: [] });
  assert.equal(s.kind, 'loading');
  assert.equal(s.text, SEARCH_COPY.loading);
});

test('searchStatus：S-3 三者齐备且没命中才说「标题和路径里都没有」', () => {
  const s = searchStatus({ online: true, indexReady: true, hits: [] });
  assert.equal(s.kind, 'empty');
  assert.equal(s.text, SEARCH_COPY.empty);
});

test('searchStatus：有命中 → results（不再挂分组标题）', () => {
  const s = searchStatus({ online: true, indexReady: true, hits: [{ path: 'a.md' }] });
  assert.equal(s.kind, 'results');
});

/* ---------- 结果 HTML：一组、名字+父目录、转义、不截断 ---------- */

test('searchResultHtml：名字 + 一行父目录，点一条在右边打开（href 到 #/edit/）', () => {
  const html = searchResultHtml({ path: '日记/2026/05-14.md', name: '05-14', dir: '日记/2026' });
  assert.ok(html.includes('href="#/edit/'));
  assert.ok(html.includes('05-14'), '名字在');
  assert.ok(html.includes('日记/2026'), '父目录在（112 组同名靠它分）');
  assert.ok(html.includes('data-sb-hit='), '带路径供点击打开');
  assert.ok(!html.includes('分组') && !/<h[1-6]/.test(html), '不挂分组标题');
});

test('searchResultHtml：路径做 HTML 转义，防注入', () => {
  const bad = 'a/"><script>alert(1)</script>.md';
  const html = searchResultHtml({ path: bad, name: bad, dir: bad });
  assert.ok(!html.includes('<script>'), '没有裸 script');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&quot;'));
});

test('searchResultsHtml：四态各自出文案，结果时一组铺开且不截断', () => {
  assert.ok(searchResultsHtml({ online: null, indexReady: true, hits: [] }).includes('正在确认网络'));
  assert.ok(searchResultsHtml({ online: false, indexReady: true, hits: [] }).includes('连不上'));
  assert.ok(searchResultsHtml({ online: true, indexReady: false, hits: [] }).includes('名单还在加载'));
  assert.ok(searchResultsHtml({ online: true, indexReady: true, hits: [] }).includes('标题和路径里都没有'));

  const hits = Array.from({ length: 120 }, (_, i) => ({
    path: 'n/' + String(i).padStart(3, '0') + '.md',
    name: String(i), dir: 'n',
  }));
  const html = searchResultsHtml({ online: true, indexReady: true, hits });
  assert.equal((html.match(/class="res /g) || []).length, 120, '120 条一条不少');
  assert.ok(!html.includes('还有') && !html.includes('分组'), '不截断、不挂分组标题');
});

/* ---------- 有词时「新建」隐藏、「设置」仍在 ---------- */

test('shouldHideNewButton：有词隐藏新建，空/空白词不隐藏；设置永远在', () => {
  assert.equal(shouldHideNewButton('abc'), true);
  assert.equal(shouldHideNewButton('  中  '), true);
  assert.equal(shouldHideNewButton(''), false);
  assert.equal(shouldHideNewButton('   '), false);
  assert.equal(shouldHideNewButton(null), false);
});

/* ---------- 点叉：只清词、焦点与键盘留着、词空回树、不换输入节点 ---------- */

test('decideClear：点叉只清当前词，焦点/键盘留着，回目录树，不重建输入框', () => {
  const d = decideClear();
  assert.equal(d.clearInput, true, '清词');
  assert.equal(d.keepFocus, true, '焦点与键盘留着，人能接着打');
  assert.equal(d.backToTree, true, '词一空回树');
  assert.equal(d.rebuildInput, false, '绝不换掉正在打字的输入框节点');
  assert.equal(d.collapse, false, '点叉不算框外，不收成放大镜');
});
