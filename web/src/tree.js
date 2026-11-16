// 折叠目录树（#62 实现；#61 建接口占位）。
//
// 后面五张票会照着这里的导出名 import，所以**导出名不要改**：
//   buildTree / sortEntries / refreshTree / getSelectedFolder /
//   setSelectedFolder / selectPath
// 数据源是本机那份全库名单（wikilinkIndex.notePaths），零新增取数请求。
// 建树 / 排序 / 缩进 / 摊平可见行 / 折叠 / 定位 / 三态 / HTML 渲染都抽成可单测的
// 纯函数；DOM 接线层注入假依赖，node 无 document 时安全退化为 no-op。

import { icon } from './icons.js';

// 模块级 controller 与未接线时的兜底值见下方「状态机与跨票接口」段。
const MD_EXT = /\.md$/i;

/** 显示名：笔记去掉 .md（与 search.js baseName 一致），文件夹用目录段名。 */
function displayName(segment, isNote) {
  return isNote ? segment.replace(MD_EXT, '') : segment;
}

/** 文件夹在前 + 名字拼音序（localeCompare，沿用目录页做法，不引拼音表）。 */
export function sortEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice().sort((a, b) => {
    const aDir = a && a.type === 'dir' ? 0 : 1;
    const bDir = b && b.type === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    const an = a && a.name != null ? String(a.name) : '';
    const bn = b && b.name != null ? String(b.name) : '';
    return an.localeCompare(bn);
  });
}

/**
 * 从全库名单（notePaths）推嵌套树。零新增取数请求。
 * 只收 .md 笔记路径——配置 / 附件 / 脚本目录里没有笔记，因此自动消失，不用黑名单；
 * 由笔记路径反推出来的文件夹必然「子树里至少有一篇笔记」，真空文件夹根本不会出现，
 * 不为它改数据层。每层 children 用 sortEntries（文件夹在前 + 拼音序）。
 * 返回顶层节点数组（不含虚拟根行；根行由渲染层单独画，选中根＝落点仓库根）。
 * 节点：{ type:'dir'|'note', name, path, depth, noteCount, children }
 */
export function buildTree(paths) {
  const rootChildren = [];
  if (!Array.isArray(paths)) return rootChildren;
  for (const p of paths) {
    if (typeof p !== 'string' || !p || !MD_EXT.test(p)) continue;
    const segs = p.split('/').filter(Boolean);
    if (!segs.length) continue;
    let level = rootChildren;
    let prefix = '';
    for (let i = 0; i < segs.length; i++) {
      const isNote = i === segs.length - 1;
      const seg = segs[i];
      prefix = prefix ? prefix + '/' + seg : seg;
      let node = level.find((n) => n.path === prefix);
      if (!node) {
        node = {
          type: isNote ? 'note' : 'dir',
          name: displayName(seg, isNote),
          path: prefix,
          depth: i + 1,
          noteCount: 0,
          children: [],
        };
        level.push(node);
      }
      node.noteCount += 1; // 沿途每个节点都「到达」这一篇，故文件夹得到子树笔记总数
      level = node.children;
    }
  }
  function sortTree(nodes) {
    const sorted = sortEntries(nodes);
    for (const n of sorted) if (n.children.length) n.children = sortTree(n.children);
    return sorted;
  }
  return sortTree(rootChildren);
}

// --------------------------------------------------------------------------
// 状态机与跨票接口（#62 真实现）
// 纯规则层在上面；DOM 接线与本机记录都收在 createTreeController（文件末尾）。
// 这里只做「导出名 → 模块级 controller」的转发，导出名不许改（#66 会照着调）。
// --------------------------------------------------------------------------

let _ctl = null;            // initTree 注入依赖后创建
let _fallbackSelected = ''; // 未接线（node 契约测试）时也能 set/get 成对

/** main.js 唯一接线入口：注入依赖 → 建 controller → 先落加载态。 */
export function initTree(deps) {
  _ctl = createTreeController(deps);
  _ctl.onLoading();
  return _ctl;
}

/** 侧栏每次出现（手机拉开、宽屏重画）由 main.js 调：重置滚动保护并重新定位。 */
export function notifySidebarShown() {
  if (_ctl) _ctl.notifySidebarShown();
}

/** 由 #62 提供：写完文件后树就地刷新（#66 会调），不等切后台再回来。 */
export function refreshTree() {
  if (_ctl) return _ctl.refreshTree();
}

/** 选中的文件夹：新建笔记落在这里，没选中就落仓库根。 */
export function getSelectedFolder() {
  return _ctl ? _ctl.getSelectedFolder() : _fallbackSelected;
}

/** 由 #62 提供：设置选中的文件夹（点树里的文件夹时）。 */
export function setSelectedFolder(path) {
  if (_ctl) return _ctl.setSelectedFolder(path);
  _fallbackSelected = path || '';
  return _fallbackSelected;
}

/** 由 #62 提供：按「打开的那篇」在树里定位（祖先展开 / 高亮 / 滚到附近）。 */
export function selectPath(path) {
  if (_ctl) return _ctl.selectPath(path);
  return path || '';
}

// ==========================================================================
// 切片 B：可单测的纯函数 + 本机的折叠 / 选中记录
// 数据源是本机那份全库名单；这里的函数都不碰 fetch、不碰 document。
// ==========================================================================

/** 折叠 / 选中记录的独立键：与 fileIndexCache.v2 的 head 无关，不随仓库版本号失效。 */
export const TREE_STATE_KEY = 'gitobsidianlite.tree.v1';

const INDENTS = [12, 26, 40, 54];

/** 第 1~4 层 12 / 26 / 40 / 54px；第 5 层起固定 54px 并带折角层级记号。 */
export function indentFor(depth) {
  const d = Math.max(1, Number(depth) || 1);
  return { px: INDENTS[Math.min(d, 4) - 1], corner: d >= 5 };
}

/** 笔记路径的各级祖先目录（不含文件本身、不含根行）。 */
export function ancestorsOf(path) {
  const segs = (typeof path === 'string' ? path : '').split('/').filter(Boolean);
  const out = [];
  let acc = '';
  for (let i = 0; i < segs.length - 1; i++) {
    acc = acc ? acc + '/' + segs[i] : segs[i];
    out.push(acc);
  }
  return out;
}

/** dir 是不是 path 从根起的上级目录；根行（''）不参与折叠判定。 */
export function isAncestor(dir, path) {
  if (!dir || typeof dir !== 'string') return false;
  return typeof path === 'string' && path.startsWith(dir + '/');
}

function toSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return new Set();
}

function collectDirs(tree) {
  const dirs = new Set();
  (function walk(nodes) {
    for (const n of (Array.isArray(nodes) ? nodes : [])) {
      if (n && n.type === 'dir') { dirs.add(n.path); walk(n.children); }
    }
  })(tree);
  return dirs;
}

/**
 * 折叠 / 选中记录与当前全库名单对账：找不到的路径（改名 / 删除 / 换仓库）
 * 静默丢弃，不报错、不提示。返回清理后的新状态与 changed 标志（供落盘）。
 */
export function reconcileState(state, tree) {
  const dirs = collectDirs(tree);
  const collapsedIn = toSet(state && state.collapsed);
  const collapsed = new Set();
  for (const p of collapsedIn) {
    if (typeof p === 'string' && p && dirs.has(p)) collapsed.add(p);
  }
  let selectedFolder = state && typeof state.selectedFolder === 'string' ? state.selectedFolder : '';
  let selectionMade = !!(state && state.selectionMade);
  let changed = collapsed.size !== collapsedIn.size;
  if (selectedFolder && !dirs.has(selectedFolder)) {
    selectedFolder = '';
    selectionMade = false;
    changed = true;
  }
  return { collapsed, selectedFolder, selectionMade, changed };
}

function defaultTreeState() {
  return { collapsed: new Set(), selectedFolder: '', selectionMade: false };
}

/** 读本机记录：坏值 / 非法 JSON / 读不了存储都静默回落默认。 */
export function loadTreeState(storage) {
  const fallback = defaultTreeState();
  if (!storage || typeof storage.getItem !== 'function') return fallback;
  let raw;
  try { raw = storage.getItem(TREE_STATE_KEY); } catch (_) { return fallback; }
  if (typeof raw !== 'string' || !raw) return fallback;
  let data;
  try { data = JSON.parse(raw); } catch (_) { return fallback; }
  if (!data || typeof data !== 'object') return fallback;
  const collapsed = new Set(
    (Array.isArray(data.collapsed) ? data.collapsed : [])
      .filter((p) => typeof p === 'string' && p),
  );
  return {
    collapsed,
    selectedFolder: typeof data.selectedFolder === 'string' ? data.selectedFolder : '',
    selectionMade: !!data.selectionMade,
  };
}

/** 写本机记录：单独一份、不含仓库版本号；配额 / 隐私模式抛异常时静默不炸。 */
export function saveTreeState(storage, state) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(TREE_STATE_KEY, JSON.stringify({
      collapsed: [...toSet(state && state.collapsed)],
      selectedFolder: state && typeof state.selectedFolder === 'string' ? state.selectedFolder : '',
      selectionMade: !!(state && state.selectionMade),
    }));
    return true;
  } catch (_) { return false; }
}

/** 是否自动滚到当前篇：就绪、有打开的那篇、这次拉开期间用户没手动滚过。 */
export function shouldAutoScroll(model) {
  return !!(model && model.status === 'ready' && model.currentPath && !model.userScrolled);
}

/** HTML 转义（与 main.js 的 esc 同一套；树行名字 / 路径都过这里）。 */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ==========================================================================
// 切片 C：摊平可见行 + 树行 HTML + 加载三态
// ==========================================================================

/**
 * 把树摊平成可见行（第一行是根行）。目录折在 collapsed 里就不铺子树；
 * 但「打开的那篇」那一支强制展开（压过手动折叠，是定稿代价不是缺陷）。
 * 每行带缩进、折角记号、选中 / 当前两个独立记号、展开态。
 */
export function flattenVisible(tree, opts) {
  const o = opts || {};
  const collapsed = toSet(o.collapsed);
  const currentPath = typeof o.currentPath === 'string' ? o.currentPath : '';
  const selectedFolder = typeof o.selectedFolder === 'string' ? o.selectedFolder : '';
  const selectionMade = !!o.selectionMade;
  const topNodes = Array.isArray(tree) ? tree : [];
  const rows = [];

  const rootNoteCount = topNodes.reduce((sum, n) => sum + (n && n.noteCount ? n.noteCount : 0), 0);
  rows.push({
    type: 'dir', name: '根目录', path: '', depth: 0, noteCount: rootNoteCount,
    indentPx: 12, corner: false,
    selected: selectionMade && selectedFolder === '',
    current: false, expanded: true, isRoot: true,
  });

  function isExpanded(dir) {
    if (!collapsed.has(dir)) return true;
    return isAncestor(dir, currentPath);
  }

  function walk(nodes) {
    for (const n of (Array.isArray(nodes) ? nodes : [])) {
      if (!n) continue;
      const ind = indentFor(n.depth);
      const expanded = n.type === 'dir' && isExpanded(n.path);
      rows.push({
        type: n.type, name: n.name, path: n.path, depth: n.depth,
        noteCount: n.noteCount,
        indentPx: ind.px, corner: ind.corner,
        selected: selectionMade && n.type === 'dir' && n.path === selectedFolder,
        current: n.type === 'note' && n.path === currentPath,
        expanded, isRoot: false,
      });
      if (n.type === 'dir' && expanded) walk(n.children);
    }
  }
  walk(topNodes);
  return rows;
}

/** 一行的 HTML。折叠箭头 / 文件夹 / 笔记图标都走 icons.js 的内联 SVG。 */
export function rowHtml(row) {
  const r = row || {};
  const isDir = r.type === 'dir';
  const cls = [
    'tree-row',
    r.isRoot ? 'is-root' : '',
    isDir ? 'is-dir' : 'is-note',
    r.selected ? 'is-selected' : '',
    r.current ? 'is-current' : '',
  ].filter(Boolean).join(' ');

  let tag, extra;
  if (isDir) {
    tag = 'button';
    extra = 'type="button" data-tree-dir="' + escHtml(r.path) + '"';
  } else {
    tag = 'a';
    extra = 'href="#/edit/' + encodeURIComponent(r.path || '') + '"';
  }
  const attrs = [
    'class="' + cls + '"',
    'style="padding-left:' + (Number(r.indentPx) || 12) + 'px"',
  ];
  if (r.current) attrs.push('data-tree-current="1"');

  // 第 5 层起：行首图标前加 6×6 折角层级记号（不是图标、不响应点击）。
  const corner = r.corner ? '<span class="tree-corner" aria-hidden="true"></span>' : '';
  const chevronBody = isDir ? icon(r.expanded ? 'chevron-down' : 'chevron-right', 12) : '';
  const chevron = '<span class="tree-chevron" aria-hidden="true">' + chevronBody + '</span>';
  const glyph = '<span class="tree-ic" aria-hidden="true">' + icon(isDir ? 'folder' : 'note', 18) + '</span>';
  const name = '<span class="tree-name">' + escHtml(r.name) + '</span>';
  const count = isDir && r.noteCount
    ? '<span class="tree-count">' + escHtml(r.noteCount) + '</span>'
    : '';

  return '<' + tag + ' ' + extra + ' ' + attrs.join(' ') + '>'
    + corner + chevron + glyph + name + count
    + '</' + tag + '>';
}

function loadingBlock(active) {
  return '<div class="tree-status tree-loading" data-tree-status="loading"' + (active ? '' : ' hidden') + '>'
    + '<p class="tree-status-title">正在读取笔记名单…</p>'
    + '<p class="tree-status-sub">首次打开整库约需几秒</p>'
    + '<div class="tree-skeleton" aria-hidden="true"></div>'
    + '<div class="tree-skeleton" aria-hidden="true"></div>'
    + '</div>';
}

function offlineBlock(active) {
  return '<div class="tree-status tree-offline" data-tree-status="offline"' + (active ? '' : ' hidden') + '>'
    + '<p class="tree-status-title">连不上服务端</p>'
    + '<p class="tree-status-sub">暂时读不到笔记名单，恢复联网后再试。</p>'
    + '<button type="button" class="tree-retry" data-tree-retry>重试</button>'
    + '</div>';
}

/**
 * 完整树容器。加载 / 失败 / 树行三个容器自始至终常驻同一块 .tree，按 status
 * 只切 hidden——冷启动、版本号变了全量重拉都不增删节点，不会有布局跳动。
 * 加载用静态文字 + 两条固定高度浅色占位，不闪烁、不画空树；断网明说连不上
 * 并给重试，不说「没有笔记」、不拿过期名单硬画。
 */
export function renderTreeHtml(model) {
  const m = model || {};
  const status = m.status === 'ready' || m.status === 'offline' ? m.status : 'loading';
  const rows = Array.isArray(m.rows) ? m.rows : flattenVisible(m.tree || [], m);
  const body = status === 'ready' ? rows.map(rowHtml).join('') : '';
  return '<div class="tree">'
    + loadingBlock(status === 'loading')
    + offlineBlock(status === 'offline')
    + '<div class="tree-rows"' + (status === 'ready' ? '' : ' hidden') + '>' + body + '</div>'
    + '</div>';
}

// ==========================================================================
// 切片 D：状态机 / DOM 接线（注入假依赖，node 无 document 时安全退化为 no-op）
// ==========================================================================

export function createTreeController(deps) {
  const o = deps || {};
  const doc = o.doc || (typeof document !== 'undefined' ? document : null);
  const storage = o.storage !== undefined ? o.storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const getNotePaths = typeof o.getNotePaths === 'function' ? o.getNotePaths : () => null;
  const reloadIndex = typeof o.reloadIndex === 'function' ? o.reloadIndex : null;
  const getCurrentNote = typeof o.getCurrentNote === 'function' ? o.getCurrentNote : () => '';

  const model = {
    notePaths: [], tree: [], status: 'loading',
    collapsed: new Set(), selectedFolder: '', selectionMade: false,
    currentPath: '', userScrolled: false,
  };
  const saved = loadTreeState(storage);
  model.collapsed = saved.collapsed;
  model.selectedFolder = saved.selectedFolder;
  model.selectionMade = saved.selectionMade;

  function persist() { saveTreeState(storage, model); }

  function hostNode() {
    return doc && typeof doc.getElementById === 'function' ? doc.getElementById('tree-view') : null;
  }
  function scrollerNode() {
    return doc && typeof doc.getElementById === 'function' ? doc.getElementById('sidebar-content') : null;
  }
  function paint() {
    const host = hostNode();
    if (!host) return;   // node 无 DOM：no-op
    const scroller = scrollerNode();
    const top = scroller && typeof scroller.scrollTop === 'number' ? scroller.scrollTop : 0;
    host.innerHTML = renderTreeHtml(model);
    if (scroller && typeof scroller.scrollTop === 'number') scroller.scrollTop = top;
  }
  function scrollToCurrent() {
    if (!doc || typeof doc.querySelector !== 'function') return;
    const row = doc.querySelector('[data-tree-current="1"]');
    if (row && typeof row.scrollIntoView === 'function') {
      try { row.scrollIntoView({ block: 'center' }); } catch (_) { /* 老环境忽略 */ }
    }
  }
  function autoScrollIfNeeded() {
    if (shouldAutoScroll(model)) scrollToCurrent();
  }
  function syncPaths() {
    // 数据源只有本机那份全库名单（wikilinkIndex.notePaths），零新增取数请求。
    const paths = getNotePaths();
    model.notePaths = Array.isArray(paths) ? paths : [];
    model.tree = buildTree(model.notePaths);
    const r = reconcileState(model, model.tree);
    model.collapsed = r.collapsed;
    model.selectedFolder = r.selectedFolder;
    model.selectionMade = r.selectionMade;
    if (r.changed) persist();
  }
  function onLoading() {
    // 冷启动 / 版本号变了全量重拉：三个常驻容器只切 hidden，不增删节点、不闪。
    model.status = 'loading';
    paint();
  }
  function onReady() {
    syncPaths();
    model.status = 'ready';
    paint();
    autoScrollIfNeeded();
  }
  function onOffline() {
    model.status = 'offline';
    model.tree = [];          // 不画空树、不拿过期名单硬画
    model.notePaths = [];
    paint();
  }
  function refreshTree() {
    // #66 写成功后只调这里：重建全库名单并让侧栏树立刻反映新世界。
    onLoading();
    if (!reloadIndex) { onReady(); return; }
    Promise.resolve(reloadIndex()).then(() => onReady(), () => onOffline());
  }
  function getSelectedFolder() { return model.selectedFolder; }
  function setSelectedFolder(path) {
    model.selectedFolder = path || '';
    model.selectionMade = true;
    persist();
    paint();
    return model.selectedFolder;
  }
  function selectPath(path) {
    const p = typeof path === 'string' ? path : '';
    model.currentPath = p;
    if (p) {
      // 打开一篇：选中退回它所在的文件夹（F-3）
      const segs = p.split('/');
      model.selectedFolder = segs.length > 1 ? segs.slice(0, -1).join('/') : '';
      model.selectionMade = true;
    }
    for (const a of ancestorsOf(p)) model.collapsed.delete(a); // 当前篇压过手动折叠
    persist();
    if (model.status === 'ready') { paint(); autoScrollIfNeeded(); }
    return p;
  }
  function onFolderClick(path) {
    const p = typeof path === 'string' ? path : '';
    if (p === '') {
      model.selectedFolder = '';        // 根目录行同样可选中
      model.selectionMade = true;
    } else {
      // 点一下 = 展开 / 折上切换，同时选为「选中的文件夹」——不拆成两个概念
      // （§4.1：不能让人点第二下才选中）。再点折上时选中与落点仍在这个目录。
      if (model.collapsed.has(p)) model.collapsed.delete(p);
      else model.collapsed.add(p);
      model.selectedFolder = p;
      model.selectionMade = true;
    }
    persist();
    paint();
  }
  function notifySidebarShown() {
    // 侧栏每次出现：一次新的拉开，重置手动滚动保护，按打开的那篇摆好。
    model.userScrolled = false;
    if (!model.currentPath) {
      const p = getCurrentNote();
      if (p) model.currentPath = p;
    }
    for (const a of ancestorsOf(model.currentPath)) model.collapsed.delete(a);
    if (model.status === 'ready') paint();
    autoScrollIfNeeded();
  }
  function markUserScrolled() { model.userScrolled = true; }

  // DOM 事件接线：node 无 doc 时整段跳过；点击坐标 / 长按 / 可见视口留真浏览器验。
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('click', (e) => {
      const t = e && e.target;
      const closest = t && typeof t.closest === 'function' ? (sel) => t.closest(sel) : () => null;
      if (closest('[data-tree-retry]')) { refreshTree(); return; }
      const dirRow = closest('[data-tree-dir]');
      if (dirRow && dirRow.dataset) onFolderClick(dirRow.dataset.treeDir);
    });
    // 只认明确的用户滚动手势，避免程序 scrollIntoView 把自己误判成「用户滚过」。
    for (const type of ['wheel', 'touchmove']) {
      doc.addEventListener(type, markUserScrolled, { passive: true });
    }
  }

  return {
    model, onLoading, onReady, onOffline, refreshTree,
    getSelectedFolder, setSelectedFolder, selectPath,
    onFolderClick, notifySidebarShown, markUserScrolled,
    paint, syncPaths, autoScrollIfNeeded,
  };
}
