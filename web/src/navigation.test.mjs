// navigation.js 的规则测试。
//
// 工单 #61 第 1/5/6/7 条的可单测内核：三个词各有唯一真相、新建落点只读
// 「选中的文件夹」、地址栏只记右边是哪篇、侧栏占位历史压入/吃掉、返回四层、
// 旧链接落地。全是纯逻辑（不碰 DOM），所以能在 node --test 里钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNavState, getSelectedFolder, setSelectedFolder,
  getOpenedPath, setOpenedPath, getEditingPath, setEditingPath,
  createTarget, noteHref, parseHash,
  pushSidebarPlaceholder, popSidebarPlaceholder,
  decideBack, resolveLanding, CLOSE_NOTE_HREF, backDirective,
  indexDirExists, landingProbeFromIndex, isNoteSwitchOnPopstate,
  isSameEditedNote, sidebarCountsAsBackLayer,
} from './navigation.js';

test('三个词各自独立：改一个不串到另两个', () => {
  const s = createNavState();
  assert.equal(getSelectedFolder(s), '');
  assert.equal(getOpenedPath(s), '');
  assert.equal(getEditingPath(s), '');

  setSelectedFolder(s, '日记/2026');
  setOpenedPath(s, '日记/2026/05-14.md');
  setEditingPath(s, '草稿.md');
  assert.equal(getSelectedFolder(s), '日记/2026');
  assert.equal(getOpenedPath(s), '日记/2026/05-14.md');
  assert.equal(getEditingPath(s), '草稿.md');
});

test('新建落点只读「选中的文件夹」，绝不读「打开的那篇」', () => {
  const s = createNavState();
  setOpenedPath(s, '某篇.md');        // 开着一篇笔记
  setSelectedFolder(s, '日记/2026');  // 选中的是某个文件夹
  assert.equal(createTarget(s), '日记/2026');

  // 钉死那个历史 bug：开着笔记新建，不许拼出 `某篇.md/新笔记.md`
  const joined = (createTarget(s) || '') + '/新笔记.md';
  assert.ok(!joined.includes('某篇.md/新笔记.md'));
  assert.ok(!createTarget(s).includes('某篇.md'));

  // 没选中文件夹时落仓库根，也不是当前笔记所在目录
  setSelectedFolder(s, '');
  assert.equal(createTarget(s), '');
});

test('地址栏只记右边是哪篇：noteHref / parseHash', () => {
  assert.equal(noteHref('日记/2026/a.md'), '#/edit/' + encodeURIComponent('日记/2026/a.md'));
  assert.equal(noteHref(''), '#/');

  assert.deepEqual(parseHash('#/edit/' + encodeURIComponent('a/b.md')), { kind: 'note', path: 'a/b.md' });
  assert.deepEqual(parseHash('#/dir/' + encodeURIComponent('日记')), { kind: 'dir', path: '日记' });
  assert.deepEqual(parseHash(''), { kind: 'empty', path: '' });
  assert.deepEqual(parseHash('#/'), { kind: 'empty', path: '' });
});

test('侧栏占位历史：压一条地址栏不变、三种关法各吃掉一条', () => {
  const s = createNavState();
  const entry = pushSidebarPlaceholder(s);
  assert.equal(entry.addressUnchanged, true, '压占位不许改地址栏');
  assert.equal(s.placeholderDepth, 1);
  assert.equal(entry.historyState.sidebarPlaceholder, true);

  assert.equal(popSidebarPlaceholder(s), true, '关一次吃掉一条');
  assert.equal(s.placeholderDepth, 0);
  assert.equal(popSidebarPlaceholder(s), false, '没有占位时不凭空退一步');

  // 连开两次占位、连关两次，深度配平
  pushSidebarPlaceholder(s); pushSidebarPlaceholder(s);
  assert.equal(s.placeholderDepth, 2);
  popSidebarPlaceholder(s); popSidebarPlaceholder(s);
  assert.equal(s.placeholderDepth, 0);
});

test('返回四层：侧栏先收 → 冲突退编辑 → 编辑退出 → 关掉这篇 → 没有可退', () => {
  const s = createNavState();
  setOpenedPath(s, 'a.md');

  s.sidebarOpen = true;
  s.mode = 'read';
  assert.equal(decideBack(s), 'close-sidebar', '阅读态侧栏开着，返回只收侧栏、不动笔记');

  // #74：编辑 / 冲突态里侧栏锁死（窄屏）或常驻（宽屏），不是用户刚拉开的那一层。
  // 照旧先「收侧栏」会把编辑态那一问整个吞掉——宽屏实测：笔记随侧栏一起没了、连问都没问。
  s.mode = 'edit';
  assert.equal(decideBack(s), 'exit-edit', '编辑态侧栏不算一层：得走到「有改动先问」');
  s.mode = 'conflict';
  assert.equal(decideBack(s), 'conflict-to-edit', '冲突态同理');

  assert.equal(sidebarCountsAsBackLayer({ sidebarOpen: true, mode: 'read' }), true);
  assert.equal(sidebarCountsAsBackLayer({ sidebarOpen: true, mode: 'edit' }), false);
  assert.equal(sidebarCountsAsBackLayer({ sidebarOpen: true, mode: 'conflict' }), false);
  assert.equal(sidebarCountsAsBackLayer({ sidebarOpen: false, mode: 'edit' }), false);
  assert.equal(sidebarCountsAsBackLayer({}), false, '没有侧栏开着时永远不算一层');

  s.sidebarOpen = false;
  s.mode = 'conflict';
  assert.equal(decideBack(s), 'conflict-to-edit');

  s.mode = 'edit';
  assert.equal(decideBack(s), 'exit-edit');

  s.mode = 'read';
  assert.equal(decideBack(s), 'close-note');

  setOpenedPath(s, '');
  assert.equal(decideBack(s), 'none');
});

test('链接落地：分享链接落阅读态且侧栏关着', () => {
  const r = resolveLanding({ hash: '#/edit/' + encodeURIComponent('a/b.md'), online: true });
  assert.equal(r.kind, 'note');
  assert.equal(r.path, 'a/b.md');
  assert.equal(r.sidebarOpen, false);
  assert.equal(r.message, '');
});

test('链接落地：旧目录链接逐级上退到还在的那一级，并明说', () => {
  const exists = (p) => p === '日记/2026';
  const r = resolveLanding({ hash: '#/dir/' + encodeURIComponent('日记/2026/05/已删'), exists, online: true });
  assert.equal(r.kind, 'dir');
  assert.equal(r.path, '日记/2026');
  assert.ok(r.message.includes('这个目录不在了，已上退到这里'));
});

test('链接落地：逐级上退最多四层，全不在就回根并仍给那句话', () => {
  const r = resolveLanding({ hash: '#/dir/' + encodeURIComponent('a/b/c/d/e/f'), exists: () => false, online: true });
  assert.equal(r.kind, 'dir');
  assert.equal(r.path, '');
  assert.ok(r.message.includes('这个目录不在了，已上退到这里'));
});

test('链接落地：断网说「连不上」，不许说「找不到」', () => {
  const r = resolveLanding({ hash: '#/dir/' + encodeURIComponent('x/y'), exists: () => false, online: false });
  assert.equal(r.kind, 'offline');
  assert.ok(r.message.includes('连不上'));
  assert.ok(!r.message.includes('找不到'));
  assert.ok(!r.message.includes('没有'));
});

/* ---------- 评审修复第 1 条：返回四层落地 +「不再指向目录」 ---------- */

test('评审修复第1条：返回四层落地指令，close-note 地址栏恒回根、绝不指向所在目录', () => {
  assert.equal(CLOSE_NOTE_HREF, '#/');
  assert.equal(CLOSE_NOTE_HREF, noteHref(''));
  assert.ok(!CLOSE_NOTE_HREF.includes('/dir/'), '不再指向目录');

  const s = createNavState();
  setOpenedPath(s, '日记/2026/a.md');

  s.sidebarOpen = true; s.mode = 'read';
  let d = backDirective(s);
  assert.equal(d.decision, 'close-sidebar', '阅读态侧栏开着先收侧栏（layout 负责）');
  assert.equal(d.href, '');
  assert.equal(d.historyOp, 'none');

  // #74：编辑 / 冲突态里侧栏不算一层（锁死 / 常驻），照旧先收会把那一问吞掉
  s.sidebarOpen = true; s.mode = 'conflict';
  assert.equal(backDirective(s).decision, 'conflict-to-edit');

  s.sidebarOpen = false; s.mode = 'conflict';
  assert.equal(backDirective(s).decision, 'conflict-to-edit');

  s.mode = 'edit';
  assert.equal(backDirective(s).decision, 'exit-edit');

  s.mode = 'read';
  d = backDirective(s);
  assert.equal(d.decision, 'close-note');
  assert.equal(d.href, '#/', '关掉这篇＝地址栏回根');
  assert.ok(!d.href.includes('/dir/'), '不再指向任何 /dir/ 目录');
  assert.ok(!d.href.includes('日记/2026'), '不再指向这篇所在目录（旧规矩作废）');
  assert.equal(d.historyOp, 'replace', '用 replaceState：不 push、不叠加一次 history.back');

  setOpenedPath(s, '');
  d = backDirective(s);
  assert.equal(d.decision, 'none');
  assert.equal(d.historyOp, 'none');
});

/* ---------- 评审修复第 2 条：旧目录链接落地的接线层判定（存在性 / 问不到） ---------- */

test('评审修复第2条：indexDirExists 只用内存全库名单判目录在不在，名单没到＝问不到', () => {
  const paths = ['日记/2026/05-14.md', '日记/2026/05-15.md', 'a.md'];
  assert.equal(indexDirExists(paths, '日记'), true);
  assert.equal(indexDirExists(paths, '日记/2026'), true);
  assert.equal(indexDirExists(paths, '日记/2026/已删'), false, '这一级确实不在');
  assert.equal(indexDirExists(paths, ''), true, '仓库根恒在，不算「不在了」，不谎报上退');
  assert.equal(indexDirExists(paths, '不存在'), false);
  // 名单没到 / 拉不到：返回 undefined＝问不到，调用方按「连不上」处理，绝不谎报上退
  assert.equal(indexDirExists(null, '日记'), undefined);
  assert.equal(indexDirExists(undefined, '日记'), undefined);
  assert.equal(indexDirExists('bad', '日记'), undefined);
});

test('评审修复第2条：landingProbeFromIndex 把「确实不在」与「问不到」分开', () => {
  const probe = landingProbeFromIndex(['日记/2026/a.md']);
  assert.equal(probe.online, true, '名单到手＝能问');
  assert.equal(probe.exists('日记/2026'), true);
  assert.equal(probe.exists('日记/2026/已删'), false);

  const unknown = landingProbeFromIndex(null);
  assert.equal(unknown.online, false, '名单没到＝问不到，不许冒充不在了');
  assert.equal(unknown.exists('日记/2026'), false);
});

test('评审修复第2条：resolveLanding 接上名单判定——不在逐级上退说那句话，问不到说「连不上」', () => {
  const { online, exists } = landingProbeFromIndex(['日记/2026/a.md']);
  const r = resolveLanding({
    hash: '#/dir/' + encodeURIComponent('日记/2026/已删/更深'),
    exists, online,
  });
  assert.equal(r.kind, 'dir');
  assert.equal(r.path, '日记/2026', '逐级上退到还在的那一级');
  assert.ok(r.message.includes('这个目录不在了，已上退到这里'));

  const { online: off, exists: ex2 } = landingProbeFromIndex(null);
  const o = resolveLanding({
    hash: '#/dir/' + encodeURIComponent('日记/2026/已删'),
    exists: ex2, online: off,
  });
  assert.equal(o.kind, 'offline');
  assert.ok(o.message.includes('连不上'), '问不到说连不上');
  assert.ok(!o.message.includes('找不到'), '不许说找不到');
  assert.ok(!o.message.includes('不在了'), '问不到不冒充不在了');
});

/* ---------- #72：站内换了一篇，别当成「用户按了系统返回」 ---------- */

test('#72：阅读态、地址栏指向另一篇 → 这次 popstate 是换篇，不是返回', () => {
  const opened = { openedPath: '笔记/短篇.md', mode: 'read' };

  assert.equal(
    isNoteSwitchOnPopstate(opened, '#/edit/' + encodeURIComponent('笔记/双链指向的那篇.md')),
    true,
    '点正文双链换了一篇：要交给路由打开，不许当返回把当前这篇关掉',
  );
});

test('#72：还是当前这篇 / 回根 / 回目录 → 照旧是返回，别把返回吞掉', () => {
  const opened = { openedPath: '笔记/短篇.md', mode: 'read' };

  // 系统返回退「当前这一条」时地址栏不变，或者变成根 / 旧目录：都得按返回四层走
  assert.equal(isNoteSwitchOnPopstate(opened, '#/edit/' + encodeURIComponent('笔记/短篇.md')), false, '同一篇不是换篇');
  assert.equal(isNoteSwitchOnPopstate(opened, '#/'), false, '回根是返回');
  assert.equal(isNoteSwitchOnPopstate(opened, ''), false, '没 hash 也是回根');
  assert.equal(isNoteSwitchOnPopstate(opened, '#/dir/' + encodeURIComponent('笔记')), false, '旧目录链接不是换篇');

  // 什么都没打开时地址栏冒出一篇：更不是「关掉这篇」，交给路由打开即可
  assert.equal(isNoteSwitchOnPopstate({ openedPath: '', mode: 'read' }, '#/edit/' + encodeURIComponent('a.md')), true);
});

test('#72：编辑 / 冲突态一律不算换篇——那两个态里每一次返回都只退一层（有改动先问）', () => {
  const otherHash = '#/edit/' + encodeURIComponent('笔记/另一篇.md');

  // 读 A → 点双链到 B → 在 B 上编辑 → 按系统返回（地址栏回到 A）：
  // 这不是「换篇」而是「返回」——要先问「放弃改动？」，不许悄悄把草稿丢掉。
  assert.equal(isNoteSwitchOnPopstate({ openedPath: '笔记/另一篇.md', mode: 'edit' }, otherHash), false);
  assert.equal(isNoteSwitchOnPopstate({ openedPath: '笔记/另一篇.md', mode: 'conflict' }, otherHash), false);
});

/* ---------- #74：编辑态按系统返回，先把退掉的那一步拽回来，再问 ---------- */

test('#74：正在编辑的这一篇指回它自己，不算一次新的打开', () => {
  const hash = '#/edit/' + encodeURIComponent('笔记/短篇.md');

  // 历史被拽回来之后，浏览器还会把那次退格排队的 hashchange 派发一次。
  // 地址栏此刻已经是这篇的编辑地址——照常走 openFile 会把编辑器和草稿一起冲掉。
  const editing = { mode: 'edit', editingPath: '笔记/短篇.md' };

  assert.equal(isSameEditedNote(editing, hash), true);
  assert.equal(isSameEditedNote({ ...editing, mode: 'conflict' }, hash), true, '冲突态同样不许被重开');

  // 其余一律不算：别把正常的打开吞掉
  assert.equal(isSameEditedNote({ ...editing, mode: 'read' }, hash), false, '阅读态是正常打开');
  assert.equal(isSameEditedNote({ ...editing, editingPath: '笔记/长篇.md' }, hash), false, '编辑 A 时地址栏指 B：这是要换篇');
  assert.equal(isSameEditedNote(editing, '#/'), false, '回根不是同一篇');
  assert.equal(isSameEditedNote({ ...editing, editingPath: '' }, hash), false, '没有正在编辑的那篇就不算');
});
