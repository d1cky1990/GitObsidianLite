// Obsidian 双链 [[...]] 的判定与渲染。
//
// 判定「这个目标解不解得开」需要的信息只有一份：整棵树的路径清单（一次
// /api/tree/recursive，见 main.js 的 ensureIndex）。所以它是**纯前端、渲染期**可定的，
// 不必等到点击才发请求——这是本模块存在的理由（#7）。
//
// 目标怎么算解得开——照 Obsidian 的读法，不是照我们自己的方便：
//   1. 先按 basename 全库匹配。Obsidian 默认的链接格式「能短则短」写出来就是
//      `[[笔记]]`，只在重名时才补路径，所以这种最常见。
//   2. 再按**仓库根相对**解析。设置里「绝对路径」格式写出来是 `[[目录/笔记]]`。
//   3. 最后按**笔记所在目录相对**解析。设置里「相对路径」格式写出来是
//      `[[../目录/笔记]]`。同一份库里几种格式可以并存——改过一次设置，或手写过链接。
//
// 为什么不直接复用 vault-refs.js 的 resolveVaultRef：那套服务的是 Markdown 里的图片
// 引用，语义与双链有两处**实质不同**，混用会算错——
//   - 基准：图片写法只有「笔记目录相对」一种；双链的第一优先级是 basename 全库匹配，
//     且带路径的写法默认从仓库根算起。拿 notePath 去解 `[[目录/笔记]]`，会解成
//     「当前笔记目录下的 目录/笔记」，把本来能开的链接判成不存在。
//   - 编码：Markdown 链接要 URL 编码（vault-refs 的 decodeOnce 就是为它准备的），
//     而 Obsidian 的双链是**字面**字符串——解一次会把名字里真带 % 的文件解错。
// 真正共用的那一小块（`.`/`..` 归一化、越根判定）已经抽成 normalizeVaultSegments
// 留在 vault-refs.js，这里 import 它，不另写一份。

import { normalizeVaultSegments, escapeHtml as esc } from './vault-refs.js';

const MD_EXT = /\.md$/i;

/**
 * @typedef {{
 *   notePaths: string[], filePaths: string[],
 *   notes: Map<string,string>, files: Map<string,string>,
 *   notesByPath: Map<string,string>, filesByPath: Map<string,string>,
 * }} WikilinkIndex
 */

/**
 * 一次查询的结果：命中的是笔记还是仓库文件、还是没命中。
 * @typedef {{kind:'note'|'file', path:string}
 *         | {kind:'missing'}    目标非空，但树里找不到
 *         | {kind:'empty'}      压根没有目标（[[#标题]] 这类）
 *         | {kind:'unknown'}} WikilinkHit   索引没拿到，不知道
 */

/** 从 /api/tree/recursive 的 tree 数组建索引 */
export function buildWikilinkIndex(tree) {
  const notePaths = [], filePaths = [];
  for (const node of (tree || [])) {
    if (!node || node.type !== 'blob' || typeof node.path !== 'string' || !node.path) continue;
    (MD_EXT.test(node.path) ? notePaths : filePaths).push(node.path);
  }
  return indexFromPaths(notePaths, filePaths);
}

/** 从缓存的路径清单重建索引（缓存里只存路径，映射读回时现算） */
export function hydrateWikilinkIndex(data) {
  return indexFromPaths(pathList(data && data.notes), pathList(data && data.files));
}

/** 索引 → 可塞进 localStorage 的形状 */
export function serializeWikilinkIndex(index) {
  return { notes: index.notePaths, files: index.filePaths };
}

/**
 * 拆一条 `[[...]]` 的原文。
 * `[[目标]]` / `[[目标|别名]]` / `[[目标#标题]]` / `[[#标题]]`。
 * @returns {{target:string, label:string}}
 */
export function parseWikilink(inner) {
  const raw = String(inner ?? '');
  const bar = raw.indexOf('|');
  const rawTarget = bar === -1 ? raw : raw.slice(0, bar);
  // `|` 之后的第一个字段是别名；多个 `|` 是 Obsidian 明确劝退的写法（`|` 属无效字符），
  // 这里保持改动前的取法，只当第一个之后的字段不存在
  const rawLabel = bar === -1 ? raw : (raw.slice(bar + 1).split('|')[0] || raw.slice(0, bar));
  return {
    target: beforeAnchor(rawTarget).trim(),
    // 剥掉锚点后标签为空时，用锚点文字兜底：`[[#标题]]` 的标题不能连文字一起吞掉
    label: (beforeAnchor(rawLabel) || afterAnchor(rawTarget)).trim(),
  };
}

/**
 * 一个目标到底是笔记、仓库文件，还是解不开。
 * @param {WikilinkIndex|null} index
 * @param {string} target
 * @param {string} notePath 当前笔记的路径——只有第三种解析（笔记目录相对）用得上
 * @returns {WikilinkHit}
 */
export function lookupWikilink(index, target, notePath) {
  const t = String(target ?? '').trim();
  if (!t) return { kind: 'empty' };
  if (!index) return { kind: 'unknown' };

  // 名字匹配。`[[笔记.md]]` 与 `[[笔记]]` 等价（Obsidian 文档明确说两种写法等价）
  const stem = t.replace(MD_EXT, '');
  const keys = stem === t ? [t] : [t, stem];
  for (const key of keys) {
    if (index.notes.has(key)) return { kind: 'note', path: index.notes.get(key) };
    if (index.files.has(key)) return { kind: 'file', path: index.files.get(key) };
  }
  // 路径匹配。先仓库根相对，再笔记目录相对
  for (const key of keys) {
    const hit = byPath(index, key, notePath);
    if (hit) return hit;
  }
  return { kind: 'missing' };
}

/**
 * 渲染一条 `[[...]]`。四种结果，样式各不相同——解不解得开，渲染期就该看得出来。
 * @param {WikilinkIndex|null} index
 * @param {string} inner `[[` 与 `]]` 之间的原文
 * @param {string} notePath
 * @param {{rawUrl:(path:string)=>string}} deps
 * @returns {string} HTML
 */
export function renderWikilink(index, inner, notePath, deps) {
  const { target, label } = parseWikilink(inner);
  const hit = lookupWikilink(index, target, notePath);
  const text = esc(label || target || inner);

  if (hit.kind === 'note') {
    return '<a class="wikilink" data-wikilink="' + esc(target) + '">' + text + '</a>';
  }
  if (hit.kind === 'file') {
    // 文件真实存在，只是不是笔记：以原始文件打开，与 §8 的图片同一条路（/api/raw）
    return '<a class="wikilink wikilink-file" href="' + esc(deps.rawUrl(hit.path)) +
      '" target="_blank" rel="noopener">' + text + '</a>';
  }
  if (hit.kind === 'missing') {
    // 不是链接，但点一下要说清它想指向谁
    return '<span class="wikilink wikilink-broken" data-wikilink-broken="' + esc(target) + '">' + text + '</span>';
  }
  if (hit.kind === 'unknown') {
    // 索引没拿到 ≠ 目标不存在。中性、可点重试：既不装成好链接，也不判死刑
    return '<a class="wikilink wikilink-unknown" data-wikilink="' + esc(target) + '">' + text + '</a>';
  }
  return text; // 空目标：只留文字
}

/**
 * 装上双链规则：拆 token + 按索引渲染。
 * @param {import('markdown-it')} md
 * @param {{getIndex:()=>WikilinkIndex|null, rawUrl:(path:string)=>string}} deps
 */
export function installWikilinkRule(md, deps) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const pos = state.pos;
    if (state.src.charCodeAt(pos) !== 0x5b || state.src.charCodeAt(pos + 1) !== 0x5b) return false;
    const end = state.src.indexOf(']]', pos + 2);
    if (end === -1) return false;
    const inner = state.src.slice(pos + 2, end);
    if (!inner || inner.includes('[') || inner.includes(']') || inner.includes('\n')) return false;
    if (!silent) { const token = state.push('wikilink', '', 0); token.content = inner; }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, idx, options, env) =>
    renderWikilink(deps.getIndex(), tokens[idx].content, env && env.notePath, deps);
}

/* ---------- 内部 ---------- */

function indexFromPaths(notePaths, filePaths) {
  const notes = new Map(), files = new Map(), notesByPath = new Map(), filesByPath = new Map();
  for (const p of notePaths) {
    // 重名时先到先得——与改动前的 buildIndex 同一套（树序第一个），可达链接的落点不变
    const stem = p.slice(p.lastIndexOf('/') + 1).replace(MD_EXT, '');
    if (!notes.has(stem)) notes.set(stem, p);
    notesByPath.set(p.replace(MD_EXT, ''), p); // 笔记允许省略 .md 来找
  }
  for (const p of filePaths) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!files.has(base)) files.set(base, p);
    filesByPath.set(p, p);
  }
  return {
    notePaths: [...notePaths], filePaths: [...filePaths],
    notes, files, notesByPath, filesByPath,
  };
}

function byPath(index, target, notePath) {
  const segs = target.replace(/\\/g, '/').split('/');
  const dir = String(notePath || '').split('/').slice(0, -1);
  for (const parts of [segs, [...dir, ...segs]]) {
    const path = normalizeVaultSegments(parts); // 越根与空路径都返回假值，跳过
    if (!path) continue;
    if (index.notesByPath.has(path)) return { kind: 'note', path: index.notesByPath.get(path) };
    if (index.filesByPath.has(path)) return { kind: 'file', path: index.filesByPath.get(path) };
  }
  return null;
}

function beforeAnchor(s) { const i = s.indexOf('#'); return i === -1 ? s : s.slice(0, i); }
function afterAnchor(s) { const i = s.indexOf('#'); return i === -1 ? '' : s.slice(i + 1); }

function pathList(v) {
  return Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p) : [];
}
