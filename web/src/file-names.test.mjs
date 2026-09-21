// `web/src/file-names.js` 的规则测试。
// 盯的是 #26 验收判据里点名的那几条：只填名字（拒路径）、不带后缀补 `.md`、
// 重名怎么判、四种提交信息的措辞。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dirOf, baseOf, joinPath, normalizeNewName, hasName, renameTarget, moveTarget, stemOf,
  commitMessage,
} from './file-names.js';

test('路径拆装：根目录不该拼出开头带斜杠的路径', () => {
  assert.equal(dirOf('a/b/c.md'), 'a/b');
  assert.equal(dirOf('c.md'), '');
  assert.equal(baseOf('a/b/c.md'), 'c.md');
  assert.equal(baseOf('c.md'), 'c.md');
  assert.equal(joinPath('', 'c.md'), 'c.md');
  assert.equal(joinPath('a/b', 'c.md'), 'a/b/c.md');
  assert.equal(joinPath(dirOf('a/b/c.md'), baseOf('a/b/c.md')), 'a/b/c.md');
});

test('新建：只填名字，没有后缀补 .md', () => {
  assert.deepEqual(normalizeNewName('会议记录'), { ok: true, name: '会议记录.md' });
  assert.deepEqual(normalizeNewName('  会议记录  '), { ok: true, name: '会议记录.md' });
  // 已经有后缀的原样留着——把 foo.png 改成 foo.png.md 是帮倒忙
  assert.deepEqual(normalizeNewName('截图.png'), { ok: true, name: '截图.png' });
  assert.deepEqual(normalizeNewName('a.b.md'), { ok: true, name: 'a.b.md' });
  // 尾巴上带点的按「没写后缀」算
  assert.deepEqual(normalizeNewName('笔记.'), { ok: true, name: '笔记.md' });
});

test('新建：名字里带路径一律拒掉，不自作聪明当目录用', () => {
  for (const bad of ['a/b', 'a\\b', '目录/笔记.md']) {
    const r = normalizeNewName(bad);
    assert.equal(r.ok, false, `${bad} 该被拒`);
    assert.match(r.error, /名字/);
  }
});

test('新建：空名字与 . / .. 都拒绝', () => {
  for (const bad of ['', '   ', '.', '..']) {
    assert.equal(normalizeNewName(bad).ok, false, `${JSON.stringify(bad)} 该被拒`);
  }
});

test('重名判定：大小写不敏感，且改自己时不该被自己拦下', () => {
  const entries = [
    { path: 'a/Foo.md', name: 'Foo.md', type: 'file' },
    { path: 'a/bar.png', name: 'bar.png', type: 'file' },
    { path: 'a/sub', name: 'sub', type: 'dir' },
  ];
  assert.equal(hasName(entries, 'bar.png'), true);
  assert.equal(hasName(entries, 'BAR.PNG'), true);
  assert.equal(hasName(entries, 'foo.md'), true);
  assert.equal(hasName(entries, 'sub'), true);
  assert.equal(hasName(entries, '没有的.md'), false);
  // 重命名 `Foo.md → foo.md`（只改大小写）不该被自己拦下
  assert.equal(hasName(entries, 'foo.md', { except: 'a/Foo.md' }), false);
  // 但换成别的已有名字仍要拦
  assert.equal(hasName(entries, 'bar.png', { except: 'a/Foo.md' }), true);
});

test('目标路径：重命名留在原目录，移动只换目录', () => {
  assert.equal(renameTarget('a/b/旧.md', '新.md'), 'a/b/新.md');
  assert.equal(renameTarget('旧.md', '新.md'), '新.md');
  assert.equal(moveTarget('a/b/笔记.md', 'c/d'), 'c/d/笔记.md');
  assert.equal(moveTarget('a/b/笔记.md', ''), '笔记.md');
});

test('重命名弹窗预填：.md 去掉后缀，别的原样', () => {
  assert.equal(stemOf('a/b/会议记录.md'), '会议记录');
  assert.equal(stemOf('会议记录.MD'), '会议记录');
  assert.equal(stemOf('a/截图.png'), '截图.png');
});

test('提交信息：四种动词分得开，都带路径', () => {
  const all = [
    commitMessage.create('a/新.md'),
    commitMessage.remove('a/旧.md'),
    commitMessage.rename('a/旧.md', 'a/新.md'),
    commitMessage.move('a/旧.md', 'b/旧.md'),
  ];
  for (const m of all) {
    assert.match(m, /^手机端：/, `${m} 少了前缀`);
  }
  assert.equal(new Set(all).size, 4, '四种提交信息不该有重复');
  assert.equal(commitMessage.create('a/新.md'), '手机端：新建 a/新.md');
  assert.equal(commitMessage.remove('a/旧.md'), '手机端：删除 a/旧.md');
  assert.equal(commitMessage.rename('a/旧.md', 'a/新.md'), '手机端：重命名 a/旧.md → a/新.md');
  assert.equal(commitMessage.move('a/旧.md', 'b/旧.md'), '手机端：移动 a/旧.md → b/旧.md');
});

test('提交信息：既有文案（编辑 / 合并冲突 / 另存副本）套同一个前缀', () => {
  assert.equal(commitMessage.edit('a/n.md'), '手机端：编辑 a/n.md');
  assert.equal(commitMessage.merge('a/n.md'), '手机端：合并冲突 a/n.md');
  assert.match(commitMessage.keepLocal('a/n.md'), /^手机端：合并冲突 a\/n\.md/);
  assert.equal(commitMessage.copySheet('a/n.conflict.md'), '手机端：另存副本 a/n.conflict.md');
  // 撤销删除仍是「新建」这个动词
  assert.match(commitMessage.undoDelete('a/n.md'), /^手机端：新建 a\/n\.md/);
});
