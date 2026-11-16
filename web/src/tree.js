// 折叠目录树（#62 实现；#61 建接口占位）。
//
// 后面五张票会照着这里的导出名 import，所以**导出名不要改**：
//   buildTree / sortEntries / refreshTree / getSelectedFolder /
//   setSelectedFolder / selectPath
// 数据源是本机那份全库名单（wikilinkIndex.notePaths），零新增取数请求。
// 建树 / 排序 / 缩进 / 摊平可见行 / 折叠 / 定位 / 三态 / HTML 渲染都抽成可单测的
// 纯函数；DOM 接线层注入假依赖，node 无 document 时安全退化为 no-op。

import { icon } from './icons.js';

let selectedFolder = '';

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

/** 由 #62 提供：写完文件后树就地刷新（#66 会调）。占位 no-op。 */
export function refreshTree() {}

/** 选中的文件夹：新建笔记落在这里，没选中就落仓库根。 */
export function getSelectedFolder() {
  return selectedFolder;
}

/** 由 #62 提供：设置选中的文件夹（点树里的文件夹时）。占位只记一条本机值。 */
export function setSelectedFolder(path) {
  selectedFolder = path || '';
  return selectedFolder;
}

/** 由 #62 提供：按「打开的那篇」在树里定位（祖先展开 / 高亮 / 滚到附近）。占位 no-op。 */
export function selectPath(path) {
  return path;
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
