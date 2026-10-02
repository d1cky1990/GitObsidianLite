// 阅读态开头那段声明（YAML frontmatter）的渲染（#12 定稿 → #30 落地）。
//
// 三件事住这里，其余（插到渲染管线的哪一步、插几次）住在 main.js：
//   1. **认出声明区**（`findFrontmatter`）：只认**文件最开头**由两条 `---` 包起来的那一段。
//   2. **把那段原文翻成字段**（`parseFrontmatterFields`）：纯逻辑，不碰 DOM、不碰渲染器。
//   3. **画出来**（`installFrontmatterRule` 里挂的那条块规则 + 渲染规则）。
//
// 挂的是**块级规则**（`md.block.ruler`），不是自己先扫一遍原文再拼 HTML。这一层天然把
// 「不在最开头」挡在外面：`startLine !== 0` 直接返回 false；也顺带把缩进代码块里的 `---`
// 一起挡掉（那时 blkIndent 不为 0）。摘出来的那段被**吃成 token**，所以那两条横线不会再
// 落到 `hr` 规则上变成分隔线——这是本规则存在的第二个理由，不是副作用。
//
// 一条**已知的简化**（不是疏漏）：声明区里如果一个字段的值是**嵌套映射**
// （`key:` 换行后跟缩进的 `子键: 值`），这里会把它当成多行文本整块铺开，而不是画成
// 二级字段。全库 855 篇只读实测这类写法 **0 处**——为它写一套嵌套渲染，眼下买不到任何东西。
//
// 值怎么整理，定在 #12：[结论](https://github.com/d1cky1990/GitObsidianLite/issues/12#issuecomment-5929628528)。
// 这里只把那条结论落成代码，不复述理由。

import { tagChipHtml } from './tags.js';

/** 一行是不是那条分隔线。允许行尾空白与 CRLF 的行尾 `\r`，但不允许行首缩进。 */
const isFence = (line) => line.replace(/\r$/, '').trimEnd() === '---';

/**
 * 找出**文件最开头**的声明区。
 *
 * 返回 `{ raw, lineCount }`——`raw` 是两条 `---` 之间的原文（不含分隔线本身），
 * `lineCount` 是整个声明块占的行数（含两条横线），供块规则推进 `state.line`。
 * 不是开头声明的（第一条不是 `---`、只有一条 `---`、或声明区在正文中间）一律返回 `null`，
 * 交由既有的正文渲染处理——那时 `---` 照旧是一条分隔线。
 *
 * BOM 只在**判定**时跳过：行的定位不受影响（BOM 不占行）。
 */
export function findFrontmatter(src) {
  const text = src.startsWith('\uFEFF') ? src.slice(1) : src;
  const lines = text.split('\n');
  if (!isFence(lines[0] ?? '')) return null;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) return { raw: lines.slice(1, i).join('\n'), lineCount: i + 1 };
  }
  return null;
}

const isBlank = (line) => /^[ \t]*$/.test(line);
/** `#` 开头的整行是 YAML 注释——它是笔记写法，不是字段，也不该画出来。 */
const isComment = (line) => /^[ \t]*#/.test(line);
/** 列表项：`- 内容`、`-` 独占一行都算；缩进不缩进都认（YAML 两种写法都合法）。 */
const isItem = (line) => /^[ \t]*-(?:[ \t]|$)/.test(line);
/** 块标量头：`|`、`>`，可带 `-`/`+` 与缩进数字。 */
const isBlockScalarHead = (v) => /^[|>][+\-]?\d*$/.test(v);

/**
 * 去引号：单引号里的 `''` 是一个转义的单引号，双引号里的 `\"` 与 `\\` 同理。
 * 只脱最外层那一对——值中间的原样留着。
 */
function unquote(v) {
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return v;
}

/**
 * 一个裸值 → 显示用的文字。布尔翻成「是 / 否」（#12 定稿：只读版不画勾选框——
 * 画成勾选框会和真能点的任务勾选框混淆）；其余按原样，日期不本地化。
 */
function scalarValue(token) {
  const t = token.trim();
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true' ? '是' : '否';
  return unquote(t);
}

/** `key: 值` 右边那段 → 值的数组。`[a, b]` 拆成多个值；其余是单个值。 */
function parseInlineValue(rest) {
  const flow = /^\[([\s\S]*)\]$/.exec(rest);
  if (!flow) return [scalarValue(rest)];
  const inner = flow[1].trim();
  if (!inner) return []; // `key: []` —— 空列表，值就是零个，不留一个假值
  return inner.split(',').map((s) => scalarValue(s)).filter((s) => s !== '');
}

/**
 * 声明区原文 → 字段数组，**顺序照文件原顺序**，不重排、不合并同名键。
 *
 * 每个字段是 `{ key, values }`：`values` 是字符串数组——单值一个、列表多个、
 * 空值（`key:` 后面什么都没有、或 `key: []`）零个。零个不是「解析失败」，
 * 库里真有这种写法（`author:` 空着、`创作载体: []`），照原样留白。
 *
 * 认不出的行（本库不存在，但将来可能有）**跳过、不造假字段**——宁可少画一行，
 * 不凭空造一个键出来。
 */
export function parseFrontmatterFields(raw) {
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
  const fields = [];
  let cur = null;

  /** 收尾当前字段：把它按落定的形态（单值 / 列表 / 多行块 / 空）推入结果。 */
  const flush = () => {
    if (!cur) return;
    if (cur.mode === 'list') fields.push({ key: cur.key, values: cur.items });
    else if (cur.mode === 'block') {
      // 块标量：前后空行不画出来，中间的空行照留（它是内容的一部分）
      const body = cur.body.slice();
      while (body.length && isBlank(body[0])) body.shift();
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      fields.push({ key: cur.key, values: body.length ? [body.join('\n')] : [] });
    } else fields.push({ key: cur.key, values: cur.values || [] });
    cur = null;
  };

  for (const line of lines) {
    // 空行：只在块标量里算内容，其余位置只是排版空白
    if (isBlank(line)) {
      if (cur && cur.mode === 'block') cur.body.push('');
      continue;
    }
    if (isComment(line)) continue;

    if (isItem(line)) {
      // 列表项归上一行那个「值为空」的键。前面不是这种键的孤立项：丢弃。
      if (cur && (cur.mode === 'empty' || cur.mode === 'list')) {
        cur.mode = 'list';
        cur.items.push(scalarValue(line.replace(/^[ \t]*-[ \t]?/, '')));
      }
      continue;
    }

    // 缩进续行：块标量（`description: |` 后面那段）才该走到这里
    if (/^[ \t]/.test(line)) {
      if (cur && (cur.mode === 'empty' || cur.mode === 'block')) {
        cur.mode = 'block';
        cur.body.push(line.replace(/^[ \t]+/, ''));
      }
      continue;
    }

    const m = /^(\S[^:]*):([\s\S]*)$/.exec(line);
    if (!m) continue;
    flush();
    const key = m[1].trim();
    const rest = m[2].trim();
    if (rest === '') cur = { key, mode: 'empty', values: [], items: [], body: [] };
    else if (isBlockScalarHead(rest)) cur = { key, mode: 'block', values: [], items: [], body: [] };
    else cur = { key, mode: 'value', values: parseInlineValue(rest), items: [], body: [] };
  }
  flush();
  return fields;
}

/**
 * 字段 → 阅读态那块声明的 HTML。
 *
 * 形态（#12 定稿）：**3 项以内直接铺开**；**超过 3 项收成一行「声明 · N 项」**，
 * 点一下就地铺开、再点收起，**收起状态不记忆**——用原生 `<details>` 拿到的正是这套行为，
 * 浏览器自带，不写一行脚本，也不会被重渲染搅乱。
 * 空声明（零个字段）返回空串：那一块整块不显示，不留痕迹。
 */
export function frontmatterHtml(fields, escapeHtml) {
  if (!fields.length) return '';
  const rows = fields.map((f) => {
    // `tags` 走全应用唯一的那份标签实现（#14 定稿 / #29）。YAML 里是**裸名字**（全库
    // 202 个标签值 0 个带 `#`），所以不加 `#`——加不加由那边的定稿说了算，这里不掺和。
    const vals = f.values.map((v) =>
      f.key === 'tags' ? tagChipHtml(v) : '<span class="fm-v">' + escapeHtml(v) + '</span>').join('');
    return '<div class="fm-row"><span class="fm-key">' + escapeHtml(f.key) + '</span>' +
      '<span class="fm-vals">' + vals + '</span></div>';
  }).join('');
  const body = '<div class="fm-rows">' + rows + '</div>';
  const head = fields.length > 3
    ? '<summary class="fm-summary">' + escapeHtml('声明 · ' + fields.length + ' 项') + '</summary>'
    : '';
  const box = head ? '<details class="fm-fold">' + head + body + '</details>' : body;
  return '<div class="fm">' + box + '</div>\n';
}

/**
 * 安装渲染钩子：文件最开头的那段声明换成阅读态顶部的字段区。
 *
 * 插在 `table` 之前 = 块规则的**第一道**。这不要紧（前面那几条都匹配不上 `---`），
 * 要紧的是它必须排在 `hr` 前面——排后面的话 `---` 已经被吃成 `<hr>` 了。
 * 失败一律返回 `false`：认不出就当没有声明区，原文原样走既有渲染。
 */
export function installFrontmatterRule(md) {
  const escapeHtml = md.utils.escapeHtml;
  md.block.ruler.before('table', 'frontmatter', (state, startLine, endLine, silent) => {
    // 只认文档的**第一个块**。这条同时排除了「声明区不在最开头」与「缩进代码块里的 ---」。
    if (startLine !== 0 || state.blkIndent !== 0) return false;
    const hit = findFrontmatter(state.src);
    if (!hit) return false;
    if (silent) return true;
    const token = state.push('frontmatter', '', 0);
    token.map = [0, hit.lineCount];
    token.content = hit.raw;
    state.line = hit.lineCount; // 把那两条横线连同中间整段一起吃掉
    return true;
  });

  md.renderer.rules.frontmatter = (tokens, idx) =>
    frontmatterHtml(parseFrontmatterFields(tokens[idx].content), escapeHtml);
}
