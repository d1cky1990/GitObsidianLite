// `web/src/tasks.js` 的规则测试。
// 盯的是 #27 验收判据里点名的那几条：什么算任务（只认列表项开头）、方框落在哪一行、
// 切换只动那一行的标记、嵌套子任务每层都算。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import MarkdownIt from 'markdown-it';

import { toggleTaskLine, toggleTaskInContent, isTaskDoneLine, installTaskRule } from './tasks.js';

// 用真实渲染器整体跑一遍再数结果，不另写复刻规则的复算脚本
function render(content) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installTaskRule(md);
  return md.render(content);
}

const countBoxes = (html) => (html.match(/class="task-box/g) || []).length;

test('切换：[ ] ↔ [x]，大写 [X] 也算已勾', () => {
  assert.equal(toggleTaskLine('- [ ] 买牛奶'), '- [x] 买牛奶');
  assert.equal(toggleTaskLine('- [x] 买牛奶'), '- [ ] 买牛奶');
  assert.equal(toggleTaskLine('- [X] 买牛奶'), '- [ ] 买牛奶');
});

test('切换：缩进、星号、编号列表都认', () => {
  assert.equal(toggleTaskLine('  * [ ] 子任务'), '  * [x] 子任务');
  assert.equal(toggleTaskLine('1. [ ] 编号项'), '1. [x] 编号项');
  assert.equal(toggleTaskLine('\t+ [x] 已办'), '\t+ [ ] 已办');
});

test('切换：不是任务项行的一律不动', () => {
  for (const line of ['- 普通列表项', '[ ] 没有列表符号的不算', '正文 [ ] 夹在中间', '', '```', '- []没空格不算']) {
    assert.equal(toggleTaskLine(line), null, JSON.stringify(line) + ' 该返回 null');
  }
});

test('整篇切换：行号对得上，越界与非任务行返回 null', () => {
  const content = '# 标题\n\n- [ ] 第一件\n- [x] 第二件\n普通段落\n';
  assert.equal(toggleTaskInContent(content, 2), '# 标题\n\n- [x] 第一件\n- [x] 第二件\n普通段落\n');
  assert.equal(toggleTaskInContent(content, 3), '# 标题\n\n- [ ] 第一件\n- [ ] 第二件\n普通段落\n');
  assert.equal(toggleTaskInContent(content, 4), null); // 普通段落，不是任务行
  assert.equal(toggleTaskInContent(content, 99), null); // 越界
  assert.equal(toggleTaskInContent(content, -1), null);
});

test('isTaskDoneLine：给提交信息选词用', () => {
  assert.equal(isTaskDoneLine('- [x] 已办'), true);
  assert.equal(isTaskDoneLine('- [X] 已办'), true);
  assert.equal(isTaskDoneLine('- [ ] 待办'), false);
  assert.equal(isTaskDoneLine('- 普通'), false);
});

test('渲染：列表项开头渲染成方框，行号落在源文行上', () => {
  const html = render('- [ ] 买牛奶\n- [x] 已办的事\n');
  assert.equal(countBoxes(html), 2);
  assert.match(html, /data-task-line="0"/);
  assert.match(html, /data-task-line="1"/);
  // 已勾项的方框带 is-done，所在 li 带 task-done；未勾项都不带
  assert.match(html, /class="task-box is-done"/);
  assert.match(html, /class="task-item task-done"/);
  assert.match(html, /class="task-item"/);
  // 前缀被剥掉，不留在文字里
  assert.doesNotMatch(html, /\[ \]|\[x\]/);
});

test('渲染：只有列表项开头才算任务', () => {
  // 普通段落里方括号原样是文字
  const para = render('今天的事 [ ] 没写列表符号\n');
  assert.equal(countBoxes(para), 0);
  assert.match(para, /\[ \]/);
  // 列表项续行里只有第一个算任务
  const cont = render('- [ ] 第一行\n  续行 [ ] 不是任务\n');
  assert.equal(countBoxes(cont), 1);
  // 引用块里的列表仍是列表项（GitHub/Obsidian 同样行为）
  const quote = render('> - [ ] 引用里的待办\n');
  assert.equal(countBoxes(quote), 1);
});

test('渲染：嵌套子任务每层都可点，行号互不串', () => {
  const html = render('- [ ] 父任务\n    - [x] 子任务\n        - [ ] 孙任务\n');
  assert.equal(countBoxes(html), 3);
  for (const line of ['0', '1', '2']) assert.match(html, new RegExp('data-task-line="' + line + '"'));
});

test('渲染：切换行号与切换函数闭环——渲染报的行号，切换函数认得', () => {
  const content = '# 今日\n\n- [ ] 买牛奶\n- [x] 寄快递\n';
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installTaskRule(md);
  const html = md.render(content);
  // 从渲染结果里取出全部行号，逐个切换一遍都必须成功
  const lines = [...html.matchAll(/data-task-line="(\d+)"/g)].map((m) => +m[1]);
  assert.equal(lines.length, 2);
  let draft = content;
  for (const line of lines) {
    draft = toggleTaskInContent(draft, line);
    assert.notEqual(draft, null, '行 ' + line + ' 应能切换');
  }
  assert.equal(draft, '# 今日\n\n- [x] 买牛奶\n- [ ] 寄快递\n');
});
