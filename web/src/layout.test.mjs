// layout.js 的规则测试。
//
// 骨架 HTML 是纯函数产物，能在 node --test 里钉住结构：容器齐、输入框常驻、
// 「有/没有」切 hidden、图标自绘离线、开合只靠按钮。mountShell 的幂等性与
// 三块内容切换也钉住——骨架只许建一次，重画不许再生成第二套 #app 或换节点。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEBAR_BREAKPOINT, SIDEBAR_VIEWS, shellHtml, mountShell, showSidebarView, initLayout,
} from './layout.js';

test('断点是 900px，接线入口齐，三块内容名固定', () => {
  assert.equal(SIDEBAR_BREAKPOINT, 900);
  assert.equal(typeof initLayout, 'function');
  assert.equal(typeof showSidebarView, 'function');
  assert.deepEqual(SIDEBAR_VIEWS, ['tree', 'search', 'settings']);
});

test('骨架容器齐：侧栏三块内容容器、正文内容区、遮罩、提示条都在', () => {
  const html = shellHtml();
  for (const id of [
    'sidebar', 'sidebar-title', 'search-toggle', 'search-row', 'sidebar-q', 'sidebar-q-clear',
    'sidebar-content', 'tree-view', 'search-results', 'settings-view',
    'sidebar-foot', 'btn-new', 'btn-settings',
    'scrim', 'main', 'btn-open', 'btn-close', 'doc-parent', 'doc-title', 'btn-more',
    'app', 'edit-actions', 'toast-host',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `骨架缺 #${id}`);
  }
});

test('开合只靠按钮：七个 data-shell 钩子齐，不做边缘滑动', () => {
  const html = shellHtml();
  for (const act of ['open', 'close', 'search', 'clear', 'new', 'settings', 'more']) {
    assert.ok(html.includes(`data-shell="${act}"`), `骨架缺 data-shell=${act}`);
  }
  assert.ok(!/touchstart|swipe|edge-gesture/i.test(html), '不许挂边缘滑动手势');
});

test('输入节点常驻、有/没有切 hidden，不靠增删节点', () => {
  const html = shellHtml();
  // 搜索输入框自始至终在 DOM 里，是个真的 text input（独立 id，不与旧列表页 #q 重名）
  assert.match(html, /<input id="sidebar-q"[^>]*type="text"/);
  // 这几块初始收起，靠 hidden 切（作者样式里带 display 的会盖掉默认，style.css 补 !important）
  for (const id of [
    'sidebar', 'scrim', 'search-row', 'btn-close', 'edit-actions',
    'search-results', 'settings-view', 'doc-parent',
  ]) {
    const re = new RegExp(`<[^>]*id="${id}"[^>]*>`);
    const m = html.match(re);
    assert.ok(m, `找不到 #${id} 的开标签`);
    assert.match(m[0], /\bhidden\b/, `#${id} 初始该 hidden`);
  }
  // 树是默认显示的那块，不该 hidden
  const tree = html.match(/<[^>]*id="tree-view"[^>]*>/);
  assert.ok(tree);
  assert.doesNotMatch(tree[0], /\bhidden\b/, '树默认显示');
});

test('图标全部内联自绘 SVG，离线可用、不用字符或 emoji', () => {
  const html = shellHtml();
  assert.match(html, /<svg /);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.doesNotMatch(html, /https?:|url\(|<img|<image|@font-face|class="fa/i);
  for (const ch of ['✕', '＋', '⚙', '▸', '✓', '·', '☰']) {
    assert.ok(!html.includes(ch), `骨架不该用 ${ch} 当图标`);
  }
});

function mockHost() {
  return {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    querySelector(sel) {
      if (sel === '#app' && this._html.includes('id="app"')) return { id: 'app' };
      return null;
    },
  };
}

test('mountShell 幂等：只建一次骨架，返回 #app，重复调用不重建', () => {
  const host = mockHost();
  const app = mountShell(host);
  assert.ok(app, '挂载后要拿得到 #app');
  assert.match(host.innerHTML, /id="app"/);

  host._html += '<!-- sentinel -->';
  const again = mountShell(host);
  assert.ok(again);
  assert.match(host.innerHTML, /sentinel/, '重复挂载不许把已有骨架 / 后人追加的东西冲掉');
});

function mockDoc() {
  const nodes = {
    'tree-view': { hidden: false },
    'search-results': { hidden: true },
    'settings-view': { hidden: true },
  };
  return { getElementById: (id) => nodes[id] || null, _nodes: nodes };
}

test('三块内容切换只切 hidden、不换节点，未知名回落树', () => {
  const doc = mockDoc();
  const tree = doc._nodes['tree-view'], search = doc._nodes['search-results'];

  assert.equal(showSidebarView('search', doc), 'search');
  assert.equal(tree.hidden, true);
  assert.equal(search.hidden, false);
  assert.equal(doc._nodes['settings-view'].hidden, true);
  assert.equal(doc.getElementById('tree-view'), tree, '切视图不许换掉节点');

  assert.equal(showSidebarView('settings', doc), 'settings');
  assert.equal(doc._nodes['settings-view'].hidden, false);
  assert.equal(tree.hidden, true);

  assert.equal(showSidebarView('bogus', doc), 'tree');
  assert.equal(tree.hidden, false);
  assert.equal(search.hidden, true);
});
