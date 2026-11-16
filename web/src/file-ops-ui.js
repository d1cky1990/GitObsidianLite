// 文件操作的规则与编排（#66）。
//
// 这一票只拥有这个文件。别人的模块按 handoff 的跨票接口调用，绝不在此实现：
//   tree.js（#62）        → refreshTree / getSelectedFolder / selectPath / setSelectedFolder
//   editor-guard.js（#65）→ isLocked
//   settings.js（#63）    → getNewNoteTarget（并行期间尚未落地，见下方兜底）
//   file-names.js          → normalizeNewName / hasName / renameTarget / moveTarget /
//                            dirOf / baseOf / joinPath / stemOf / commitMessage（现成实现，不改）
//   api.js                 → listDir / readFile / createFile / deleteFile（网络边界，可注入假实现）
//
// 为什么不把规则留在 main.js：落点、补 `.md`、撞名、三档失败、附录 C 的逐字文案、
// 写后刷树的时机，全都能从 DOM 抽成纯函数 / 注入依赖的编排，只有这些能被 node --test 钉住。
// 真正的事件接线、点击坐标、真输入法组字、可见视口与明暗两套视觉留真浏览器 / 真机。

import {
  dirOf, baseOf, joinPath, normalizeNewName, hasName, renameTarget, moveTarget, stemOf,
  commitMessage,
} from './file-names.js';
import {
  refreshTree, getSelectedFolder, selectPath, setSelectedFolder,
} from './tree.js';
import { isLocked } from './editor-guard.js';
import { listDir, readFile, createFile, deleteFile } from './api.js';

// 由 #63 提供：getNewNoteTarget() → { mode: 'selected' | 'fixed', dir: string }。
// #63 的 settings.js 此刻还没落地，先用与约定一致的最小兜底让模块与单测能跑；
// 合并阶段由接线处把真实实现注入 createFileOps({ getNewNoteTarget })，此处不另造一套语义。
const defaultGetNewNoteTarget = () => ({ mode: 'selected', dir: '' });

// ---------------------------------------------------------------------------
// 附录 C：已经定过字面的文案（照抄，别改写）
// 唯一允许的改动：新建弹窗提示里「当前目录」→「选中的文件夹」（落点语义变了）。
// 模板里的 {目录} / {文件名} 是占位符，运行时由下面的插值函数替换；模板本身逐字存。
// ---------------------------------------------------------------------------
export const TEXT = Object.freeze({
  createTitle: '新建笔记',
  createHintTpl: '放在 {目录}。只填名字，路径由选中的文件夹决定。',
  duplicate: '这个名字已经有了',
  renameTitle: '重命名',
  renameHintTpl: '只改名字，还放在 {目录}。',
  renameWarnTpl: '别的笔记里指向「{文件名}」的链接会断——本端只认得文件名，读不到别的笔记的正文，改不了那些链接，也报不出断了几条。',
  deleteTitleTpl: '删除「{文件名}」？',
  deleteBody: '删掉就没了，不进回收站，也别处没有副本。删完屏幕下方会给一次**撤销**，那一下能把原内容照原样放回去。',
  deleteSuccessTpl: '已删除 {文件名}',
  undoAction: '撤销',
  pickerTitle: '移动到…',
  pickerUp: '上一级',
  pickerHereTpl: '放这里：{目录}',
  pickerConfirm: '就放这里',
  pickerEmpty: '（没有子目录）',
  dirGone: '指定的目录不在了',
  dirUnknown: '还没问到',
  dirOffline: '连不上',
  locked: '先保存或取消，再改文件',
});

/** 编辑态点置灰的「⋯」时给的那句话（三个文件动作共用，按了要有反馈）。 */
export const LOCKED_HINT = TEXT.locked;

/** 提示条停留：带动作 8 秒、不带动作 2.5 秒。不许照抄原型「普通提示条也停 8 秒」。 */
export const TOAST_MS = 8000;
export const TOAST_MS_PLAIN = 2500;
/** 独立可点区最小 44×44（不许照抄原型里 32px 的裁决气泡与提示条动作命中区）。 */
export const HIT_MIN_PX = 44;
/** 弹窗最大高度 = 可见视口 − 32px；内容超出内部滚动，标题与主动作不滚走。 */
export const DIALOG_VIEWPORT_GUTTER = 32;

const ROOT_LABEL = '仓库根目录';

/** 目录在文案里怎么显示：空目录＝仓库根。 */
export function dirLabel(dir) {
  return dir || ROOT_LABEL;
}

function fill(tpl, values) {
  // 占位符是中文（{目录} / {文件名}），不能用 \w（只匹配 [A-Za-z0-9_]）。
  return String(tpl).replace(/\{([^}]+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : m);
}

/**
 * 新建落点。**只读「选中的文件夹」与设置里的「指定目录」，绝不读「打开的那篇」的路径**——
 * 今天 openCreate() 拿 state.path 当落点，开着笔记会拼出 `某篇.md/新笔记.md`，两栏之后
 * 这个前提立刻失效。函数签名里连 openedPath 这个形参都没有，从形状上堵死这条路。
 *
 * @param {string} selectedFolder getSelectedFolder() 的返回值，没选中是 ''
 * @param {{mode:'selected'|'fixed', dir:string}|undefined} target getNewNoteTarget() 的返回值
 * @returns {string} 相对仓库根的目标目录（'' 表示根）
 */
export function resolveCreateDir(selectedFolder, target) {
  if (target && target.mode === 'fixed') return target.dir || '';
  return selectedFolder || '';
}

export function createHint(dir) {
  return fill(TEXT.createHintTpl, { 目录: dirLabel(dir) });
}
export function renameHint(dir) {
  return fill(TEXT.renameHintTpl, { 目录: dirLabel(dir) });
}
export function renameWarn(name) {
  return fill(TEXT.renameWarnTpl, { 文件名: name });
}
export function deleteTitle(name) {
  return fill(TEXT.deleteTitleTpl, { 文件名: name });
}
export function deleteSuccess(name) {
  return fill(TEXT.deleteSuccessTpl, { 文件名: name });
}
export function pickerHere(dir) {
  return fill(TEXT.pickerHereTpl, { 目录: dirLabel(dir) });
}
/** 新建成功后的提示（F-6「已新建 X」）；沿用今天 doCreate 里「名字含 .md」的口径。 */
export function createdToast(name) {
  return `已新建 ${name}`;
}

/**
 * 树行的入口规则：文件夹行不响应长按、没有改名 / 移动 / 删除；笔记行才出三个动作。
 * 树行不挂常驻「⋯」，只有窄屏长按 / 宽屏悬停才出现——那是 DOM 层的事，这里只定「有没有」。
 */
export function opsForRow(entry) {
  if (!entry || entry.type === 'dir' || entry.type === 'folder' || entry.isDir === true) return [];
  return ['rename', 'move', 'delete'];
}

function isOffline(error) {
  if (!error) return false;
  if (error.offline === true || error.network === true || error.status === 0) return true;
  const m = String(error.message || error.name || '').toLowerCase();
  // 断网时 fetch 抛的是 TypeError('Failed to fetch') 一类，不在这里冒充「找不到」
  if (/(fetch|network|offline|failed|timeout|abort|econn|连不上|离线)/.test(m)) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return false;
}

function isGone(error) {
  return error.notFound === true || error.status === 404;
}

/**
 * 打开新建弹窗那一刻的目录核对，三档失败互不冒充：
 *   指定的目录不在了 / 还没问到 / 连不上（断网不许说「找不到」）。
 * 两条出路文案（去设置改 / 就在这里改这一次）归 #63 渲染，这里只给 kind。
 */
export function classifyDirCheck(error, entries) {
  if (error) {
    if (isOffline(error)) return { kind: 'offline', text: TEXT.dirOffline };
    if (isGone(error)) return { kind: 'gone', text: TEXT.dirGone };
    return { kind: 'unknown', text: TEXT.dirUnknown };
  }
  if (Array.isArray(entries)) return { kind: 'ok', entries };
  return { kind: 'unknown', text: TEXT.dirUnknown };
}
