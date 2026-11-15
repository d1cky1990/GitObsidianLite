// editor-guard.js 的占位契约测试。
//
// #61 只负责把接口立住，未保存保护与编辑态锁由 #65 填充。
// 这里钉的是接口形状与「可运行」：导出齐、返回布尔默认值、调用不抛。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLocked, guardExitEdit } from './editor-guard.js';

test('契约：两个导出都是函数', () => {
  assert.equal(typeof isLocked, 'function');
  assert.equal(typeof guardExitEdit, 'function');
});

test('占位可运行：默认不锁、退出编辑放行，返回布尔且不抛', () => {
  assert.equal(typeof isLocked(), 'boolean');
  assert.equal(isLocked(), false);
  assert.equal(typeof guardExitEdit(), 'boolean');
  assert.equal(guardExitEdit(), true);
});
