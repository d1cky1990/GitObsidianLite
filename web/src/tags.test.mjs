// 标签渲染的测试（#29）。
//
// 用**真实渲染器整体跑一遍**再断言，不另写复刻识别规则的复算脚本——复刻出来的那份
// 会和被它测的一起错，而且错得看不出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { installTagRule, tagChipHtml } from './tags.js';

const render = (src) => {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installTagRule(md);
  return md.render(src);
};

/** 渲染后页面上的标签胶囊文字（含 `#`）。 */
const chips = (src) =>
  [...render(src).matchAll(/<span class="tag-chip">([^<]*)<\/span>/g)].map((m) => m[1]);

test('标签：中文、字母数字、下划线、连字符、斜杠都算名字的一部分', () => {
  assert.deepEqual(chips('#工作'), ['#工作']);
  assert.deepEqual(chips('见 #游戏开发 与 #work_log-2 两处'), ['#游戏开发', '#work_log-2']);
  assert.deepEqual(chips('#a_b-c/d1'), ['#a_b-c/d1']);
});

test('标签：嵌套层级显示完整', () => {
  assert.deepEqual(chips('#inbox/to-read'), ['#inbox/to-read']);
  assert.deepEqual(chips('见 #inbox/processing 了吗'), ['#inbox/processing']);
});

test('标签：行首也是标签（库里最常见的写法就是行首或小标题后面）', () => {
  assert.deepEqual(chips('#标签 开头'), ['#标签']);
});

test('标签：纯数字不是标签，掺一个非数字字符就是', () => {
  assert.deepEqual(chips('#1984 不是标签'), []);
  assert.deepEqual(chips('#y1984 是标签'), ['#y1984']);
  assert.deepEqual(chips('#1984a 也是'), ['#1984a']);
});

test('标签：`#` 前面不是空白就不算——`abc#tag` 与裸 URL 的锚点都靠这条挡住', () => {
  assert.deepEqual(chips('abc#tag'), []);
  assert.deepEqual(chips('https://x.com/a#b'), []);
  assert.deepEqual(chips('文档：https://code.claude.com/docs/en/desktop#preview-your-app'), []);
  // 前面是空白就照常算
  assert.deepEqual(chips('见 https://x.com/a 与 #标签'), ['#标签']);
});

test('标签：链接目标里的锚点不算', () => {
  assert.deepEqual(chips('[文字](#锚点)'), []);
  assert.deepEqual(chips('[Run sessions](https://x.com/a#run-sessions)'), []);
  assert.deepEqual(chips('1. [设计目的](#1-设计目的)'), []);
});

// 已知的简化，不是疏漏：链接**文字**里的标签仍会被画成胶囊（它在链接标签内部，
// 而链接标签是另一趟递归解析，行内规则这层看不到自己在不在链接里）。挡掉它要多走
// 一趟 token 树；全库实测这类写法 0 处，为它加一趟扫描不划算。真机撞见再补。
test('标签：链接文字里的标签会被画成胶囊（已知简化，全库 0 处）', () => {
  const html = render('[看 #标签 这页](https://x.com)');
  assert.match(html, /<a href="https:\/\/x\.com">看 <span class="tag-chip">#标签<\/span> 这页<\/a>/);
});

test('标签：行内代码与代码块里都不算', () => {
  assert.deepEqual(chips('`#RRGGBB`'), []);
  assert.deepEqual(chips('```\n#注释\n```'), []);
  assert.deepEqual(chips('    #缩进代码块\n'), []);
  // 代码块外面的同一个标签照常渲染
  assert.deepEqual(chips('```\n#标签\n```\n\n#标签'), ['#标签']);
});

test('标签：转义的 \\# 不算', () => {
  assert.deepEqual(chips('\\#标签'), []);
  assert.deepEqual(chips('把背景色改成 \\#3B82F6'), []);
});

test('标签：十六进制颜色不特判——语法上是标签就照标签渲染', () => {
  assert.deepEqual(chips('#ffffff'), ['#ffffff']);
});

test('标签：标点截断，名字只吃到标点前', () => {
  assert.deepEqual(chips('#标签，后面还有字'), ['#标签']);
  assert.deepEqual(chips('#tag, then more'), ['#tag']);
  assert.deepEqual(chips('括号里放的 #标签 照样算'), ['#标签']);
  assert.deepEqual(chips('#a#b'), ['#a']);
  assert.deepEqual(chips('##标题'), []);
});

// 这条边界是**故意的**，不是漏了：Obsidian 的硬规矩是 `#` 前必须有空格（`bug#urgent` 不算），
// 放宽到「标点后面也算」还会把库里的目录跳转 `1. [设计目的](#1-设计目的)` 全变成标签胶囊
// （全库只读实测：这类紧贴共 36 处，全是锚点、行内代码与转义颜色）。
// 推论：**中文标点紧贴的也不行**——`：#工作`、`，#标签` 都要写成 `： #工作`。
test('标签：`#` 前面必须是空白或行首（挡住目录跳转与裸 URL 锚点的那道门）', () => {
  assert.deepEqual(chips('（#标签）'), []);
  assert.deepEqual(chips('标签：#工作'), []);
  assert.deepEqual(chips('前面有字，#工作'), []);
  assert.deepEqual(chips('（#数字后只允许空格规则）'), []);
  // 补上空格就照常算——这也是库里实际的写法
  assert.deepEqual(chips('标签： #工作'), ['#工作']);
});

test('标签：渲染成 span 胶囊，不是链接', () => {
  const html = render('#标签');
  assert.match(html, /<span class="tag-chip">#标签<\/span>/);
  assert.equal(html.includes('<a '), false, '不能渲染成链接——链接样式会暗示可点');
});

test('标签：列表项里照常渲染（任务清单行上挂标签是常见写法）', () => {
  assert.deepEqual(chips('- [ ] 写周报 #工作'), ['#工作']);
  assert.deepEqual(chips('- 普通列表 #工作/日报'), ['#工作/日报']);
});

test('画一个标签：全应用唯一一份，正文与 YAML 走同一处', () => {
  // 正文里带 `#`，YAML 里是裸名字（全库 202 个标签值 0 个带 `#`）——helper 不自作主张加 `#`
  assert.equal(tagChipHtml('#工作'), '<span class="tag-chip">#工作</span>');
  assert.equal(tagChipHtml('工作'), '<span class="tag-chip">工作</span>');
});

test('画一个标签：转义，不给 HTML 注入留口子', () => {
  assert.equal(tagChipHtml('<img src=x onerror=1>'),
    '<span class="tag-chip">&lt;img src=x onerror=1&gt;</span>');
  assert.equal(tagChipHtml('a&b"c\'d'), '<span class="tag-chip">a&amp;b&quot;c&#39;d</span>');
});
