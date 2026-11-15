// 折叠目录树（占位，#61 建接口 / #62 填充实现）。
//
// 后面五张票会照着这里的导出名 import，所以**导出名不要改**。目前全部返回
// 可运行的默认值，真正的「从全库名单推嵌套树、三态加载、折叠记忆、定位、
// 只画可达路径、树就地刷新」由 #62 在文件内部替换实现，接口保持不变。

let selectedFolder = '';

/** 由 #62 提供：paths（全库名单）→ 嵌套树节点数组。占位返回空数组。 */
export function buildTree(_paths) {
  return [];
}

/** 由 #62 提供：文件夹在前 + 拼音序。占位返回浅拷贝，保证是数组、不改入参。 */
export function sortEntries(entries) {
  return Array.isArray(entries) ? entries.slice() : [];
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
