// 搜索的纯逻辑（落 #33；**现在只搜标题与路径**，边界见 `docs/adr/0003`）。
// 不碰 DOM、不碰网络，所以可单测。
//
// 只有一件事：在手机里已有的那份全库名单上找命中——**零新增取数请求**，而且那份名单
// 每次打开应用都会跟远端对齐，所以「搜得到的就是现在还存在的」。
//
// 正文搜索与它背后的「本机正文副本」在 2026-10-27 一并下架。不是省事：任何存在手机上
// 的正文副本都只能是快照——覆盖不全、内容也可能是旧的，界面能交代「备了多少篇」，
// 交代不了「你看的是什么时候的内容」。理由与翻案条件住在 `docs/adr/0003`。
//
// 排序一律按路径序，**不按「最近修改」**——仓库清单里根本没有修改时间（只有路径与
// 指纹），按一个拿不到的东西排是不划算的（#16 已说明）。

const MD_EXT = /\.md$/i;

export function normalizeQuery(q) {
  return String(q ?? '').trim();
}

/**
 * 标题 / 路径命中。
 * @param {string[]} notePaths 全库笔记路径（来自那份名单索引）
 * @param {string} query
 * @param {number} [limit]
 * @returns {{path:string, name:string, dir:string}[]}
 */
export function searchTitles(notePaths, query, limit = 100) {
  const q = normalizeQuery(query).toLowerCase();
  if (!q) return [];
  const out = [];
  for (const path of notePaths || []) {
    if (!path.toLowerCase().includes(q)) continue;
    out.push({ path, name: baseName(path), dir: dirName(path) });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

function baseName(path) {
  const s = String(path ?? '');
  const i = s.lastIndexOf('/');
  return (i === -1 ? s : s.slice(i + 1)).replace(MD_EXT, '');
}

function dirName(path) {
  const s = String(path ?? '');
  const i = s.lastIndexOf('/');
  return i === -1 ? '' : s.slice(0, i);
}
