// `web/src/task-markers.js` 的规则测试。
// 盯的是 #28 验收判据里点名的那几条：六种日期全翻对、优先级五种、重复规则原文照搬、
// 🆔/⛔/🏁、不成形的不翻、只在列表项里翻、日期手术的边角。
//
// 渲染一律用真实 markdown-it 整体跑一遍再断言，不另写复刻逻辑的复算脚本。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import MarkdownIt from 'markdown-it';

import {
  MARKERS, scanMarkers, hasMarker, formatDate, todayString,
  addDoneDate, removeDoneDate, removeCancelDate, installTaskMarkerRule,
} from './task-markers.js';

function render(content) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installTaskMarkerRule(md);
  return md.render(content);
}

// 年份按「今年」拼，跨年那条用去年——这样断言不会因为跨年而失效
const Y = new Date().getFullYear();
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const thisYear = (m, d) => ymd(Y, m, d);
const lastYear = (m, d) => ymd(Y - 1, m, d);
/** 渲染一个列表项，返回里面的标签文案。 */
const tagsOf = (body) => [...render('- ' + body).matchAll(/<span class="task-tag">([^<]*)<\/span>/g)].map((m) => m[1]);

test('记号表：日期六种、优先级五种都齐；映射只有这一份定义', () => {
  for (const ch of ['⏳', '🛫', '📅', '✅', '❌', '➕']) {
    assert.equal(MARKERS[ch].kind, 'date', ch + ' 该是日期类');
  }
  for (const ch of ['🔺', '⏫', '🔼', '🔽', '⏬']) {
    assert.equal(MARKERS[ch].kind, 'priority', ch + ' 该是优先级类');
  }
  assert.equal(MARKERS['⏳'].label, '计划');
  assert.equal(MARKERS['🛫'].label, '开始');
  assert.equal(MARKERS['📅'].label, '截止');
  assert.equal(MARKERS['✅'].label, '完成');
  assert.equal(MARKERS['❌'].label, '取消');
  assert.equal(MARKERS['➕'].label, '创建');
  assert.equal(MARKERS['🔺'].label, '最高');
  assert.equal(MARKERS['⏫'].label, '高');
  assert.equal(MARKERS['🔼'].label, '中');
  assert.equal(MARKERS['🔽'].label, '低');
  assert.equal(MARKERS['⏬'].label, '最低');
});

test('日期：当年省年份，跨年带年份；按本地日期拆，不经过 Date', () => {
  const now = new Date(Y, 5, 15); // 6 月 15 日
  assert.equal(formatDate(String(Y), '09', '29', now), '9-29');
  assert.equal(formatDate(String(Y - 1), '12', '31', now), `${Y - 1}-12-31`);
  // 当年但月日是个位数：不留前导零
  assert.equal(formatDate(String(Y), '01', '05', now), '1-5');
  // 毫厘之差不能翻月：整月整日边界
  assert.equal(formatDate(String(Y), '12', '31', now), '12-31');
});

test('渲染：日期类六种全翻对，表情不再出现', () => {
  assert.deepEqual(tagsOf(`任务 ⏳ ${thisYear(9, 29)}`), ['计划 9-29']);
  assert.deepEqual(tagsOf(`任务 🛫 ${thisYear(9, 29)}`), ['开始 9-29']);
  assert.deepEqual(tagsOf(`任务 📅 ${thisYear(9, 30)}`), ['截止 9-30']);
  assert.deepEqual(tagsOf(`任务 ✅ ${thisYear(1, 24)}`), ['完成 1-24']);
  assert.deepEqual(tagsOf(`任务 ❌ ${thisYear(1, 24)}`), ['取消 1-24']);
  assert.deepEqual(tagsOf(`任务 ➕ ${thisYear(1, 24)}`), ['创建 1-24']);
  // 跨年那条要带年份
  assert.deepEqual(tagsOf(`任务 📅 ${lastYear(12, 31)}`), [`截止 ${Y - 1}-12-31`]);
  // 表情本身不该留在正文里
  assert.doesNotMatch(render(`- 任务 ⏳ ${thisYear(9, 29)}`), /⏳/);
});

test('渲染：优先级五种；无记号时不显示任何标签', () => {
  assert.deepEqual(tagsOf('任务 🔺'), ['最高']);
  assert.deepEqual(tagsOf('任务 ⏫'), ['高']);
  assert.deepEqual(tagsOf('任务 🔼'), ['中']);
  assert.deepEqual(tagsOf('任务 🔽'), ['低']);
  assert.deepEqual(tagsOf('任务 ⏬'), ['最低']);
  assert.deepEqual(tagsOf('就是一件普通的事'), []);
});

test('渲染：🔁 规则原文照搬，带 when done 时补一句；不做语法翻译', () => {
  assert.deepEqual(tagsOf('跑步 🔁 every 3 days'), ['重复 every 3 days']);
  assert.deepEqual(tagsOf('跑步 🔁 every 3 days when done'), ['重复 every 3 days（完成后）']);
  assert.deepEqual(tagsOf('跑步 🔁 every week on Monday'), ['重复 every week on Monday']);
});

test('渲染：🆔 编号、⛔ 依赖（多个原样列出）、🏁 只认两种', () => {
  assert.deepEqual(tagsOf('任务 🆔 abc123'), ['编号 abc123']);
  assert.deepEqual(tagsOf('任务 ⛔ abc, def'), ['依赖 abc, def']);
  assert.deepEqual(tagsOf('任务 🏁 keep'), ['完成后：保留']);
  assert.deepEqual(tagsOf('任务 🏁 delete'), ['完成后：删除']);
});

test('渲染：一行里多个记号各归各位，顺序不乱', () => {
  const tags = tagsOf(`写周报 ⏳ ${thisYear(1, 26)} 📅 ${thisYear(1, 26)} ✅ ${thisYear(1, 26)}`);
  assert.deepEqual(tags, ['计划 1-26', '截止 1-26', '完成 1-26']);
});

test('不成形的不翻，原样留着', () => {
  // ⏳ 后面没跟日期
  assert.deepEqual(tagsOf('记一下 ⏳ 然后再说'), []);
  assert.match(render('- 记一下 ⏳ 然后再说'), /⏳/);
  // 🏁 后面不是 keep/delete
  assert.deepEqual(tagsOf('任务 🏁 something'), []);
  // 🆔 后面没编号
  assert.deepEqual(tagsOf('任务 🆔'), []);
  // 🔁 后面没规则
  assert.deepEqual(tagsOf('任务 🔁'), []);
  // ✅ 后面跟的不是日期（口语里当表情用）
  assert.deepEqual(tagsOf('今天心情不错 ✅ 挺好的'), []);
});

test('表情后面紧贴文字的不算记号——那是句子里的表情', () => {
  // 实测库里有 `）🛫 2026-09-29` 这种「表情紧贴前文」的写法：前贴没问题
  assert.deepEqual(tagsOf(`买冲锋裤）🛫 ${thisYear(9, 29)}`), ['开始 9-29']);
  // 但表情**后面**紧跟文字就不是记号了
  assert.deepEqual(tagsOf('今天感觉✅挺好的'), []);
  assert.deepEqual(tagsOf('今天很开心😀确实'), [], '认不得的表情压根不在表里');
});

test('渲染：只在列表项里翻——表格与正文里的原样', () => {
  const table = render(`| 项 | 状态 |\n|---|---|\n| 甲 | ✅ ${thisYear(1, 1)} |\n`);
  assert.doesNotMatch(table, /task-tag/);
  assert.match(table, /✅/);
  const para = render(`今天完成了 ✅ ${thisYear(1, 1)} 这件事\n`);
  assert.doesNotMatch(para, /task-tag/);
});

test('渲染：行内代码里的记号不动', () => {
  const html = render('- 写法是 `⏳ ' + thisYear(9, 29) + '` 这样\n');
  assert.doesNotMatch(html, /task-tag/);
  assert.match(html, /<code>⏳ /);
});

test('扫描：没有记号时只有一段文字，有记号时切成三段', () => {
  assert.deepEqual(scanMarkers('plain'), [{ type: 'text', text: 'plain' }]);
  const parts = scanMarkers(`a ⏳ ${thisYear(9, 29)} b`);
  assert.deepEqual(parts.map((p) => p.type), ['text', 'tag', 'text']);
  assert.equal(parts[1].label, '计划 9-29');
  assert.equal(parts[2].text, ' b');
});

test('hasMarker：决定勾上时要不要补日期', () => {
  assert.equal(hasMarker(`- [ ] 买牛奶 ⏳ ${thisYear(9, 29)}`), true);
  assert.equal(hasMarker('- [ ] 买牛奶'), false, '纯清单行不算');
  assert.equal(hasMarker('- [ ] 买牛奶 #工作'), false, '标签不是 Tasks 记号');
  assert.equal(hasMarker('- [ ] 记一下 ⏳ 然后再说'), false, '不成形的记号不算');
});

test('todayString：本地日期，补零', () => {
  assert.equal(todayString(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(todayString(new Date(2026, 11, 31)), '2026-12-31');
});

test('手术：补 ✅ 在行尾，且排在尾随空白之前', () => {
  assert.equal(addDoneDate('- [x] 买牛奶', '2026-10-01'), '- [x] 买牛奶 ✅ 2026-10-01');
  // 库里有的行结尾带一个空格——补在空格之前，别把它挤到中间
  assert.equal(addDoneDate('- [x] 买牛奶 ', '2026-10-01'), '- [x] 买牛奶 ✅ 2026-10-01 ');
  assert.equal(addDoneDate('- [x] 买牛奶   \t', '2026-10-01'), '- [x] 买牛奶 ✅ 2026-10-01   \t');
});

test('手术：同一行已有 ✅ 时再补一次——改成当天，不追加第二个', () => {
  const once = addDoneDate('- [x] 买牛奶 ✅ 2026-01-24', '2026-10-01');
  assert.equal(once, '- [x] 买牛奶 ✅ 2026-10-01');
  assert.equal((once.match(/✅/g) || []).length, 1, '不能出现两个 ✅');
  // 幂等：再补一次还是同一个结果
  assert.equal(addDoneDate(once, '2026-10-01'), once);
});

test('手术：摘 ✅ 不碰行内其他记号', () => {
  assert.equal(
    removeDoneDate(`- [ ] 写周报 ⏳ ${thisYear(1, 26)} 📅 ${thisYear(1, 27)} ✅ ${thisYear(1, 26)}`),
    `- [ ] 写周报 ⏳ ${thisYear(1, 26)} 📅 ${thisYear(1, 27)}`,
  );
  // ✅ 在中间时，摘掉后前面那个日期与后面内容之间的空格数正常
  assert.equal(removeDoneDate('- [ ] a ✅ 2026-01-24 b'), '- [ ] a b');
  // 没有 ✅ 时原样返回
  assert.equal(removeDoneDate('- [ ] a ⏳ 2026-01-26'), '- [ ] a ⏳ 2026-01-26');
});

test('手术：摘 ❌ 不碰行内其他记号', () => {
  assert.equal(
    removeCancelDate(`- [ ] 写周报 ⏳ ${thisYear(1, 26)} ❌ ${thisYear(1, 27)}`),
    `- [ ] 写周报 ⏳ ${thisYear(1, 26)}`,
  );
  assert.equal(removeCancelDate('- [ ] a ✅ 2026-01-24'), '- [ ] a ✅ 2026-01-24');
});

test('手术：补 ✅ 再摘 ✅ 回到原样（勾上再取消的往返）', () => {
  const before = '- [ ] 写周报 ⏳ 2026-01-26';
  const after = addDoneDate(before, '2026-10-01');
  assert.equal(removeDoneDate(after), before);
});
