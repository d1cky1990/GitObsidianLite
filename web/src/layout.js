// 一屏两栏骨架：一次性 HTML + 事件接线（#61）。
//
// 骨架只建一次：所有输入框节点（侧栏的搜索框）自始至终在 DOM 里，「有/没有」
// 的元素切 hidden，不靠增删节点——中文输入法组字时换掉 input 节点会当场断掉。
// 骨架放在 #app **之外**（main.js 仍往 #app 写现有各态内容），所以重画正文
// 永远碰不到这些常驻节点。事件接线只操作骨架层，不改 main.js 的 render。
//
// 侧栏三块内容（树 / 搜索结果 / 设置）的容器与切换都归 #61；#62/#63 只往
// 对应容器里填内容，不重做骨架、不改这里的布局函数（handoff 波次 2 约定）。
//
// 真浏览器里的侧栏开合 / 占位历史 / 返回四层，判据见票 #61 验收；本模块把
// 逻辑决策抽到 navigation.js（有单测），DOM 接线留在这里（真浏览器验）。

import { icon } from './icons.js';
import { applyTheme } from './theme.js';
import {
  SIDEBAR_BREAKPOINT, createNavState, pushSidebarPlaceholder, popSidebarPlaceholder,
  parseHash, decideBack,
} from './navigation.js';

export { SIDEBAR_BREAKPOINT };

// 宽屏「收起侧栏」本机记住，与窄屏滑出的开合是两件事（G-6）。
const COLLAPSED_KEY = 'gitobsidianlite.sidebar.collapsed';

/** 侧栏三块内容的名字。#62/#63 只往对应容器里填内容，切换由 showSidebarView 管。 */
export const SIDEBAR_VIEWS = ['tree', 'search', 'settings'];
const VIEW_IDS = { tree: 'tree-view', search: 'search-results', settings: 'settings-view' };

/** 一次性骨架。所有图标内联自绘，无外链、无字符/emoji 图标。 */
export function shellHtml() {
  return [
    '<aside id="sidebar" class="sidebar" hidden>',
    '  <div class="sidebar-head">',
    '    <h1 class="sidebar-title" id="sidebar-title">笔记库</h1>',
    '    <button id="search-toggle" class="icon-btn" data-shell="search" aria-label="搜索">' + icon('search') + '</button>',
    // 骨架的搜索框用独立 id（sidebar-q），与 main.js 旧列表页 listShellHtml() 里的
    // #q 不重名：那个在 #app 内会随重画被换掉，本票的常驻节点在 #app 之外，
    // renderEditor() 的整块 app.innerHTML 永远碰不到它——输入法组字不会断。
    '    <div id="search-row" class="search-row" hidden>',
    '      <input id="sidebar-q" class="search-input" type="text" placeholder="只搜标题与路径" autocapitalize="off" autocomplete="off" spellcheck="false">',
    '      <button id="sidebar-q-clear" class="icon-btn" data-shell="clear" aria-label="清空搜索">' + icon('close') + '</button>',
    '    </div>',
    '  </div>',
    // 三块内容共用一块滚动区，各自是一个常驻容器；切换只切 hidden，不增删节点。
    '  <div id="sidebar-content" class="sidebar-content">',
    '    <div id="tree-view" class="sidebar-view"><!-- 树：由 #62 填 --></div>',
    '    <div id="search-results" class="sidebar-view" hidden><!-- 搜索结果：由 #63 填 --></div>',
    '    <div id="settings-view" class="sidebar-view" hidden><!-- 设置：由 #63 填 --></div>',
    '  </div>',
    '  <div id="sidebar-foot" class="sidebar-foot">',
    '    <button id="btn-new" class="icon-btn" data-shell="new" aria-label="新建">' + icon('new-note') + '</button>',
    '    <button id="btn-settings" class="icon-btn" data-shell="settings" aria-label="设置">' + icon('settings') + '</button>',
    '  </div>',
    '</aside>',
    // 窄屏遮罩只覆盖露出的那 1/4（宽度由 style.css 定），点它关侧栏。
    '<div id="scrim" class="scrim" data-shell="close" hidden></div>',
    '<div id="main" class="main">',
    '  <header class="topbar">',
    '    <button id="btn-open" class="icon-btn" data-shell="open" aria-label="打开侧栏">' + icon('sidebar-open') + '</button>',
    // 关闭键在侧栏外面、正文区靠左：窄屏贴侧栏边缘外侧，宽屏在「☰」旁边。
    '    <button id="btn-close" class="icon-btn" data-shell="close" aria-label="关闭侧栏" hidden>' + icon('close') + '</button>',
    '    <span class="topbar-title" id="doc-title"></span>',
    '    <button id="btn-more" class="icon-btn" data-shell="more" aria-label="更多操作">' + icon('more') + '</button>',
    '  </header>',
    '  <div id="app"></div>',
    '  <footer id="edit-actions" class="edit-actions" hidden></footer>',
    '</div>',
    // 全局提示条不属于任何一栏，永远相对整个界面居中。
    '<div id="toast-host" class="toast-host"></div>',
  ].join('\n');
}

/** 幂等注入：只有 #shell 里还没有 #app 时才建骨架，返回 #app。 */
export function mountShell(host) {
  const el = host || (typeof document !== 'undefined' ? document.getElementById('shell') : null);
  if (!el) return null;
  const hasApp = typeof el.querySelector === 'function' && el.querySelector('#app');
  if (!hasApp) el.innerHTML = shellHtml();
  return typeof el.querySelector === 'function' ? el.querySelector('#app') : null;
}

/**
 * 三块内容切换：只切 hidden，不增删节点（搜索框与各容器已填内容都不重建）。
 * 未知名回落到 tree。doc 可注入，便于单测。
 */
export function showSidebarView(name, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const target = SIDEBAR_VIEWS.includes(name) ? name : 'tree';
  if (!d || typeof d.getElementById !== 'function') return target;
  for (const key of SIDEBAR_VIEWS) {
    const node = d.getElementById(VIEW_IDS[key]);
    if (node) node.hidden = key !== target;
  }
  return target;
}

/**
 * main.js 唯一的接线入口：注入骨架 → 应用主题（system 时挂系统外观监听）→
 * 侧栏开合 / 三块内容切换 / 占位历史 / 返回四层。只操作骨架层，
 * 不碰 #app 内容与勾选队列。
 */
export function initLayout() {
  const app = mountShell();
  applyTheme(); // 主程序启动后读同一份记录；与 index.html 内联脚本互为镜像
  if (!app || typeof document === 'undefined') return null;

  const state = createNavState();
  const isWide = () => typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(min-width: ' + SIDEBAR_BREAKPOINT + 'px)').matches;
  const el = (id) => document.getElementById(id);

  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch (_) { /* 忽略 */ }
  state.sidebarOpen = isWide() && !collapsed;

  function persistCollapsed(v) {
    try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch (_) { /* 忽略 */ }
  }

  function updateVisibility() {
    const wide = isWide();
    const sidebar = el('sidebar'), scrim = el('scrim'), btnClose = el('btn-close'), shell = el('shell');
    if (sidebar) sidebar.hidden = wide ? collapsed : !state.sidebarOpen;
    if (scrim) scrim.hidden = wide || !state.sidebarOpen; // 宽屏没有遮罩
    if (btnClose) btnClose.hidden = wide ? collapsed : !state.sidebarOpen;
    if (shell) shell.classList.toggle('sidebar-collapsed', wide && collapsed);
  }

  function openSidebar() {
    if (state.sidebarOpen) return;
    if (isWide()) {
      collapsed = false; persistCollapsed(false);
    } else {
      // 侧栏滑出时压一条占位历史，地址栏不变（history.state 里只放一个标记）
      const entry = pushSidebarPlaceholder(state);
      try { history.pushState(entry.historyState, '', location.href); } catch (_) { /* 忽略 */ }
    }
    state.sidebarOpen = true;
    updateVisibility();
  }

  function closeSidebar({ fromSystemBack = false } = {}) {
    if (!state.sidebarOpen) return;
    if (isWide()) {
      collapsed = true; persistCollapsed(true);
    } else if (fromSystemBack) {
      // 系统返回已经把占位吃掉，这里只配平深度，不再 history.back()
      popSidebarPlaceholder(state);
    } else if (popSidebarPlaceholder(state)) {
      // 点关闭键 / 点遮罩：把那条占位吃掉，否则按返回会出现「按了没反应」
      try { history.back(); } catch (_) { /* 忽略 */ }
    }
    state.sidebarOpen = false;
    updateVisibility();
  }

  updateVisibility();

  // 开合只靠按钮，不做边缘滑动。关闭键与遮罩都是 data-shell="close"。
  document.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target.closest('[data-shell]') : null;
    if (!target) return;
    const act = target.dataset.shell;
    if (act === 'open') { openSidebar(); return; }
    if (act === 'close') { closeSidebar(); return; }
    // 容器切换归 #61：放大镜 → 搜索结果、设置 → 设置面板（只切 hidden）
    if (act === 'search') showSidebarView('search');
    if (act === 'settings') showSidebarView('settings');
    // 内容填充与放大镜/清空叉的点滑规则由 #63、新建由 #66、更多由 #65 接这个意图
    try {
      document.dispatchEvent(new CustomEvent('ui:shell-action', { detail: { action: act } }));
    } catch (_) { /* 老环境没有 CustomEvent 就跳过 */ }
  });

  // 侧栏开着按系统返回：先收侧栏、不动笔记。侧栏没开时把四层决策派发出去，
  // 由 #64/#65 接 ui:back 去真正「关掉这篇 / 退出编辑 / 退回编辑」。
  window.addEventListener('popstate', () => {
    if (state.sidebarOpen) { closeSidebar({ fromSystemBack: true }); return; }
    const decision = decideBack(state);
    try {
      document.dispatchEvent(new CustomEvent('ui:back', { detail: { decision } }));
    } catch (_) { /* 忽略 */ }
  });

  // 点开一篇笔记，手机上侧栏自动收（关法之三）；地址栏只跟那篇变。
  window.addEventListener('hashchange', () => {
    const parsed = parseHash(location.hash);
    if (parsed.kind === 'note') {
      state.openedPath = parsed.path;
      if (state.sidebarOpen) {
        popSidebarPlaceholder(state);
        state.sidebarOpen = false;
        updateVisibility();
      }
    }
  });

  return { openSidebar, closeSidebar, showSidebarView, state };
}
