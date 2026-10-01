// Tasks 记号的阅读态翻译，以及勾选时对「完成 / 取消 日期」的文本手术（#15 定稿 → #28 落地）。
//
// 三件事住这里，都是纯函数（不碰 DOM），所以能进 `node --test`：
//   1. **记号表**（`MARKERS`）：表情 → 中文文案。**只有这一处定义**，加符号只改这里。
//   2. **扫描**（`scanMarkers`）：把一段文字切成「普通文字 / 标签」两段序列，渲染用。
//   3. **手术**（`addDoneDate` / `removeDoneDate` / `removeCancelDate`）：勾选与取消时
//      追加、更新、摘掉行尾的 `✅ 日期` 与 `❌ 日期`，行内其他字节一个不碰。
//
// 一条贯穿全篇的保守原则：**记号不成形就不翻**。`⏳` 后面没跟日期、`🏁` 后面不是
// keep/delete、`🆔` 后面没编号——一律原样留着。翻出半截标签比不翻更难看，也更容易误导。
//
// 另一条：**记号只认「后面跟空白或行尾」的**。`✅ 2026-01-24` 是元信息，
// 「今天很开心😀」里的表情不是——后者不该被吞掉。

/** 记号与文案的对应表——全应用唯一一份。 */
export const MARKERS = {
  // 日期类：表情之后跟一个 `YYYY-MM-DD`
  '⏳': { kind: 'date', label: '计划' },
  '🛫': { kind: 'date', label: '开始' },
  '📅': { kind: 'date', label: '截止' },
  '✅': { kind: 'date', label: '完成' },
  '❌': { kind: 'date', label: '取消' },
  '➕': { kind: 'date', label: '创建' },
  // 优先级：封闭集合，无值，无记号＝普通（不显示任何标签）
  '🔺': { kind: 'priority', label: '最高' },
  '⏫': { kind: 'priority', label: '高' },
  '🔼': { kind: 'priority', label: '中' },
  '🔽': { kind: 'priority', label: '低' },
  '⏬': { kind: 'priority', label: '最低' },
  // 「值一直到下一个记号或行尾」的两类：规则原文照搬，不做语法翻译
  '🔁': { kind: 'rest', label: '重复', sep: ' ' },
  '⛔': { kind: 'rest', label: '依赖', sep: ' ' },
  // 单值类：后面跟一个不含空白的词
  '🆔': { kind: 'token', label: '编号', sep: ' ' },
  '🏁': { kind: 'token', label: '完成后', sep: '：' },
};

const MARKER_CHARS = Object.keys(MARKERS);
export const isMarkerChar = (ch) => Object.prototype.hasOwnProperty.call(MARKERS, ch);

/** 找下一个记号字符用的扫描器。`u` 不能省：🔺 🛫 这些是双码元的。 */
const markerSearch = () => new RegExp('[' + MARKER_CHARS.join('') + ']', 'gu');

const DATE_VALUE = /^[ \t]*(\d{4})-(\d{2})-(\d{2})/;
const TOKEN_VALUE = /^[ \t]*(\S+)/;

/** 本地当天日期，`YYYY-MM-DD`——库内既有的写法。 */
export function todayString(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}

/**
 * 日期的显示形态：**当年省年份**（`2026-09-29` → `9-29`），跨年带年份（→ `2025-9-29`）。
 * 按字符串拆，不经过 `Date`——`new Date('2026-09-29')` 会被当 UTC 午夜，跨时区会差一天。
 */
export function formatDate(y, mo, d, now = new Date()) {
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  return yy === now.getFullYear() ? mm + '-' + dd : yy + '-' + mm + '-' + dd;
}

/**
 * 读一个记号：成形则给出标签与「吃到哪里」，不成形返回 null（当普通文字）。
 *
 * @param {string} s 整段文字
 * @param {number} at 记号字符的起始下标
 * @param {string} ch 记号字符
 */
function readMarker(s, at, ch, now) {
  const def = MARKERS[ch];
  if (!def) return null;
  const rest = s.slice(at + ch.length);
  // 记号后面必须是空白或行尾/段尾——否则那是句子里的表情，不是元信息
  if (rest !== '' && !/^[ \t\n]/.test(rest)) return null;

  if (def.kind === 'priority') return { label: def.label, end: at + ch.length };

  const sep = def.sep || ' ';

  if (def.kind === 'date') {
    const dm = rest.match(DATE_VALUE);
    if (!dm) return null; // 没跟日期 → 不成形
    return {
      label: def.label + sep + formatDate(dm[1], dm[2], dm[3], now),
      end: at + ch.length + dm[0].length,
    };
  }

  if (def.kind === 'token') {
    const tm = rest.match(TOKEN_VALUE);
    if (!tm) return null;
    if (ch === '🏁' && tm[1] !== 'keep' && tm[1] !== 'delete') return null; // 只认这两种
    const value = ch === '🏁' ? (tm[1] === 'keep' ? '保留' : '删除') : tm[1];
    return { label: def.label + sep + value, end: at + ch.length + tm[0].length };
  }

  // rest：值取到下一个成形记号或行尾
  const end = nextMarkerAt(s, at + ch.length, now);
  const value = s.slice(at + ch.length, end).trim();
  if (!value) return null;
  if (ch === '🔁') {
    // 规则取值是自由英文短语，**原文照搬**；`when done` 另给一句说明，不做语法翻译
    const whenDone = /[ \t]+when[ \t]+done$/i.test(value);
    const rule = whenDone ? value.replace(/[ \t]+when[ \t]+done$/i, '') : value;
    return { label: def.label + sep + rule + (whenDone ? '（完成后）' : ''), end };
  }
  return { label: def.label + sep + value, end };
}

/** 从 `from` 起，下一个**成形**记号的位置；没有就是本行行尾。 */
function nextMarkerAt(s, from, now) {
  const nl = s.indexOf('\n', from);
  const limit = nl === -1 ? s.length : nl;
  const re = markerSearch();
  re.lastIndex = from; // 不定位的话会从 0 找起、又撞回自己，递归到爆栈
  let m;
  while ((m = re.exec(s)) !== null && m.index < limit) {
    if (readMarker(s, m.index, m[0], now)) return m.index;
  }
  return limit;
}

/**
 * 把一段文字切成 `{type:'text',text}` 与 `{type:'tag',char,label}` 的序列。
 * 没有记号时返回单个 text 段——调用方据此判断「这一行有没有 Tasks 记号」。
 */
export function scanMarkers(text, now = new Date()) {
  const s = String(text);
  const parts = [];
  const re = markerSearch();
  let cursor = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const at = m.index;
    const ch = m[0];
    // 先复位扫描位置：readMarker 内部可能再扫一次（rest 类要找下一个记号）
    re.lastIndex = at + ch.length;
    const hit = readMarker(s, at, ch, now);
    if (!hit) continue; // 不成形：当普通文字，继续往后找
    if (at > cursor) parts.push({ type: 'text', text: s.slice(cursor, at) });
    parts.push({ type: 'tag', char: ch, label: hit.label });
    cursor = hit.end;
    re.lastIndex = hit.end;
  }
  if (cursor < s.length) parts.push({ type: 'text', text: s.slice(cursor) });
  return parts;
}

/** 这一行带没带 Tasks 记号——决定勾上时要不要补 `✅` 日期。 */
export function hasMarker(line) {
  return scanMarkers(line).some((p) => p.type === 'tag');
}

/* ---------- 文本手术：只动 `✅` / `❌` 那一段，行内其他字节不碰 ---------- */
//
// 段前那个可选空白是故意吃掉的：`⏳ 2026-01-26 ✅ 2026-01-26` 摘掉后应是
// `⏳ 2026-01-26` 而不是 `⏳ 2026-01-26 `。

const DONE_SEG = /[ \t]*✅[ \t]*\d{4}-\d{2}-\d{2}/g;
const CANCEL_SEG = /[ \t]*❌[ \t]*\d{4}-\d{2}-\d{2}/g;
/** 非全局——`.test()` 不推进 lastIndex，可以安全地复用。 */
const DONE_DATE = /✅[ \t]*\d{4}-\d{2}-\d{2}/;

/** 摘掉 `✅ 日期`。 */
export function removeDoneDate(line) {
  return String(line).replace(DONE_SEG, '');
}

/** 摘掉 `❌ 日期`。 */
export function removeCancelDate(line) {
  return String(line).replace(CANCEL_SEG, '');
}

/**
 * 补上 `✅ 当天日期`。
 *
 * 已经有 `✅ 日期` 时**改成当天，不追加第二个**——同一行出现两个完成日期是纯粹的
 * 数据垃圾，而且还看不出哪个是真的。追加位置在行尾，但**排在尾随空白之前**，
 * 免得把行尾那个空格挤到中间去。
 */
export function addDoneDate(line, today) {
  const s = String(line);
  if (DONE_DATE.test(s)) return s.replace(DONE_DATE, '✅ ' + today);
  const m = s.match(/^([\s\S]*?)([ \t]*)$/);
  return m[1] + ' ✅ ' + today + m[2];
}

/**
 * 安装渲染钩子：列表项里的记号换成胶囊标签，表情不再出现。
 *
 * **只在列表项里翻**。表格与正文里也飘着不少 ✅ ❌（实测 159 处在表格里），
 * 那些多半是当「是/否」用的符号，不是 Tasks 元信息；一并翻译会把它们变成
 * 莫名其妙的胶囊。列表项才是元信息的家。
 */
export function installTaskMarkerRule(md) {
  const esc = md.utils.escapeHtml;

  md.core.ruler.push('obsidian_task_markers', (state) => {
    let inItem = 0;
    for (const token of state.tokens) {
      if (token.type === 'list_item_open') { inItem++; continue; }
      if (token.type === 'list_item_close') { inItem--; continue; }
      if (inItem <= 0 || token.type !== 'inline' || !token.children) continue;
      splitChildren(state, token, esc);
    }
  });
}

function splitChildren(state, inline, esc) {
  const out = [];
  let changed = false;
  for (const child of inline.children) {
    // 只动 text——code_inline 天然是另一种 token，行内代码里的记号因此自动不受影响
    if (child.type !== 'text' || !child.content) { out.push(child); continue; }
    const parts = scanMarkers(child.content);
    if (parts.length === 1 && parts[0].type === 'text') { out.push(child); continue; }
    changed = true;
    for (const p of parts) {
      if (p.type === 'text') {
        const t = new state.Token('text', '', 0);
        t.content = p.text;
        out.push(t);
      } else {
        const h = new state.Token('html_inline', '', 0);
        h.content = '<span class="task-tag">' + esc(p.label) + '</span>';
        out.push(h);
      }
    }
  }
  if (changed) inline.children = out;
}
