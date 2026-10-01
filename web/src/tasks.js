// 阅读态的待办勾选框（#13 定稿 → #27 落地）。
//
// 两条规则住这里，其余（点击、排队、提交）住在 main.js：
//   1. **什么算任务**：与 GitHub / Obsidian 一致——只有「列表项开头」的
//      `[ ]` / `[x]` / `[X]` 渲染成方框；引用块里的列表照常算（它仍是列表项），
//      普通段落、表格、列表项续行里的原样是文字，不可点。
//   2. **点了怎么改文件**：只动那一行开头的标记（`[ ]` ↔ `[x]`），一行里的其他
//      字节一个不碰——这是「带 sha 核对的单文件写」能放心用的前提。
//
// 切换相关是纯函数（不碰 DOM），所以能进 `node --test`；渲染钩子跟着 markdown-it
// 走，测试里同样用真实渲染器整体跑一遍再断言，不另写复刻逻辑的复算脚本。

/** 列表项开头的任务标记。要求尾随空格，与 GitHub / Obsidian 的识别一致。 */
const ITEM_MARK_RE = /^\[([ xX])\] /;

/** 整行视角：这一行是不是一个（已勾上的）任务项。切换前后都用它判状态。 */
const LINE_TASK_RE = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+\[)([ xX])(\].*)$/;

/**
 * 切换一行开头的任务标记。只认「可选项 + 标记」这种列表项写法。
 *
 * @returns {string|null} 切换后的整行；不是任务项行则 null（调用方原样跳过）。
 */
export function toggleTaskLine(lineText) {
  const m = String(lineText).match(LINE_TASK_RE);
  if (!m) return null;
  const next = m[4] === ' ' ? 'x' : ' ';
  return m[1] + m[2] + m[3] + next + m[5];
}

/** 这一行的任务是不是勾上的。非任务行返回 false——只用来给提交信息选词。 */
export function isTaskDoneLine(lineText) {
  const m = String(lineText).match(LINE_TASK_RE);
  return !!m && m[4] !== ' ';
}

/**
 * 在整篇源文里切换第 `line` 行（0 起）的任务标记。
 *
 * 行号来自渲染期的 token 定位，与源文按 `\n` 拆行的下标一致；切换不增删行，
 * 所以连勾多个时行号不会漂。
 *
 * @returns {string|null} 切换后的整篇；行号越界或该行不是任务项行则 null。
 */
export function toggleTaskInContent(content, line) {
  const lines = String(content).split('\n');
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
  const toggled = toggleTaskLine(lines[line]);
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
      const done = m[1] !== ' ';
      const line = inline.map ? inline.map[0] : -1;
      if (line < 0) continue;

      first.content = first.content.slice(m[0].length);
      const box = new state.Token('task_checkbox', '', 0);
      box.attrSet('data-task-line', String(line));
      box.attrSet('data-done', done ? '1' : '0');
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
    const done = t.attrGet('data-done') === '1';
    return '<button type="button" class="task-box' + (done ? ' is-done' : '') +
      '" data-task-line="' + t.attrGet('data-task-line') + '" aria-label="切换待办勾选"></button>';
  };
}
