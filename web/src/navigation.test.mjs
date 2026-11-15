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
  decideBack, resolveLanding,
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
  s.mode = 'conflict';
  assert.equal(decideBack(s), 'close-sidebar', '侧栏开着，返回只收侧栏、不动笔记');

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
