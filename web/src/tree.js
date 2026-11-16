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
