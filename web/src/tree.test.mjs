// tree.js 的占位契约测试。
//
// #61 只负责把「其余五张票要 import 的接口」先立住，真正的树由 #62 填充。
// 这里钉的是接口形状与「可运行」：导出齐、返回默认值、调用不抛。
// 断言不钉具体实现，#62 换掉内部时这些测试不该被迫改。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTree, sortEntries, refreshTree, getSelectedFolder, setSelectedFolder, selectPath,
} from './tree.js';

test('契约：六个导出都是函数', () => {
  for (const fn of [buildTree, sortEntries, refreshTree, getSelectedFolder, setSelectedFolder, selectPath]) {
    assert.equal(typeof fn, 'function');
  }
});

test('占位可运行：buildTree / sortEntries 返回数组，调用不抛', () => {
  assert.ok(Array.isArray(buildTree(['a/b.md', 'c.md'])));
  const entries = [{ name: 'x', type: 'dir' }, { name: 'y', type: 'note' }];
  const sorted = sortEntries(entries);
  assert.ok(Array.isArray(sorted));
  assert.equal(sorted.length, entries.length);
});

test('占位可运行：选中的文件夹默认仓库根，set/get 成对', () => {
  assert.equal(getSelectedFolder(), '');
  setSelectedFolder('日记/2026');
  assert.equal(getSelectedFolder(), '日记/2026');
  setSelectedFolder(''); // 复位，别把状态漏给别的测试
});

test('占位可运行：refreshTree / selectPath 不抛', () => {
  assert.doesNotThrow(() => refreshTree());
  assert.doesNotThrow(() => selectPath('a/b.md'));
});
