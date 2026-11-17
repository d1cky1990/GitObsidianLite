// `web/src/file-ops-ui.js` 的规则测试（#66）。
//
// 接缝：本模块的公开导出函数（纯逻辑）+ 用假依赖注入的编排控制器。
// DOM 接线、点击坐标、真输入法组字、可见视口、明暗两套视觉留真浏览器 / 真机。
//
// 期望值一律手抄附录 C / 工单字面，不从被测模块的常量反推——否则断言恒真、测不出写错字。
// 被测模块整体 import 后跑，注入假依赖，不另写一份复刻被测逻辑的复算脚本。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT, LOCKED_HINT, TOAST_MS, TOAST_MS_PLAIN, HIT_MIN_PX, DIALOG_VIEWPORT_GUTTER,
  dirLabel, resolveCreateDir, createHint, renameHint, renameWarn,
  deleteTitle, deleteSuccess, createdToast, pickerHere,
  opsForRow, classifyDirCheck,
  createDialogModel, renameDialogModel, moveDialogModel, deleteDialogModel,
  renderEmphasis, dialogView, fileOpsLayerHtml, rowHasOps, shouldStartLongPress,
  NEW_TARGET_CHECK_EVENT, newNoteTargetCheckDetail,
  opsSheetHtml, pickerHtml, foldersOf, LONG_PRESS_MS,
} from './file-ops-ui.js';

// ---------------------------------------------------------------------------
// 切片 1：逐字文案（附录 C）与可由 DOM 抽出来的纯规则
// ---------------------------------------------------------------------------

test('文案：新建 / 重名 / 重命名，逐字对照附录 C，只改「当前目录」→「选中的文件夹」', () => {
  assert.equal(TEXT.createTitle, '新建笔记');
  // 唯一允许的改动：新建弹窗提示里「当前目录」→「选中的文件夹」
  assert.equal(TEXT.createHintTpl, '放在 {目录}。只填名字，路径由选中的文件夹决定。');
  assert.equal(TEXT.duplicate, '这个名字已经有了');
  assert.equal(TEXT.renameTitle, '重命名');
  assert.equal(TEXT.renameHintTpl, '只改名字，还放在 {目录}。');
  assert.equal(
    TEXT.renameWarnTpl,
    '别的笔记里指向「{文件名}」的链接会断——本端只认得文件名，读不到别的笔记的正文，改不了那些链接，也报不出断了几条。',
  );
});

test('文案：删除确认 / 删除成功 / 撤销动作，逐字对照附录 C', () => {
  assert.equal(TEXT.deleteTitleTpl, '删除「{文件名}」？');
  assert.equal(
    TEXT.deleteBody,
    '删掉就没了，不进回收站，也别处没有副本。删完屏幕下方会给一次**撤销**，那一下能把原内容照原样放回去。',
  );
  assert.equal(TEXT.deleteSuccessTpl, '已删除 {文件名}');
  assert.equal(TEXT.undoAction, '撤销');
  assert.equal(deleteTitle('日记.md'), '删除「日记.md」？');
  assert.equal(deleteSuccess('日记.md'), '已删除 日记.md');
});

test('文案：目录选择器四句 + 空目录那句，逐字对照附录 C', () => {
  assert.equal(TEXT.pickerTitle, '移动到…');
  assert.equal(TEXT.pickerUp, '上一级');
  assert.equal(TEXT.pickerHereTpl, '放这里：{目录}');
  assert.equal(TEXT.pickerConfirm, '就放这里');
  assert.equal(TEXT.pickerEmpty, '（没有子目录）');
  assert.equal(pickerHere('日记/2026'), '放这里：日记/2026');
});

test('文案：三档失败与编辑态拦截，断网不许说「找不到」', () => {
  assert.equal(TEXT.dirGone, '指定的目录不在了');
  assert.equal(TEXT.dirUnknown, '还没问到');
  assert.equal(TEXT.dirOffline, '连不上');
  assert.equal(LOCKED_HINT, '先保存或取消，再改文件');
  assert.equal(TEXT.locked, '先保存或取消，再改文件');
});

test('提示条与尺寸：带动作停 8 秒、普通提示 2.5 秒、命中区 44、弹窗留 32px', () => {
  // 不许照抄原型：普通提示条停 8 秒是写歪的，带动作才是 8 秒
  assert.equal(TOAST_MS, 8000);
  assert.equal(TOAST_MS_PLAIN, 2500);
  assert.equal(HIT_MIN_PX, 44);
  assert.equal(DIALOG_VIEWPORT_GUTTER, 32);
});

test('插值：{目录} / {文件名} 逐字替换，根用「仓库根目录」', () => {
  assert.equal(dirLabel(''), '仓库根目录');
  assert.equal(dirLabel('日记/2026'), '日记/2026');
  assert.equal(createHint('日记'), '放在 日记。只填名字，路径由选中的文件夹决定。');
  assert.equal(createHint(''), '放在 仓库根目录。只填名字，路径由选中的文件夹决定。');
  assert.equal(renameHint('a/b'), '只改名字，还放在 a/b。');
  assert.equal(renameWarn('旧.md'), TEXT.renameWarnTpl.replace('{文件名}', '旧.md'));
  assert.equal(createdToast('新.md'), '已新建 新.md');
});

test('落点只读「选中的文件夹」：selected 档按选中目录，没选中落仓库根', () => {
  assert.equal(resolveCreateDir('日记/2026', { mode: 'selected', dir: '' }), '日记/2026');
  assert.equal(resolveCreateDir('', { mode: 'selected', dir: '' }), '');
  assert.equal(resolveCreateDir('', undefined), '');
});

test('落点：设置「指定目录」档按 getNewNoteTarget() 的 dir，与选中目录无关', () => {
  assert.equal(resolveCreateDir('日记/2026', { mode: 'fixed', dir: '收集箱' }), '收集箱');
  assert.equal(resolveCreateDir('', { mode: 'fixed', dir: '收集箱' }), '收集箱');
});

test('落点：函数签名不接收「打开的那篇」，从设计上杜绝拼出 某篇.md/新笔记.md', () => {
  // resolveCreateDir.length === 2：只有 (selectedFolder, target)，没有第三个 openedPath 形参
  assert.equal(resolveCreateDir.length, 2);
  // 即便硬塞第三个参数，也不会被读用
  assert.equal(resolveCreateDir('', { mode: 'selected', dir: '' }, '某篇.md'), '');
});

test('行入口规则：文件夹行不响应长按、没有改名/移动/删除；笔记行才出三个动作', () => {
  assert.deepEqual(opsForRow({ type: 'dir', name: '日记' }), []);
  assert.deepEqual(opsForRow({ type: 'folder', name: '日记' }), []);
  assert.deepEqual(opsForRow({ isDir: true, name: '日记' }), []);
  assert.deepEqual(opsForRow(null), []);
  assert.deepEqual(opsForRow({ type: 'file', name: 'a.md' }), ['rename', 'move', 'delete']);
  assert.deepEqual(opsForRow({ type: 'note', name: 'a.md' }), ['rename', 'move', 'delete']);
});

test('三档失败互不冒充：目录不在了 / 还没问到 / 连不上（断网不许说找不到）', () => {
  // 明确 404 → 指定的目录不在了
  const gone = classifyDirCheck(Object.assign(new Error('Not Found'), { status: 404, notFound: true }));
  assert.equal(gone.kind, 'gone');
  assert.equal(gone.text, '指定的目录不在了');

  // 名单未到 / 请求还没回来 → 还没问到
  const unknown = classifyDirCheck(Object.assign(new Error('pending'), { pending: true }));
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.text, '还没问到');

  // 断网 / fetch 失败 → 连不上
  const offline = classifyDirCheck(new TypeError('Failed to fetch'));
  assert.equal(offline.kind, 'offline');
  assert.equal(offline.text, '连不上');
  assert.ok(!offline.text.includes('找不到'), '断网不许说「找不到」');
  assert.ok(!offline.text.includes('不在了'), '断网不许冒充「指定的目录不在了」');
});

test('核对成功：拿到目录名单就是 ok，不带失败文案', () => {
  const ok = classifyDirCheck(null, [{ name: 'a.md' }]);
  assert.equal(ok.kind, 'ok');
  assert.deepEqual(ok.entries, [{ name: 'a.md' }]);
  assert.equal(ok.text, undefined);
  // 既没报错也没给名单 → 还没问到，不假装成功
  assert.equal(classifyDirCheck(null, undefined).kind, 'unknown');
});

// ---------------------------------------------------------------------------
// 切片 2：弹窗模型（新建 / 移动同形态、目录就在弹窗里改）、常驻浮层骨架、
// 树行入口判定、打开弹窗那一刻的核对事件。DOM 接线 / 命中区 / 真输入法留真浏览器。
// ---------------------------------------------------------------------------

test('新建弹窗模型：两块（名字 + 已填目录），落点只读选中的文件夹，文案逐字', () => {
  const m = createDialogModel({ selectedFolder: '日记/2026' });
  assert.equal(m.action, 'create');
  assert.equal(m.type, 'prompt');
  assert.equal(m.title, '新建笔记');
  assert.equal(m.hint, '放在 日记/2026。只填名字，路径由选中的文件夹决定。');
  assert.equal(m.showDir, true);
  assert.equal(m.dir, '日记/2026');
  assert.equal(m.value, '');
});

test('新建弹窗：没选中文件夹 → 落仓库根，提示仍逐字带「选中的文件夹」', () => {
  const m = createDialogModel({ selectedFolder: '' });
  assert.equal(m.dir, '');
  assert.equal(m.hint, '放在 仓库根目录。只填名字，路径由选中的文件夹决定。');
});

test('新建落点：selected 档按选中文件夹、fixed 档按指定目录，与「打开的那篇」无关', () => {
  assert.equal(createDialogModel({
    selectedFolder: '日记', target: { mode: 'selected', dir: '' },
  }).dir, '日记');
  assert.equal(createDialogModel({
    selectedFolder: '日记', target: { mode: 'fixed', dir: '收集箱' },
  }).dir, '收集箱');
  assert.equal(createDialogModel({}).dir, '');
  // 硬塞 openedPath 也不读它 —— 从形状上杜绝 某篇.md/新笔记.md
  assert.equal(createDialogModel({ selectedFolder: '日记', openedPath: '某篇.md' }).dir, '日记');
});

test('移动弹窗与新建弹窗同一形态：名字 + 已填目录；标题复用附录 C 已定字面、不新造', () => {
  const m = moveDialogModel({ path: '日记/2026/a.md' });
  assert.equal(m.action, 'move');
  assert.equal(m.type, 'prompt');
  assert.equal(m.showDir, true);   // 与新建同形态：目录也在弹窗里改
  assert.equal(m.dir, '日记/2026');
  assert.equal(m.value, 'a');
  assert.equal(m.title, '移动到…');  // TEXT.pickerTitle，逐字
  assert.equal(m.hint, '');          // 不新造附录 C 之外的文案
});

test('重命名弹窗：只改名字、还放在原目录，警告逐字，不露目录块', () => {
  const m = renameDialogModel({ path: '日记/a.md' });
  assert.equal(m.action, 'rename');
  assert.equal(m.showDir, false);   // 提示说「还放在」，不改目录
  assert.equal(m.dir, '日记');
  assert.equal(m.hint, '只改名字，还放在 日记。');
  assert.equal(m.value, 'a');
  assert.equal(
    m.warn,
    '别的笔记里指向「a.md」的链接会断——本端只认得文件名，读不到别的笔记的正文，改不了那些链接，也报不出断了几条。',
  );
});

test('删除确认弹窗：标题与正文逐字（**撤销** 转加粗，界面不显示星号）', () => {
  const m = deleteDialogModel({ path: '日记/a.md' });
  assert.equal(m.action, 'delete');
  assert.equal(m.type, 'confirm');
  assert.equal(m.title, '删除「a.md」？');
  assert.ok(m.body.includes('<b>撤销</b>'));
  assert.ok(!m.body.includes('**'), '界面不显示 markdown 星号');
  assert.equal(m.danger, true);
});

test('renderEmphasis：只把 **…** 转成 <b>，其余原样并转义 HTML', () => {
  assert.equal(renderEmphasis('会给一次**撤销**'), '会给一次<b>撤销</b>');
  assert.equal(renderEmphasis('a < b'), 'a &lt; b');
  assert.equal(renderEmphasis(' plain '), ' plain ');
});

test('dialogView：新建/移动露目录块与输入框、重命名不露目录、删除走 confirmDialog + danger', () => {
  const c = dialogView(createDialogModel({ selectedFolder: '日记' }));
  assert.equal(c.show, true);
  assert.equal(c.showDir, true);
  assert.equal(c.showInput, true);
  assert.equal(c.okAct, 'submitDialog');
  assert.equal(c.dirLabel, '日记');

  const mv = dialogView(moveDialogModel({ path: 'x/a.md' }));
  assert.equal(mv.showDir, true);
  assert.equal(mv.showInput, true);
  assert.equal(mv.okAct, 'submitDialog');

  const rn = dialogView(renameDialogModel({ path: 'x/a.md' }));
  assert.equal(rn.showDir, false);
  assert.equal(rn.showWarn, true);
  assert.equal(rn.showInput, true);

  const dl = dialogView(deleteDialogModel({ path: 'x/a.md' }));
  assert.equal(dl.showBody, true);
  assert.equal(dl.showInput, false);
  assert.equal(dl.okAct, 'confirmDialog');
  assert.equal(dl.okClass, 'danger');

  assert.equal(dialogView(null).show, false);
});

test('fileOpsLayerHtml：名字输入框整层只有一个且常驻，目录块可点，操作表/选择器各有宿主', () => {
  const html = fileOpsLayerHtml();
  assert.equal((html.match(/id="dlg-input"/g) || []).length, 1, '#dlg-input 只建一次，重画不换节点');
  assert.ok(html.includes('id="fo-modal"'));
  assert.ok(html.includes('data-act="pickDir"'), '目录就在弹窗里改，不另设二级入口');
  assert.ok(html.includes('data-act="closeDialog"'));
  assert.ok(html.includes('id="fo-ops-host"'));
  assert.ok(html.includes('id="fo-picker-host"'));
  assert.ok(html.includes('id="fo-modal-scroll"'), '内容超出时内部滚动、标题与主动作不滚走');
});

test('弹窗骨架：标题与主动作在滚动区之外，内容超出只滚中间（判据10）', () => {
  const html = fileOpsLayerHtml();
  const scrollAt = html.indexOf('id="fo-modal-scroll"');
  assert.ok(scrollAt > 0);
  assert.ok(html.indexOf('id="fo-title"') < scrollAt, '标题在滚动区之前，不滚走');
  assert.ok(html.indexOf('fo-modal-btns') > scrollAt, '主动作在滚动区之后，不滚走');
});

test('树行入口判定：文件夹行没有写操作、笔记行才有；长按只在窄屏笔记行起', () => {
  assert.equal(rowHasOps({ type: 'dir', name: '日记' }), false);
  assert.equal(rowHasOps({ type: 'note', name: 'a.md' }), true);
  assert.equal(shouldStartLongPress({ isNoteRow: true, wide: false }), true);
  assert.equal(shouldStartLongPress({ isNoteRow: true, wide: true }), false);   // 宽屏走悬停
  assert.equal(shouldStartLongPress({ isNoteRow: false, wide: false }), false); // 长按文件夹行无反应
});

test('打开新建弹窗那一刻的核对事件：事件名与 detail 按 #63 约定', () => {
  assert.equal(NEW_TARGET_CHECK_EVENT, 'ui:new-note-target-check');
  assert.deepEqual(newNoteTargetCheckDetail({ mode: 'fixed', dir: '收集箱' }),
    { target: { mode: 'fixed', dir: '收集箱' } });
  assert.deepEqual(newNoteTargetCheckDetail(undefined), { target: { mode: 'selected', dir: '' } });
});

test('撞名：拒绝文案逐字，模型不带「自动加后缀 / 二次确认」字段', () => {
  const m = createDialogModel({ selectedFolder: '' });
  m.error = TEXT.duplicate;
  assert.equal(m.error, '这个名字已经有了');
  assert.equal(m.autoSuffix, undefined);
  assert.equal(m.confirmAgain, undefined);
});

// ---------------------------------------------------------------------------
// 切片 2b：操作表 / 目录选择器的骨架（逐字文案 + 44 命中 + 内联 SVG 图标）
// 它们没有输入框，内容可随状态重建；新建弹窗那个输入框仍只在常驻层里建一次。
// ---------------------------------------------------------------------------

test('操作表：三个动作 + 取消 + 遮罩；非编辑态不置灰、不给锁提示', () => {
  const html = opsSheetHtml({ name: '日记.md' });
  assert.ok(html.includes('data-op="rename"'));
  assert.ok(html.includes('data-op="move"'));
  assert.ok(html.includes('data-op="delete"'));
  assert.ok(html.includes('data-act="closeOps"'));
  assert.ok(html.includes('sheet-mask'));
  assert.ok(html.includes('日记.md'));
  assert.ok(!html.includes('is-disabled'));
  assert.ok(!html.includes('op-hint'));
});

test('操作表：编辑态三动作置灰但仍能按，锁提示逐字、不靠 disabled', () => {
  const html = opsSheetHtml({ name: 'a.md', locked: true });
  assert.equal((html.match(/is-disabled/g) || []).length, 3, '三个动作都置灰');
  assert.ok(html.includes('先保存或取消，再改文件'), '逐字锁提示');
  assert.ok(!html.includes(' disabled'), '置灰不靠 disabled 属性，仍能按、按了给提示');
  assert.ok(html.includes('class="op-hint"'));
});

test('操作表：名字转义，防 XSS', () => {
  const html = opsSheetHtml({ name: '<img src=x>' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('目录选择器：标题/上一级/放这里/就放这里 逐字，图标内联 SVG，只列目录', () => {
  const html = pickerHtml({
    dir: '日记',
    entries: [
      { type: 'dir', name: '2026', path: '日记/2026' },
      { type: 'note', name: 'a.md', path: '日记/a.md' },
    ],
  });
  assert.ok(html.includes('移动到…'));
  assert.ok(html.includes('上一级'));
  assert.ok(html.includes('放这里：日记'));
  assert.ok(html.includes('就放这里'));
  assert.ok(html.includes('data-enter="日记/2026"'));
  assert.ok(!html.includes('data-enter="日记/a.md"'), '笔记行不进目录选择器');
  assert.ok(html.includes('<svg'), '图标全内联 SVG，不用字符/emoji');
  assert.ok(!html.includes('（没有子目录）'), '有子目录时不显示空提示');
});

test('目录选择器：根写「仓库根目录」、无子目录显示（没有子目录）、无上一级', () => {
  const root = pickerHtml({ dir: '', entries: [] });
  assert.ok(root.includes('（没有子目录）'));
  assert.ok(root.includes('放这里：仓库根目录'));
  assert.ok(!root.includes('上一级'), '根目录没有上一级');
});

test('目录选择器：忙时禁用「就放这里」并说加载中，不谎称没子目录；错误逐字显示', () => {
  const busy = pickerHtml({ dir: 'x', entries: [], busy: true });
  assert.ok(busy.includes('加载中…'));
  assert.ok(busy.includes('is-disabled'));
  assert.ok(!busy.includes('（没有子目录）'), '还在读时不冒充空目录');

  const err = pickerHtml({ dir: 'x', entries: [], error: '目录没读到：连不上' });
  assert.ok(err.includes('目录没读到：连不上'));
});

test('foldersOf：只留目录，笔记与其它类型都不进选择器', () => {
  assert.deepEqual(
    foldersOf([{ type: 'dir', path: 'a' }, { type: 'note', path: 'b' }, { type: 'dir', path: 'c' }]),
    [{ type: 'dir', path: 'a' }, { type: 'dir', path: 'c' }],
  );
  assert.deepEqual(foldersOf(null), []);
});

test('长按阈值：正数常量，供窄屏长按接线用（真手势留真机）', () => {
  assert.ok(LONG_PRESS_MS > 0);
});
