// 阅读态的待办勾选框（#13 定稿 → #27 落地 → #28 扩到四态）。
//
// 两条规则住这里，其余（点击、排队、提交）住在 main.js：
//   1. **什么算任务**：与 GitHub / Obsidian 一致——只有「列表项开头」的 `[?]` 渲染成方框
//      （`?` 是方括号里的任意单字符）；引用块里的列表照常算（它仍是列表项），
//      普通段落、表格、列表项续行里的原样是文字，不可点。
//   2. **点了怎么改文件**：翻行首那一个状态字符，外加行尾 `✅`/`❌` 那一段的增删
//      （见 `task-markers.js`）——一行里的其他字节一个不碰。
//
// 状态字符是**单字符**，认得的只有四个：` `（未勾）`x`/`X`（已勾）`/`（进行中）`-`（取消）。
// 认不得的（`[?]` `[>]`）照旧画成方框、字符原样显示——**不退化成文字**：它显然是个任务，
// 装作没看见比画个方框更糟。点击一律落「未勾 ↔ 已勾」这个二值上。
//
// 切换相关是纯函数（不碰 DOM），所以能进 `node --test`；渲染钩子跟着 markdown-it
// 走，测试里同样用真实渲染器整体跑一遍再断言，不另写复刻逻辑的复算脚本。

import { addDoneDate, removeDoneDate, removeCancelDate, hasMarker, todayString } from './task-markers.js';

/** 列表项开头的任务标记。要求尾随空格，与 GitHub / Obsidian 的识别一致。 */
const ITEM_MARK_RE = /^\[([^\]])\] /;

/** 整行视角：这一行是不是一个任务项。切换前后都用它判状态。 */
const LINE_TASK_RE = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+\[)([^\]])(\].*)$/;

/** 已勾上的两个写法。 */
const isDoneState = (ch) => ch === 'x' || ch === 'X';

/**
 * 切换一行开头的任务标记，顺带处理完成日期。
 *
 * 勾上：摘掉 `❌ 日期`——任务不能同时是「取消」和「完成」；若这一行**带 Tasks 记号**
 *       就在行尾补 `✅ 当天日期`。纯清单行（`- [ ] 买牛奶`）不加，实测库里这类
 *       清单本来就不写日期，硬加会偏离既有习惯。
 * 取消：摘掉 `✅ 日期`。
 *
 * 「未勾 ↔ 已勾」这个二值里，**已勾只算 `x` / `X`**。`[/]`（进行中）`[-]`（取消）
 * 以及认不得的状态被点，都是**往「已勾」走**——不是反过来。
 *
 * @param {string} lineText
 * @param {string} [today] `YYYY-MM-DD`，测试里固定用
 * @returns {string|null} 切换后的整行；不是任务项行则 null（调用方原样跳过）。
 */
export function toggleTaskLine(lineText, today = todayString()) {
  const s = String(lineText);
  const m = s.match(LINE_TASK_RE);
  if (!m) return null;
  const wasDone = isDoneState(m[4]);

  let body = s;
  if (wasDone) {
    body = removeDoneDate(body);
  } else {
    // 「带不带记号」要问**摘之前**的原文：`❌ 日期` 自己就是一个 Tasks 记号。
    // 先摘再问的话，`- [-] 退掉旧订阅 ❌ 2026-09-30` 这种「记号只有 ❌」的行会被
    // 答成「不带记号」，于是 ✅ 永远补不上——实测踩到过一次（#28 验收）。
    const hadMarker = hasMarker(s);
    body = removeCancelDate(body);
    if (hadMarker) body = addDoneDate(body, today);
  }

  // 状态字符最后翻。上面的手术都落在行首标记之后，不会挪动它；重匹配一次是
  // 为了拿准手术后的前缀（`- [x] ✅ …` 摘掉后 `]` 与 `✅` 之间的空格会消失）。
  const bm = body.match(LINE_TASK_RE);
  if (!bm) return null;
  return bm[1] + bm[2] + bm[3] + (wasDone ? ' ' : 'x') + bm[5];
}

/** 这一行的任务是不是勾上的。非任务行返回 false——只用来给提交信息选词。 */
export function isTaskDoneLine(lineText) {
  const m = String(lineText).match(LINE_TASK_RE);
  return !!m && isDoneState(m[4]);
}

/**
 * 在整篇源文里切换第 `line` 行（0 起）的任务标记。
 *
 * 行号来自渲染期的 token 定位，与源文按 `\n` 拆行的下标一致；切换不增删行，
 * 所以连勾多个时行号不会漂。
 *
 * @returns {string|null} 切换后的整篇；行号越界或该行不是任务项行则 null。
 */
export function toggleTaskInContent(content, line, today = todayString()) {
  const lines = String(content).split('\n');
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
  const toggled = toggleTaskLine(lines[line], today);
  if (toggled === null) return null;
  lines[line] = toggled;
  return lines.join('\n');
}

/**
 * 安装渲染钩子：core 规则找任务项、剥掉 `[ ] ` 前缀、在原位放方框；
 * 剩下的文字包进 `<span class="task-text">`，已完成项的划线只落在文字上，
 * 不会横穿方框。
 */
export function installTaskRule(md) {
  const esc = md.utils.escapeHtml;

  md.core.ruler.push('obsidian_task_items', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || !inline.children || !inline.children.length) continue;
      // 任务项的第一段文字：紧跟在 list_item_open 之后的那个 inline。
      // 续行、第二段的 inline 前面隔着 paragraph_close / list_item_close，天然不满足。
      if (tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = inline.children[0];
      if (first.type !== 'text') continue;
      const m = first.content.match(ITEM_MARK_RE);
      if (!m) continue;
      const state_ = m[1];
      const done = isDoneState(state_);
      const line = inline.map ? inline.map[0] : -1;
      if (line < 0) continue;

      first.content = first.content.slice(m[0].length);
      const box = new state.Token('task_checkbox', '', 0);
      box.attrSet('data-task-line', String(line));
      box.attrSet('data-state', state_);
      const open = new state.Token('html_inline', '', 0);
      open.content = '<span class="task-text">';
      const close = new state.Token('html_inline', '', 0);
      close.content = '</span>';
      inline.children.unshift(box, open);
      inline.children.push(close);

      const li = tokens[i - 2];
      li.attrJoin('class', 'task-item');
      if (done) li.attrJoin('class', 'task-done');
    }
  });

  md.renderer.rules.task_checkbox = (tokens, idx) => {
    const t = tokens[idx];
    const st = t.attrGet('data-state');
    const done = isDoneState(st);
    // 已勾用背景 SVG 画对勾（不占文字位，划线才不会横穿）；其余状态把字符原样放进方框：
    // `/` 进行中、`-` 取消、`?` 之类认不得的照旧显示——「不退化成一串文字」是定稿要求。
    const mark = !done && st !== ' ' ? esc(st) : '';
    return '<button type="button" class="task-box' + (done ? ' is-done' : '') +
      '" data-task-line="' + t.attrGet('data-task-line') +
      '" data-state="' + esc(st) + '"' +
      ' aria-label="切换待办勾选">' + mark + '</button>';
  };
}
