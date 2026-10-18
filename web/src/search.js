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

/**
 * 覆盖范围：**远端清单里这些篇，本机手上有几篇**（#38 的「只备了 X / 共 Y 篇」）。
 *
 * 注意这里不是「本地存了几条」。本地可能还留着远端已经删掉的那一条（下次同步才清），
 * 拿条数去比会**假对齐**——两边条数正好相等、而缺的那一篇被一条废记录顶掉，
 * 于是就敢说「正文里没有命中」。按路径求交集没有这个洞。
 *
 * @param {string[]} remotePaths 远端清单里的笔记路径
 * @param {Iterable<string>} localPaths 本地正文副本里的路径（数组或 Set）
 */
export function coveredCount(remotePaths, localPaths) {
  const have = localPaths instanceof Set ? localPaths : new Set(localPaths || []);
  let n = 0;
  for (const p of remotePaths || []) if (have.has(p)) n += 1;
  return n;
}

/**
 * 正文那一组**该怎么说话**（#38 改的口径：副本没备齐也允许参与搜索）。
 *
 * 这是本项目最容易被写坏的一句话：**「还没备到」不许说成「没有命中」**。
 * 所以判断与措辞都放在这里，渲染层照着 `kind` 摆位置，不自己拼句子——
 * 拼错一次，用户就会以为那篇笔记不存在。
 *
 * @param {{enabled:boolean, covered?:number, total?:number, loaded?:boolean, hitCount?:number}} s
 *   enabled  开关开着没有；covered 本地副本里有几篇；total 远端清单里有几篇；
 *   loaded   本地那份读过来了没有；hitCount 正文里命中几条
 * @returns {{kind:'hidden'|'no-copy'|'loading'|'unknown-scope'|'hits'|'partial-hits'|'empty'|'partial-empty',
 *            covered:number, total:number, complete:boolean, note:string}}
 *   - `hidden`        开关没开：整组不出现（一栏永远写着「去设置里打开」只是白占屏幕）
 *   - `no-copy`       一篇都还没到手：说清为什么（此时搜正文必然一个都搜不到）
 *   - `loading`       手上有正文，正在从本地读
 *   - `unknown-scope` 手上有正文，但**远端清单还没到手**，说不清覆盖了多少：只报手上的篇数，
 *                     **不许编出「共 0 篇」这种数**（打开应用的头几秒就是这个状态）
 *   - `hits`          命中，且副本与远端对齐
 *   - `partial-hits`  命中，但只覆盖了一部分：`note` 要放在结果**之前**
 *   - `empty`         对齐了、真没有
 *   - `partial-empty` 手上这部分没有，但还有没备到的：`note` 不是「没有命中」，是范围说明
 */
export function bodyGroupView({ enabled, covered = 0, total = 0, loaded = false, hitCount = 0 }) {
  const known = total > 0;   // 远端清单到了没有。没到就别谈「齐了没有」
  const base = { covered, total, complete: known && covered >= total, note: '' };
  if (!enabled) return { ...base, kind: 'hidden', complete: false };
  if (covered <= 0) return { ...base, kind: 'no-copy' };
  if (!loaded) return { ...base, kind: 'loading' };
  if (!known) {
    return { ...base, kind: 'unknown-scope', note: '仓库清单还没到手，眼下只有本机备着的 ' + covered + ' 篇参与搜索。' };
  }
  const missing = total - covered;
  if (hitCount > 0) {
    return base.complete
      ? { ...base, kind: 'hits' }
      : { ...base, kind: 'partial-hits', note: '本地正文只备了 ' + covered + ' / 共 ' + total +
          ' 篇，下面只是这 ' + covered + ' 篇里的命中。' };
  }
  return base.complete
    ? { ...base, kind: 'empty' }
    : { ...base, kind: 'partial-empty', note: '已备的 ' + covered + ' 篇里没有；还有 ' + missing + ' 篇没备到。' };
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
