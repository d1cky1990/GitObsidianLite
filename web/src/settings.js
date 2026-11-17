// 设置面板：黑白三档、新建落点两档、关于，以及「指定目录不在了」的核对（#63）。
//
// 这一层只做纯逻辑、本机存储与 HTML 字符串：DOM 接线（渲染到 #settings-view、
// 分段选择器点击、返回目录、打开新建弹窗那一刻触发核对）在同文件下方 initSettings()
// 与 main.js 的 /* #63 */ 接线块，真浏览器验。
//
// 主题读写**只 import theme.js**（#61 拥有，不改）：三档取值、存储键、system 跟随
// 系统外观都由那边定，这里不另造一套。新建落点 getNewNoteTarget / setNewNoteTarget
// 是跨票接口，归 #66 在新建弹窗预填目录时调用。

import {
  THEME_VALUES, getThemePreference, setThemePreference, applyTheme,
} from './theme.js';
import { icon } from './icons.js';
import { escapeHtml } from './sidebar-search.js';

/* ---------- 新建落点（跨票接口，#66 用） ---------- */

export const TARGET_KEY = 'gitobsidianlite.newNoteTarget.v1';
export const DEFAULT_TARGET = { mode: 'selected', dir: '' }; // 没存过 → 选中的文件夹
export const TARGET_MODES = ['selected', 'fixed'];

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}

/** 只收 selected / fixed 两档；坏值、非法 mode、非字符串 dir 都回落到默认档。 */
export function normalizeTarget(value) {
  if (value && typeof value === 'object' && value.mode === 'fixed') {
    return { mode: 'fixed', dir: typeof value.dir === 'string' ? value.dir : '' };
  }
  return { mode: 'selected', dir: '' };
}

/** 读本机记录：没存过 / 坏 JSON / 非法值 / 读不了 → 默认「选中的文件夹」。 */
export function getNewNoteTarget(storage = defaultStorage()) {
  let raw = null;
  try { raw = storage ? storage.getItem(TARGET_KEY) : null; } catch (_) { /* 读不了当没有 */ }
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* 坏值当没有 */ }
  return normalizeTarget(parsed);
}

/** 写本机记录：先归一，再写 JSON；写失败不抛，仍返回归一后的值。 */
export function setNewNoteTarget(value, storage = defaultStorage()) {
  const t = normalizeTarget(value);
  try { if (storage) storage.setItem(TARGET_KEY, JSON.stringify(t)); } catch (_) { /* 配额 / 隐私模式 */ }
  return t;
}

/* ---------- 黑白三档（只影响这台设备、选完立刻生效不确认） ---------- */

export const THEME_OPTIONS = [
  { value: 'light', label: '白' },
  { value: 'dark', label: '黑' },
  { value: 'system', label: '跟随系统' },
];

/**
 * 选一档：写本机记录 + 立刻 applyTheme（不刷新、不确认、不给全局颜色加过渡）。
 * storage / matchMedia / root 可注入，便于单测；缺省用 theme.js 的真实环境。
 * 返回归一后的 'light' | 'dark' | 'system'。
 */
export function selectTheme(value, opts = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(opts, k);
  const v = has('storage') ? setThemePreference(value, opts.storage) : setThemePreference(value);
  const applyOpts = {};
  if (has('storage')) applyOpts.storage = opts.storage;
  if (has('matchMedia')) applyOpts.matchMedia = opts.matchMedia;
  if (has('root')) applyOpts.root = opts.root;
  applyTheme(applyOpts);
  return v;
}

/* ---------- 关于：版本号 + 构建提交短号 + 项目地址一行小字
   （取不到提交号只显示版本号、不让构建失败；项目地址只放公开仓库地址，
    不写笔记仓库名 / 凭据 / 绝对路径 / 机器名 —— 公共界面硬规矩） ---------- */

export const APP_VERSION = '0.1.0';
export const PROJECT_URL = 'https://github.com/d1cky1990/GitObsidianLite';

/**
 * 构建那次的提交短号由 vite.config.js 的 define 注入 __APP_COMMIT__。
 * 取不到（没有 git / 命令失败 / node 单测没有注入）时返回空串 —— typeof 对未声明
 * 变量是安全的，再包一层 try/catch，绝不因为拿不到号让构建或运行失败。
 */
export function readBuildCommit() {
  try { return typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : ''; }
  catch (_) { return ''; }
}

/** 有提交号 → `0.1.0 · 3f9c2a1`；取不到 → 只 `0.1.0`。 */
export function formatAbout({ version = APP_VERSION, commit = '' } = {}) {
  const v = version || APP_VERSION;
  const c = commit ? String(commit).trim() : '';
  return c ? v + ' · ' + c : v;
}

/* ---------- 设置面板 HTML：只装三块 ---------- */

function segButton({ attr, value, label, active }) {
  return '<button class="seg' + (active ? ' is-active' : '') + '"' +
    ' ' + attr + '="' + value + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
    escapeHtml(label) + '</button>';
}

/**
 * 三块内容 + 自带「‹ 返回目录」。三块换进换出不进历史由 layout.js 的
 * showSidebarView 只切 hidden 保证，这里不碰 history / 地址栏。
 * 不装访问密码、不装「连的是哪个仓库」。
 *
 * @param {{theme?:string, target?:{mode,dir}, version?:string, commit?:string}} args
 */
export function settingsHtml({ theme = 'system', target = DEFAULT_TARGET,
  version = APP_VERSION, commit = readBuildCommit() } = {}) {
  const t = normalizeTarget(target);
  const currentTheme = THEME_VALUES.includes(theme) ? theme : 'system';

  const themeSeg = '<div class="seg-group" role="group" aria-label="黑白模式">' +
    THEME_OPTIONS.map((o) => segButton({
      attr: 'data-theme-opt', value: o.value, label: o.label, active: o.value === currentTheme,
    })).join('') + '</div>';

  const targetSeg = '<div class="seg-group" role="group" aria-label="新建落点">' +
    segButton({ attr: 'data-target-mode', value: 'selected', label: '选中的文件夹', active: t.mode === 'selected' }) +
    segButton({ attr: 'data-target-mode', value: 'fixed', label: '指定目录', active: t.mode === 'fixed' }) +
    '</div>';
  // 选「指定目录」才露出「是哪个目录」和它的选择入口（P-2）。
  const dirRow = t.mode === 'fixed'
    ? '<div class="target-dir-row">' +
      '<span class="target-dir-caption">指定目录</span>' +
      '<input class="target-dir-input" data-target-dir type="text" value="' + escapeHtml(t.dir) + '"' +
      ' placeholder="目录路径" autocapitalize="off" autocomplete="off" spellcheck="false">' +
      '<button class="target-dir-pick" data-target-pick>选择目录</button>' +
      '</div>'
    : '';

  return '<section class="settings">' +
    '<button class="settings-back" data-settings-back>' + icon('back') + '返回目录</button>' +
    '<div class="settings-block settings-theme">' +
      '<h2 class="settings-h">黑白模式</h2>' + themeSeg +
      '<p class="settings-note">选完立刻生效，只影响这台设备。</p>' +
    '</div>' +
    '<div class="settings-block settings-target">' +
      '<h2 class="settings-h">新建落点</h2>' + targetSeg + dirRow +
      '<p class="settings-note">只决定新建弹窗预填哪个目录，弹窗里照旧可改这一次。</p>' +
    '</div>' +
    '<div class="settings-block settings-about">' +
      '<h2 class="settings-h">关于</h2>' +
      '<p class="settings-version">' + escapeHtml(formatAbout({ version, commit })) + '</p>' +
      '<p class="settings-project">' + escapeHtml(PROJECT_URL) + '</p>' +
    '</div>' +
  '</section>';
}

/* ---------- 指定目录不在了：打开新建弹窗那一刻的一次轻核对（文案归 #63） ---------- */

export const NEW_TARGET_COPY = {
  missing: '指定的目录不在了',
  offline: '连不上，暂时确认不了指定的目录在不在',
  fixGeneric: '去设置改通用路径',
  fixHere: '就在这里改这一次',
};

/**
 * 那次轻请求（api.js 的 listDir = GET /api/tree?path=）的结果分档。
 * listDir 对不存在的目录两家都归一成 `[]`（不是 404），所以：
 *   - 非空数组 → 在（ok）
 *   - 空数组 / 非数组 → 不在了（missing）
 *   - 请求失败（断网 / 要密码 / 5xx） → 连不上（offline），**不许说「找不到」**
 * 只看一次结果，不追目录的改名搬家。
 */
export function classifyDirProbe(result) {
  if (!result || result.ok !== true) return 'offline';
  const entries = result.entries;
  return (Array.isArray(entries) && entries.length > 0) ? 'ok' : 'missing';
}

/**
 * 打开新建弹窗那一刻核对「指定目录那一层在不在」。
 * 默认档（选中的文件夹）不核对、不发起请求；固定档只调一次 probe(dir)。
 * probe 由调用方注入（真环境 = listDir），便于单测与 #66 复用。
 *
 * @returns {Promise<{kind:'ok'|'missing'|'offline', dir:string}>}
 */
export async function verifyNewNoteTarget(target, { probe } = {}) {
  const t = normalizeTarget(target);
  if (t.mode !== 'fixed') return { kind: 'ok', dir: '' };
  if (typeof probe !== 'function') return { kind: 'offline', dir: t.dir };
  let result;
  try {
    const entries = await probe(t.dir);
    result = { ok: true, entries };
  } catch (e) {
    result = { ok: false, error: e };
  }
  return { kind: classifyDirProbe(result), dir: t.dir };
}

/**
 * 核对结果的说法：
 *  - missing：当场报「指定的目录不在了」+ 两条出路（去设置改 / 就在这里改这一次）
 *  - offline：只说「连不上」，不冒充「不在了」，不给那两条出路
 *  - ok / 其它：不落任何报错
 */
export function newNoteTargetIssueHtml(kind, dir = '') {
  if (kind === 'offline') {
    return '<div class="target-issue target-offline" data-target-dir="' + escapeHtml(dir) + '">' +
      '<p class="target-issue-msg">' + escapeHtml(NEW_TARGET_COPY.offline) + '</p></div>';
  }
  if (kind === 'missing') {
    return '<div class="target-issue target-missing" data-target-dir="' + escapeHtml(dir) + '">' +
      '<p class="target-issue-msg">' + escapeHtml(NEW_TARGET_COPY.missing) + '</p>' +
      '<div class="target-issue-actions">' +
      '<button data-target-fix="settings">' + escapeHtml(NEW_TARGET_COPY.fixGeneric) + '</button>' +
      '<button data-target-fix="here">' + escapeHtml(NEW_TARGET_COPY.fixHere) + '</button>' +
      '</div></div>';
  }
  return '';
}

/* ---------- DOM 接线层（真浏览器验；node 无 document 时整段 no-op） ---------- */

/**
 * 一次性接线。往 #settings-view 填三块（黑白 / 新建落点 / 关于），接分段选择器、
 * 「‹ 返回目录」、指定目录入口与两条出路，以及「打开新建弹窗那一刻」的核对事件。
 * 主题切换只调 selectTheme（setThemePreference + applyTheme），不刷新、不确认。
 * 三块换进换出不进 history：这里只调注入的 showView（layout.js 只切 hidden）。
 */
export function initSettings(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.getElementById !== 'function') return null;
  const view = doc.getElementById('settings-view');
  if (!view) return null;
  const showView = typeof deps.showView === 'function' ? deps.showView : () => {};
  const dirProbe = typeof deps.dirProbe === 'function' ? deps.dirProbe : null;
  const storage = deps.storage;       // undefined → 用真实 localStorage
  const matchMedia = deps.matchMedia;
  const root = deps.root;

  function themeOpts() {
    const o = {};
    if (storage !== undefined) o.storage = storage;
    if (matchMedia !== undefined) o.matchMedia = matchMedia;
    if (root !== undefined) o.root = root;
    return o;
  }
  function render() {
    view.innerHTML = settingsHtml({
      theme: getThemePreference(storage),
      target: getNewNoteTarget(storage),
    });
  }

  // 常驻的「指定目录不在了」问题区：切 hidden，不换任何常驻输入节点。
  let issueHost = doc.getElementById('new-target-issue');
  if (!issueHost && typeof doc.createElement === 'function') {
    issueHost = doc.createElement('div');
    issueHost.id = 'new-target-issue';
    issueHost.className = 'new-target-issue';
    issueHost.hidden = true;
    (doc.body || view).appendChild(issueHost);
  }
  function showTargetIssue(kind, dir) {
    if (!issueHost) return;
    issueHost.innerHTML = newNoteTargetIssueHtml(kind, dir);
    issueHost.hidden = !issueHost.innerHTML;
  }
  function dispatch(name, detail) {
    try { doc.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) { /* 老环境忽略 */ }
  }

  doc.addEventListener('ui:shell-action', (e) => {
    const action = e && e.detail && e.detail.action;
    if (action === 'settings') render(); // 每次进设置重画，当前档一眼看得出
  });

  doc.addEventListener('click', (e) => {
    const t = e && e.target;
    const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
    if (closest('[data-settings-back]')) { showView('tree'); return; }  // 自带返回目录，不靠返回键
    const themeOpt = closest('[data-theme-opt]');
    if (themeOpt) {
      selectTheme(themeOpt.dataset.themeOpt, themeOpts()); // 立刻生效、不确认、只影响本机
      render();
      return;
    }
    const modeOpt = closest('[data-target-mode]');
    if (modeOpt) {
      const cur = getNewNoteTarget(storage);
      setNewNoteTarget({ mode: modeOpt.dataset.targetMode, dir: cur.dir }, storage);
      render();
      return;
    }
    if (closest('[data-target-pick]')) {
      dispatch('ui:pick-target-dir', { dir: getNewNoteTarget(storage).dir }); // 目录选择器归 #66
      return;
    }
    const fix = closest('[data-target-fix]');
    if (fix) {
      if (issueHost) issueHost.hidden = true;
      if (fix.dataset.targetFix === 'settings') { showView('settings'); render(); }
      else dispatch('ui:target-fix-here', {}); // 「就在这里改这一次」交给 #66 弹窗
      return;
    }
  });

  // 指定目录的值就地改通用路径（不改这一次；弹窗里照旧可改这一次）
  doc.addEventListener('input', (e) => {
    const inp = e && e.target;
    if (inp && inp.matches && inp.matches('[data-target-dir]')) {
      setNewNoteTarget({ mode: 'fixed', dir: inp.value }, storage);
    }
  });

  // 打开新建弹窗那一刻核对指定目录：触发点归 #66 派发本事件，核对逻辑与文案归 #63。
  doc.addEventListener('ui:new-note-target-check', (e) => {
    const target = (e && e.detail && e.detail.target) || getNewNoteTarget(storage);
    const probe = dirProbe || (() => Promise.reject(new Error('no probe')));
    verifyNewNoteTarget(target, { probe }).then((r) => showTargetIssue(r.kind, r.dir));
  });

  render(); // 首屏就画好，当前档一眼看得出
  return { render, showTargetIssue };
}
