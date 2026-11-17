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
import { icon } from './icons.js';

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

// ---------------------------------------------------------------------------
// 切片 2：弹窗数据模型、常驻浮层骨架、树行入口判定、核对事件
//
// 这些是「从 DOM 抽出来的纯函数」：main.js 的 syncFileOpsLayer() 只把 dialogView()
// 的结果机械地写到常驻节点上，不在这里碰 document。这样「新建 / 移动同形态」、
// 「新建落点只读选中的文件夹」、「逐字文案」「撞名不改名字」都能被 node --test 钉住。
// ---------------------------------------------------------------------------

function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 附录 C 的删除正文里 `**撤销**` 是 markdown 加粗记号。常量逐字存（切片 1 的
 * TEXT.deleteBody 与单测都钉死），界面渲染时把它转成 <b>，不把星号显示给用户；
 * 其余字符原样并转义。只做这一处转换，绝不改写定稿字面。
 */
export function renderEmphasis(tpl) {
  const s = String(tpl == null ? '' : tpl);
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        out.push('<b>' + escText(s.slice(i + 2, end)) + '</b>');
        i = end + 2;
        continue;
      }
    }
    out.push(escText(s[i]));
    i += 1;
  }
  return out.join('');
}

/**
 * 新建弹窗模型：**两块**（名字输入框 + 一个已经填好的目录）。
 * 落点只经 resolveCreateDir(selectedFolder, target)，签名里连 openedPath 都没有，
 * 从形状上杜绝 `某篇.md/新笔记.md`。标题 / 提示逐字取附录 C（提示里「当前目录」
 * 已按 #51 裁决改成「选中的文件夹」）。
 */
export function createDialogModel({ selectedFolder = '', target, value = '', error = '' } = {}) {
  const dir = resolveCreateDir(selectedFolder, target);
  return {
    type: 'prompt', action: 'create',
    title: TEXT.createTitle,
    hint: createHint(dir),
    dir, showDir: true,
    value, error, okLabel: '新建',
  };
}

/** 重命名弹窗：只改名字、还放在原目录（提示说「还放在」），不露目录块。 */
export function renameDialogModel({ path = '', value, error = '' } = {}) {
  const dir = dirOf(path);
  return {
    type: 'prompt', action: 'rename', subject: path,
    title: TEXT.renameTitle,
    hint: renameHint(dir),
    warn: renameWarn(baseOf(path)),
    dir, showDir: false,
    value: value != null ? value : stemOf(path),
    error, okLabel: '改名',
  };
}

/**
 * 移动弹窗：**与新建弹窗同一个形态**（名字 + 已填好的目录，目录就在弹窗里改）。
 * 标题复用附录 C 目录选择器那句「移动到…」，hint 留空——不新造附录 C 之外的文案。
 */
export function moveDialogModel({ path = '', value, error = '' } = {}) {
  return {
    type: 'prompt', action: 'move', subject: path,
    title: TEXT.pickerTitle,
    hint: '',
    dir: dirOf(path), showDir: true,
    value: value != null ? value : stemOf(path),
    error, okLabel: '移动',
  };
}

/** 删除确认弹窗：标题与正文逐字照抄（**撤销** 交给 renderEmphasis 转加粗）。 */
export function deleteDialogModel({ path = '' } = {}) {
  return {
    type: 'confirm', action: 'delete', subject: path,
    title: deleteTitle(baseOf(path)),
    body: renderEmphasis(TEXT.deleteBody),
    okLabel: '删除', danger: true,
  };
}

/**
 * 弹窗各常驻节点的「显隐 + 文本」纯数据。syncFileOpsLayer() 只把它机械写到 DOM，
 * 不在这里碰 document；#dlg-input 的 value 只在 fresh（新打开）时设一次，之后
 * 重画绝不覆盖，中文拼音组字不中断、撞名拒绝也不把名字改掉。
 */
export function dialogView(d) {
  if (!d) return { show: false };
  const isPrompt = d.type === 'prompt';
  return {
    show: true,
    isPrompt,
    title: d.title || '',
    hint: d.hint || '',
    showHint: !!d.hint,
    warn: d.warn || '',
    showWarn: !!d.warn,
    bodyHtml: d.body || '',
    showBody: !isPrompt,
    showInput: isPrompt,
    showDir: isPrompt && d.showDir === true,
    dirLabel: dirLabel(d.dir || ''),
    error: d.error || '',
    okLabel: d.okLabel || '确定',
    okAct: isPrompt ? 'submitDialog' : 'confirmDialog',
    okClass: d.danger ? 'danger' : 'primary',
    fresh: !!d.__fresh,
    value: d.value || '',
  };
}

export const DIALOG_INPUT_ID = 'dlg-input';

/**
 * 文件操作的常驻浮层骨架（一次性注入 body，之后只切 hidden / 改文本，绝不重建）。
 * **#dlg-input 整层只建一次**：新建 / 移动 / 重命名 / 删除共用同一个输入节点，
 * 重画只切 hidden，中文输入法正在组字时节点不会被换掉（§6 第 1 条）。
 * 弹窗里目录块 data-act="pickDir" 就地打开目录选择器，不另设二级入口。
 * 操作表 / 目录选择器各自一个宿主：它们没有输入框，内容可随状态重建。
 */
export function fileOpsLayerHtml() {
  return [
    '<div id="file-ops-layer" hidden>',
    '  <div class="modal-mask fo-mask" data-act="closeDialog" hidden></div>',
    '  <div class="modal fo-modal" id="fo-modal" hidden>',
    '    <div class="modal-title" id="fo-title"></div>',
    '    <div class="fo-modal-scroll" id="fo-modal-scroll">',
    '      <div class="modal-hint" id="fo-hint" hidden></div>',
    '      <input id="dlg-input" class="dlg-input" type="text" autocapitalize="off" autocomplete="off" spellcheck="false">',
    '      <button class="fo-dir-row" id="fo-dir" data-act="pickDir" type="button" hidden>',
    '        <span class="fo-dir-ic" aria-hidden="true">' + icon('folder', 18) + '</span>',
    '        <span class="fo-dir-label" id="fo-dir-label"></span>',
    '        <span class="fo-dir-chevron" aria-hidden="true">' + icon('chevron-right', 18) + '</span>',
    '      </button>',
    '      <div class="modal-warn" id="fo-warn" hidden></div>',
    '      <div class="modal-body" id="fo-body" hidden></div>',
    '      <div class="modal-err" id="fo-err"></div>',
    '    </div>',
    '    <div class="modal-btns fo-modal-btns">',
    '      <button id="fo-cancel" data-act="closeDialog" type="button">取消</button>',
    '      <button id="fo-ok" class="primary" type="button">确定</button>',
    '    </div>',
    '  </div>',
    '  <div id="fo-ops-host"></div>',
    '  <div id="fo-picker-host"></div>',
    '</div>',
  ].join('\n');
}

/** 一条树行有没有写操作：复用切片 1 的 opsForRow（文件夹行没有改名/移动/删除）。 */
export function rowHasOps(entry) {
  return opsForRow(entry).length > 0;
}

/** 长按只在「窄屏 + 笔记行」起：宽屏走悬停、文件夹行不响应长按。 */
export function shouldStartLongPress({ isNoteRow = false, wide = false } = {}) {
  return !wide && !!isNoteRow;
}

/**
 * 打开新建弹窗那一刻要派发的核对事件（#63 的 initSettings 已监听）。
 * 事件名与 detail 结构按 settings.js 的约定，绝不另造一套；断网由 #63 说「连不上」。
 */
export const NEW_TARGET_CHECK_EVENT = 'ui:new-note-target-check';
export function newNoteTargetCheckDetail(target) {
  return { target: target || { mode: 'selected', dir: '' } };
}

// ---------------------------------------------------------------------------
// 切片 2b：操作表 / 目录选择器的骨架
//
// 这两层没有输入框，内容可以随状态重建；**只有新建弹窗那个 #dlg-input 才常驻不换
// 节点**（见 fileOpsLayerHtml）。逐字文案取附录 C，图标全走 icons.js 的内联 SVG。
// ---------------------------------------------------------------------------

/** 窄屏长按阈值（ms）：按下即给反馈，到点出操作表。真手势留真机验。 */
export const LONG_PRESS_MS = 450;

/** 目录选择器只列文件夹；笔记与其它类型都不进。 */
export function foldersOf(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && e.type === 'dir');
}

/**
 * 「⋯」点开的操作表（笔记页与目录页同一套，正文顶栏与树行长按共用）。
 * 编辑 / 冲突态三个动作置灰但**仍能按**：置灰用 class（不 disable），
 * 按了给那句「先保存或取消，再改文件」由 main.js 的点击分发统一处理（与 #65 同口径）。
 */
export function opsSheetHtml({ name = '', locked = false, lockedHint = LOCKED_HINT } = {}) {
  const cls = locked ? ' is-disabled' : '';
  return [
    '<div class="sheet-mask" data-act="closeOps"></div>',
    '<div class="sheet auto">',
    '  <div class="sheet-head">' + escText(name) + '</div>',
    '  <div class="ops">',
    '    <button class="op' + cls + '" data-op="rename">重命名</button>',
    '    <button class="op' + cls + '" data-op="move">移动</button>',
    '    <button class="op danger' + cls + '" data-op="delete">删除</button>',
    '  </div>',
    locked ? '  <div class="op-hint">' + escText(lockedHint) + '</div>' : '',
    '  <div class="sheet-foot"><div class="sheet-row">',
    '    <button data-act="closeOps">取消</button>',
    '  </div></div>',
    '</div>',
  ].filter(Boolean).join('\n');
}

/**
 * 目录选择器：复用今天「移动笔记」那套（逐层点进去 / 上一级 / 就放这里 /「（没有子目录）」），
 * 交互不变、形态沿用 .sheet。四句文案逐字取附录 C；实体目录由 foldersOf 过滤。
 * 「上一级」用 chevron 内联 SVG 转向上，不用字符 / emoji。读目录忙时「就放这里」置灰，
 * 判不了重名就不答应（main.js 的 pickerMoveHere 再兜一次）。
 */
export function pickerHtml({ dir = '', entries = [], busy = false, error = '' } = {}) {
  const dirs = foldersOf(entries);
  const up = dir
    ? '<button class="row pick-row" data-enter="' + escText(dirOf(dir)) + '">' +
      '<span class="fo-up-ic" aria-hidden="true">' + icon('chevron-right', 18) + '</span>' +
      '<span class="nm">' + escText(TEXT.pickerUp) + '</span></button>'
    : '';
  const rows = dirs.map((d) =>
    '<button class="row pick-row" data-enter="' + escText(d.path) + '">' +
    '<span class="ic dir" aria-hidden="true">' + icon('folder', 18) + '</span>' +
    '<span class="nm">' + escText(d.name) + '</span></button>').join('');
  const empty = (!dirs.length && !busy)
    ? '<div class="center dim">' + escText(TEXT.pickerEmpty) + '</div>'
    : '';
  const body = busy ? '<div class="center">加载中…</div>' : (up + rows + empty);
  return [
    '<div class="sheet-mask" data-act="closePicker"></div>',
    '<div class="sheet">',
    '  <div class="sheet-head">' + escText(TEXT.pickerTitle) + '</div>',
    '  <div class="pick-crumbs">' + escText(dir ? dir.split('/').join(' / ') : '根目录') + '</div>',
    '  <div class="sheet-body pick-body">' + body + '</div>',
    '  <div class="sheet-foot">',
    '    <div class="pick-target">' + escText(pickerHere(dir)) + '</div>',
    error ? '    <div class="modal-err">' + escText(error) + '</div>' : '',
    '    <div class="sheet-row"><button data-act="closePicker">取消</button>' +
      '<button class="primary' + (busy ? ' is-disabled' : '') + '" data-act="moveHere">' +
      escText(TEXT.pickerConfirm) + '</button></div>',
    '  </div>',
    '</div>',
  ].filter(Boolean).join('\n');
}
