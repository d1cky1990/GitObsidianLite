// vault 内引用解析：把笔记里写的一条引用（图片 / 附件路径）解析成 vault 内的真实路径。
//
// 语义按 Obsidian 的读法：
//   - 带 scheme 的绝对 URI（https:、data:…）与协议相对地址（//host/x）原样放行
//   - 应用自身的接口（/api/…）原样放行——它指向后端，不是仓库里的文件
//   - 以 / 开头 → 视为 vault 根相对（Obsidian 里开头的 / 指的是 vault 根）
//   - 其余 → 相对**当前笔记所在目录**解析，支持 ./ 与 ../
//   - 反斜杠按 / 处理：Obsidian 在 Windows 上可能留下 \ 分隔符
//
// 越出 vault 根的路径判为解析失败，不静默退化成根相对。静默兜底会把一条写错的
// 引用变成一个「能打开但不是你要的那个文件」的结果，比直接报错更难排查。
//
// 相对解析之后还有**第二步**：解析出来的路径在全库索引里没有时，按文件名反查一次
// （`pickVaultImagePath`，#8）。Obsidian 的默认写法是裸文件名，而图片引用只有「笔记
// 目录相对」一种读法——裸文件名一律被解到笔记所在目录，实际却躺在仓库根的 `assets/`。

// 带 scheme 的绝对 URI，或协议相对地址（//host/x）
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// 应用自身接口，不是仓库内路径
const APP_ROUTE = /^\/api\//;

/**
 * @typedef {{kind:'vault', path:string}
 *         | {kind:'external', href:string}
 *         | {kind:'invalid', reason:'empty'|'escape-root'}} VaultRef
 */

/**
 * 解析一条引用。
 * @param {string} notePath 当前笔记在 vault 内的路径（根目录笔记传 'name.md'）
 * @param {string} ref 笔记里写的原始引用，可以是百分号编码过的
 * @returns {VaultRef}
 */
export function resolveVaultRef(notePath, ref) {
  const raw = String(ref ?? '').trim().replace(/\\/g, '/');
  if (!raw) return { kind: 'invalid', reason: 'empty' };
  if (EXTERNAL.test(raw) || APP_ROUTE.test(raw)) return { kind: 'external', href: raw };

  // markdown-it 会把引用规范化成百分号编码，这里解回真实文件名再拼路径，
  // 否则中文/带空格的附件名会被二次编码（%E4%B8%AD → %25E4%25B8%25AD）。
  const path = decodeOnce(raw);
  const segments = path.startsWith('/')
    ? path.split('/')
    : [...dirOf(notePath), ...path.split('/')];

  const normalized = normalizeVaultSegments(segments);
  if (normalized == null) return { kind: 'invalid', reason: 'escape-root' };
  if (!normalized) return { kind: 'invalid', reason: 'empty' };
  return { kind: 'vault', path: normalized };
}

/** 解析失败时的可见提示——静态判定的失败与运行时 404 共用同一段文案与样式 */
export const BROKEN_IMAGE_CLASS = 'img-broken';

/**
 * 「还没查完」的中性占位，与 `img-broken` 分开。
 *
 * 它不是一句结论，所以不能共用上面那套文案：全库文件名单还没到手时，我们**判不了**
 * 这个文件在不在，只能说还没查完。这是 `#7` 立下的规矩——「拿不到」与「确实没有」
 * 是两件事，把前者渲染成后者，会让一次网络故障变成上百条「文件不存在」。
 */
export const PENDING_IMAGE_CLASS = 'img-pending';

const REASON_TEXT = {
  empty: '路径为空',
  'escape-root': '相对路径越出仓库根',
  missing: '文件不存在',
};

/**
 * @param {{reason:'empty'|'escape-root'|'missing'|'pending', ref:string}} args
 * @returns {string} HTML
 */
export function brokenImageHtml({ reason, ref }) {
  const code = '<code>' + escapeHtml(ref) + '</code>';
  if (reason === 'pending') {
    return '<span class="' + PENDING_IMAGE_CLASS + '">图片还在确认位置：' + code + '</span>';
  }
  const why = REASON_TEXT[reason] || '无法解析';
  return (
    '<span class="' + BROKEN_IMAGE_CLASS + '">图片无法显示（' + why + '）：' + code + '</span>'
  );
}

/**
 * 运行期取图失败（后端 404、或回来的不是图片）时报哪一句话。
 *
 * 「还在确认位置」只对**库内引用**成立——它才带 `data-vault-path`，也才可能靠反查找回来。
 * 外链与解析即失败的写法没有这个属性，等名单也不会改变结果，如实报失败即可。
 * 把这条判据单独放出来，是为了不让「有条件的中性态」退化成一个无条件的中性态：
 * 那种退化会把一张挂掉的推特图说成「还在确认位置」，正是 `#8` 要消灭的那类错话。
 *
 * @param {{vaultPath?:string, indexReady:boolean}} args
 * @returns {'pending'|'missing'}
 */
export function runtimeFailureReason({ vaultPath, indexReady }) {
  return vaultPath && !indexReady ? 'pending' : 'missing';
}

/**
 * 相对解析之后的第二步：解析出来的路径仓库里没有时，按**文件名**在全库索引里反查（#8）。
 *
 * 为什么需要它：Obsidian 的默认链接格式「能短则短」写出来就是裸文件名
 * （`![](image_1683881602423_0.png)`）——它只在名字**唯一**时才敢省略路径。而图片引用
 * 只有「笔记目录相对」一种读法，于是裸文件名一律被解到笔记所在目录，实际却躺在仓库根的
 * `assets/` 下。实测（归档 `c44cab8`，829 篇，**按 markdown-it 真产出的 `<img>` 数**）：
 * 库内图片引用 111 条，改前 10 张能开 / 101 张打不开，反查救回 95 张——落点全在 `assets/`，
 * 命名 100% 是 Obsidian 粘贴图片时自动生成的形态。
 *
 * 三条路径，票面已定：
 *   - 索引里**有**这个路径 → 原样返回（相对解析成功的现状，那 10 条能开的落点不变）
 *   - 没有、但文件名命中 → 用命中的路径（重名取树序第一个：索引的 `files` 就是先到先得，
 *     与双链 basename 匹配同一条规则，不另造）
 *   - 没命中 / **索引没拿到** → 维持现状，把请求原样发出去，让真实的 404 如实报。
 *     这里不静态改判「文件不存在」：索引是本地快照，它说没有不等于请求会失败；
 *     而把「还没查完」当成「确实没有」，正是上面 `PENDING_IMAGE_CLASS` 要避免的事。
 *
 * @param {import('./wikilinks.js').WikilinkIndex|null} index
 * @param {string} path 相对解析出来的路径
 * @returns {string} 最终要取的文件路径
 */
export function pickVaultImagePath(index, path) {
  if (!index) return path;
  if (index.filesByPath.has(path)) return path;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return index.files.get(base) || path;
}

/**
 * 装上图片规则：把 vault 内引用改写成后端 raw 代理地址，并在无法解析时就地给出提示。
 * @param {import('markdown-it')} md
 * @param {{rawUrl:(path:string)=>string,
 *          getIndex?:()=>import('./wikilinks.js').WikilinkIndex|null}} deps
 */
export function installVaultImageRule(md, deps) {
  const renderToken = md.renderer.rules.image || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    const resolved = resolveVaultRef(env && env.notePath, src);

    if (resolved.kind === 'invalid') return brokenImageHtml({ reason: resolved.reason, ref: src });
    if (resolved.kind === 'vault') {
      // 取索引的时机是渲染期，而索引可能在渲染之后才到——那时 `getIndex` 还是 null，
      // 反查退化成「维持现状」，补渲染时再走一遍这里（见 main.js 的 repaintWithIndex）。
      const path = pickVaultImagePath(deps.getIndex ? deps.getIndex() : null, resolved.path);
      token.attrSet('src', deps.rawUrl(path));
      // 供运行期 404 的提示复用（浏览器拿不到请求失败时用的是哪条 vault 路径）
      token.attrSet('data-vault-path', path);
    }
    return renderToken(tokens, idx, options, env, self);
  };
}

/**
 * 归一化一组路径段：吃掉 `.` 与 `..`，越出仓库根返回 null，空路径返回 ''。
 *
 * 导出是因为双链解析也要用同一套归一化（`wikilinks.js` 的路径写法匹配）。
 * 「越根不静默退化」这条判据只有一份实现，两处引用同一份——复制出来的第二份，
 * 就是将来没人校对、先烂掉的那一份。
 * @param {string[]} segments
 * @returns {string|null}
 */
export function normalizeVaultSegments(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

function dirOf(notePath) {
  const parts = String(notePath || '').split('/');
  return parts.length > 1 ? parts.slice(0, -1) : [];
}

function decodeOnce(ref) {
  try { return decodeURIComponent(ref); } catch { return ref; }
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
