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

/* ---------- 四态与认不得的状态（#28） ---------- */

test('渲染：四态与认不得的状态都画成方框，字符原样显示', () => {
  const html = render('- [ ] 待办\n- [x] 已办\n- [/] 进行中\n- [-] 取消\n- [?] 认不得\n');
  assert.equal(countBoxes(html), 5);
  assert.match(html, /data-state=" "/);
  assert.match(html, /data-state="x"/);
  assert.match(html, /data-state="\/"/);
  assert.match(html, /data-state="-"/);
  // 认不得的照旧画方框、字符原样显示——不退化成「[?] 认不得」一串文字
  assert.match(html, /data-state="\?"[^>]*>\?<\/button>/);
  assert.match(html, />\/<\/button>/);
  assert.match(html, />-<\/button>/);
  // 只有 [x] 带 is-done
  assert.equal((html.match(/is-done/g) || []).length, 1);
  // 方框里不该再出现方括号
  assert.doesNotMatch(html, /\[[ x/?-]\]/);
});

test('渲染：续行与正文里的方括号仍不算任务', () => {
  assert.equal(countBoxes(render('- [ ] 第一行\n  [?] 续行不是任务\n')), 1);
  assert.equal(countBoxes(render('正文 [?] 夹在中间\n')), 0);
});

/* ---------- 勾选顺带处理完成日期（#28） ---------- */

const TODAY = '2026-10-01';

test('切换：勾上带 Tasks 记号的行 → 行尾补 ✅ 当天；纯清单行不补', () => {
  assert.equal(
    toggleTaskLine('- [ ] 写周报 ⏳ 2026-01-26', TODAY),
    '- [x] 写周报 ⏳ 2026-01-26 ✅ 2026-10-01',
  );
  assert.equal(toggleTaskLine('- [ ] 买牛奶', TODAY), '- [x] 买牛奶', '纯清单行不该被加日期');
  assert.equal(toggleTaskLine('  - [ ] 买牛奶 #工作', TODAY), '  - [x] 买牛奶 #工作', '标签不是 Tasks 记号');
});

test('切换：取消勾选 → 摘掉 ✅，行内其他记号一个不碰', () => {
  assert.equal(
    toggleTaskLine('- [x] 写周报 ⏳ 2026-01-26 ✅ 2026-01-27', TODAY),
    '- [ ] 写周报 ⏳ 2026-01-26',
  );
});

test('切换：进行中 / 已取消 / 认不得的状态被点 → 往「完成」走', () => {
  assert.equal(
    toggleTaskLine('- [/] 写周报 ⏳ 2026-01-26', TODAY),
    '- [x] 写周报 ⏳ 2026-01-26 ✅ 2026-10-01',
  );
  // 已取消：补 ✅ 的同时摘掉 ❌——不能又取消又完成
  assert.equal(
    toggleTaskLine('- [-] 不做了 ⏳ 2026-01-26 ❌ 2026-01-27', TODAY),
    '- [x] 不做了 ⏳ 2026-01-26 ✅ 2026-10-01',
  );
  // 记号**只有 ❌** 的行：❌ 自己就是记号，摘掉它之后仍应算「带记号」而补上 ✅。
  // 判「带不带记号」必须先于摘 ❌，否则这行会静默丢掉 ✅。
  assert.equal(
    toggleTaskLine('- [-] 退掉旧订阅 ❌ 2026-01-27', TODAY),
    '- [x] 退掉旧订阅 ✅ 2026-10-01',
  );
  assert.equal(
    toggleTaskLine('- [?] 什么 ⏳ 2026-01-26', TODAY),
    '- [x] 什么 ⏳ 2026-01-26 ✅ 2026-10-01',
  );
  // 反过来：已勾的点一下回到未勾，不是「再完成一次」
  assert.equal(toggleTaskLine('- [x] 什么 ⏳ 2026-01-26', TODAY), '- [ ] 什么 ⏳ 2026-01-26');
});

test('切换：同一行已有 ✅ 再勾一次——只有一个 ✅，日期改成当天', () => {
  const line = '- [ ] 写周报 ⏳ 2026-01-26 ✅ 2026-01-27';
  const once = toggleTaskLine(line, TODAY);
  assert.equal(once, '- [x] 写周报 ⏳ 2026-01-26 ✅ 2026-10-01');
  assert.equal((once.match(/✅/g) || []).length, 1, '不能连写两个 ✅');
});

test('切换：行尾带空格时，✅ 补在空格之前', () => {
  assert.equal(
    toggleTaskLine('- [ ] 买冲锋裤 🛫 2026-09-29 ', TODAY),
    '- [x] 买冲锋裤 🛫 2026-09-29 ✅ 2026-10-01 ',
  );
});

test('整篇切换：带日期的行，行号仍对得上且行数不变', () => {
  const content = `# 今日\n\n- [ ] 甲 ⏳ 2026-01-26\n- [x] 乙 ✅ 2026-01-27\n- [ ] 丙\n`;
  const once = toggleTaskInContent(content, 2, TODAY);
  assert.equal(once, `# 今日\n\n- [x] 甲 ⏳ 2026-01-26 ✅ 2026-10-01\n- [x] 乙 ✅ 2026-01-27\n- [ ] 丙\n`);
  assert.equal(once.split('\n').length, content.split('\n').length, '不能增删行——否则排队中的行号会漂');
  const twice = toggleTaskInContent(content, 3, TODAY);
  assert.equal(twice, `# 今日\n\n- [ ] 甲 ⏳ 2026-01-26\n- [ ] 乙\n- [ ] 丙\n`);
});

test('isTaskDoneLine：只认 x / X，进行中与取消都不算已完成', () => {
  assert.equal(isTaskDoneLine('- [x] 已办'), true);
  assert.equal(isTaskDoneLine('- [X] 已办'), true);
  assert.equal(isTaskDoneLine('- [ ] 待办'), false);
  assert.equal(isTaskDoneLine('- [/] 进行中'), false);
  assert.equal(isTaskDoneLine('- [-] 取消'), false);
  assert.equal(isTaskDoneLine('- 普通'), false);
});
