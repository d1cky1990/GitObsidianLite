// 搜索的纯逻辑（落 #33，规则定在 #16 的结论里）。不碰 DOM、不碰网络，所以可单测。
//
// 两件事分开看，因为它们的代价差着量级：
//   - **标题 / 路径命中**：靠手机里已有的那份全库名单，**零新增请求**；
//   - **正文命中**：靠本地那份正文副本逐篇扫。副本默认没有（开关默认关），
//     所以这一组出不出现，由调用方按副本的状态决定。
//
// 排序一律按路径序，**不按「最近修改」**——仓库清单里根本没有修改时间（只有路径与
// 指纹），按一个拿不到的东西排是不划算的（#16 已说明）。

const MD_EXT = /\.md$/i;

/** 命中片段前后各留多少字。够认出是哪一句，又不至于把整段搬进列表。 */
const SNIPPET_RADIUS = 26;

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

/**
 * 一段文字里第一处命中的上下文。返回三段而不是一整句，是为了让渲染那层自己决定
 * 怎么高亮——这里不该输出 HTML。
 * @returns {{before:string, match:string, after:string}|null}
 */
export function findSnippet(text, query, radius = SNIPPET_RADIUS) {
  const q = normalizeQuery(query);
  if (!q) return null;
  const src = String(text ?? '');
  const at = src.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return null;
  const from = Math.max(0, at - radius);
  const to = Math.min(src.length, at + q.length + radius);
  return {
    // 省略号只在真截断处出现——没截就加，会让人以为上面还有内容
    before: (from > 0 ? '…' : '') + src.slice(from, at),
    match: src.slice(at, at + q.length),
    after: src.slice(at + q.length, to) + (to < src.length ? '…' : ''),
  };
}

/**
 * 正文命中。`notes` 是本地副本里的 [{path, content}]。
 * 一篇只报一处（第一处）——列表是给人认路的，不是给全文检索做摘要的。
 * @param {{path:string, content:string}[]} notes
 * @param {string} query
 * @param {{limit?:number, radius?:number}} [opts]
 * @returns {{path:string, name:string, dir:string, snippet:object}[]}
 */
export function searchBodies(notes, query, { limit = 100, radius = SNIPPET_RADIUS } = {}) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const out = [];
  for (const n of notes || []) {
    const snippet = findSnippet(n.content, q, radius);
    if (!snippet) continue;
    out.push({ path: n.path, name: baseName(n.path), dir: dirName(n.path), snippet });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

/** 只搜笔记（`.md`，含归档日记）。附件与配置目录由调用方在给名单时就已经滤掉了。 */
export function isNote(path) {
  return MD_EXT.test(String(path ?? ''));
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
