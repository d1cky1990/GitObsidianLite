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

  const normalized = normalizeSegments(segments);
  if (normalized == null) return { kind: 'invalid', reason: 'escape-root' };
  if (!normalized) return { kind: 'invalid', reason: 'empty' };
  return { kind: 'vault', path: normalized };
}

/** 解析失败时的可见提示——静态判定的失败与运行时 404 共用同一段文案与样式 */
export const BROKEN_IMAGE_CLASS = 'img-broken';

const REASON_TEXT = {
  empty: '路径为空',
  'escape-root': '相对路径越出仓库根',
  missing: '文件不存在',
};

/**
 * @param {{reason:'empty'|'escape-root'|'missing', ref:string}} args
 * @returns {string} HTML
 */
export function brokenImageHtml({ reason, ref }) {
  const why = REASON_TEXT[reason] || '无法解析';
  return (
    '<span class="' + BROKEN_IMAGE_CLASS + '">图片无法显示（' + why + '）：' +
    '<code>' + escapeHtml(ref) + '</code></span>'
  );
}

/**
 * 装上图片规则：把 vault 内引用改写成后端 raw 代理地址，并在无法解析时就地给出提示。
 * @param {import('markdown-it')} md
 * @param {{rawUrl:(path:string)=>string}} deps
 */
export function installVaultImageRule(md, deps) {
  const renderToken = md.renderer.rules.image || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    const resolved = resolveVaultRef(env && env.notePath, src);

    if (resolved.kind === 'invalid') return brokenImageHtml({ reason: resolved.reason, ref: src });
    if (resolved.kind === 'vault') {
      token.attrSet('src', deps.rawUrl(resolved.path));
      // 供运行期 404 的提示复用（浏览器拿不到请求失败时用的是哪条 vault 路径）
      token.attrSet('data-vault-path', resolved.path);
    }
    return renderToken(tokens, idx, options, env, self);
  };
}

function dirOf(notePath) {
  const parts = String(notePath || '').split('/');
  return parts.length > 1 ? parts.slice(0, -1) : [];
}

function decodeOnce(ref) {
  try { return decodeURIComponent(ref); } catch { return ref; }
}

/** 归一化 . 与 ..；越出根返回 null */
function normalizeSegments(segments) {
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
