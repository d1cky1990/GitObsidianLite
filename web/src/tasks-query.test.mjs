// `web/src/tasks-query.js` 的规则测试。
// #28 验收判据：查询块渲染成一句说明、可展开看原文；不执行、不报错、不显示成代码块；
// 其他语言的代码块不受牵连。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import MarkdownIt from 'markdown-it';

import { installTasksQueryRule, QUERY_NOTE } from './tasks-query.js';

function render(content) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installTasksQueryRule(md);
  return md.render(content);
}

test('查询块：渲染成说明 + 可展开原文，不是代码块', () => {
  const html = render('```tasks\nnot done\nsort by due\n```\n');
  assert.match(html, /<details class="tasks-query">/);
  assert.match(html, /<summary>这是 Obsidian 的任务查询，手机端不执行<\/summary>/);
  // 原文能展开看到，且被转义后包在 pre/code 里
  assert.match(html, /<pre><code>not done\nsort by due\n<\/code><\/pre>/);
  // 不显示成代码块（markdown-it 的代码块会带语言 class）
  assert.doesNotMatch(html, /class="language-tasks"/);
  assert.doesNotMatch(html, /<pre><code class=/);
});

test('查询块：说明文案只有一处定义', () => {
  assert.match(render('```tasks\nx\n```\n'), new RegExp(QUERY_NOTE));
});

test('查询块：信息串带设置、大小写不同都认', () => {
  assert.match(render('```tasks\nx\n```\n'), /tasks-query/);
  assert.match(render('```Tasks\nx\n```\n'), /tasks-query/);
  assert.match(render('```tasks extra-setting\nx\n```\n'), /tasks-query/);
});

test('查询块：原文里的尖括号被转义，不会变成标签', () => {
  const html = render('```tasks\nWHERE text includes <script>\n```\n');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('其他语言的代码块一点不受影响', () => {
  const js = render('```js\nconst a = 1;\n```\n');
  assert.doesNotMatch(js, /tasks-query/);
  assert.match(js, /class="language-js"/);
  assert.match(js, /const a = 1;/);
  // 不带语言串的普通代码块照旧
  const plain = render('```\nhello\n```\n');
  assert.doesNotMatch(plain, /tasks-query/);
  assert.match(plain, /<pre><code>hello\n<\/code><\/pre>/);
});

test('行内代码里的 tasks 不受影响', () => {
  const html = render('写法是 `tasks` 这样\n');
  assert.doesNotMatch(html, /tasks-query/);
  assert.match(html, /<code>tasks<\/code>/);
});

test('多个查询块各自成块', () => {
  const html = render('```tasks\nA\n```\n\n```tasks\nB\n```\n');
  assert.equal((html.match(/<details class="tasks-query">/g) || []).length, 2);
});
