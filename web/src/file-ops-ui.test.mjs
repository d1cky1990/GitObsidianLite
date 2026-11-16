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
