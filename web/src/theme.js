// 主题三档偏好与 <html data-theme> 落地（#61）。
//
// ⚠️ 镜像注释 —— web/index.html <head> 里有一段**内联定色脚本**，它在主样式表之前
// 读同一份记录、按同一套规则写好 data-theme，保证暗色用户第一帧不闪白。两处共用：
//   - 存储键 THEME_KEY = 'gitobsidianlite.theme'
//   - 取值 light / dark / system，缺省 system
//   - system 用 matchMedia('(prefers-color-scheme: dark)') 解析成最终的 light / dark
// 任一处改了存储格式或解析规则，另一处**必须同改**（内联脚本在模块加载前就跑，
// 没法 import 这里，所以这份约定只能靠镜像注释守住）。

export const THEME_KEY = 'gitobsidianlite.theme';
export const THEME_VALUES = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}
function defaultMatchMedia() {
  try {
    return typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : null;
  } catch (_) { return null; }
}
function defaultRoot() {
  try { return globalThis.document?.documentElement ?? null; } catch (_) { return null; }
}

function normalize(value) {
  return THEME_VALUES.includes(value) ? value : 'system';
}

/** 读本机主题记录：坏值、非法值、读不了都回落到 system。 */
export function getThemePreference(storage = defaultStorage()) {
  let raw = null;
  try { raw = storage ? storage.getItem(THEME_KEY) : null; } catch (_) { /* 读不了当没有 */ }
  return normalize(raw);
}

/** 写本机主题记录：只收三档，非法值归一为 system；写失败不抛。 */
export function setThemePreference(value, storage = defaultStorage()) {
  const v = normalize(value);
  try { if (storage) storage.setItem(THEME_KEY, v); } catch (_) { /* 配额 / 隐私模式 */ }
  return v;
}

function resolve(pref, matchMedia) {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  try {
    if (matchMedia) return matchMedia(DARK_QUERY)?.matches ? 'dark' : 'light';
  } catch (_) { /* 不支持就按浅色 */ }
  return 'light';
}

function writeRoot(root, resolved) {
  if (!root) return;
  if (root.dataset) root.dataset.theme = resolved;
  if (root.style) root.style.colorScheme = resolved;
}

// root -> { mql, handler }：同一个 root 不重复挂监听，离开 system 档时撤掉。
const watchers = new WeakMap();

function syncWatcher(root, pref, matchMedia) {
  const existing = watchers.get(root);
  const detach = () => {
    if (existing && typeof existing.mql.removeEventListener === 'function') {
      try { existing.mql.removeEventListener('change', existing.handler); } catch (_) { /* 忽略 */ }
    }
    watchers.delete(root);
  };
  if (pref !== 'system') { detach(); return; }

  let mql = null;
  try { mql = matchMedia ? matchMedia(DARK_QUERY) : null; } catch (_) { /* 忽略 */ }
  if (!mql || typeof mql.addEventListener !== 'function') { detach(); return; }
  if (existing && existing.mql === mql) return; // 幂等：同一个 mql 不重复挂

  const handler = () => writeRoot(root, resolve('system', matchMedia));
  mql.addEventListener('change', handler);
  watchers.set(root, { mql, handler });
}

/**
 * 主程序启动后调用：读同一份记录、把解析后的 light/dark 写到 data-theme 与
 * color-scheme；system 档额外挂系统外观监听（变化即时改 data-theme，不动存储）。
 * 不刷新页面、不给全局颜色加过渡。返回解析后的 'light' | 'dark'。
 */
export function applyTheme(opts = {}) {
  const storage = 'storage' in opts ? opts.storage : defaultStorage();
  const matchMedia = 'matchMedia' in opts ? opts.matchMedia : defaultMatchMedia();
  const root = 'root' in opts ? opts.root : defaultRoot();
  const pref = getThemePreference(storage);
  const resolved = resolve(pref, matchMedia);
  writeRoot(root, resolved);
  if (root) syncWatcher(root, pref, matchMedia);
  return resolved;
}
