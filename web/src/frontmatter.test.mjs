// 声明区渲染的测试（#30）。
//
// 用**真实渲染器整体跑一遍**再断言，不另写复刻识别与解析规则的复算脚本——复刻出来的
// 那份会和被它测的一起错，而且错得看不出来（这是本仓库量数据的一条硬规矩）。
import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { installFrontmatterRule, findFrontmatter, parseFrontmatterFields } from './frontmatter.js';
import { installTagRule } from './tags.js';

// 与 main.js 挂的是同一组规则——「tags 复用标签模块」这条只有在两条都装着时才算真验过
const render = (src) => {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installFrontmatterRule(md);
  installTagRule(md);
  return md.render(src);
};

/** 一块声明里画出来的「键 → 值们」。 */
const rows = (src) => {
  const html = render(src);
  return [...html.matchAll(
    /<div class="fm-row"><span class="fm-key">([^<]*)<\/span><span class="fm-vals">([\s\S]*?)<\/span><\/div>/g,
  )].map(([, k, v]) => [
    k,
    [...v.matchAll(/<span class="(?:fm-v|tag-chip)">([\s\S]*?)<\/span>/g)].map((x) => x[1]),
  ]);
};

const fm = (...lines) => ['---', ...lines, '---', '', '正文第一段。'].join('\n');

/* ================= 一、什么算声明区 ================= */

test('声明区：认出来、画出来，那两条横线不再是一条分隔线', () => {
  const html = render(fm('title: 甲', 'tags:', '  - 日记'));
  assert.match(html, /^<div class="fm">/);
  assert.equal(html.includes('<hr'), false, '那两条 --- 不能再渲染成分隔线');
  assert.match(html, /正文第一段/);
});

test('声明区：不在最开头的不算——只有一条 --- 的也不算，照普通正文走', () => {
  // 前面有正文
  const after = render('开头一段话。\n\n---\ntitle: 甲\n---\n\n后面。\n');
  assert.equal(after.includes('class="fm"'), false);
  // 只有一条 ---：markdown-it 自己会把它变成分隔线，这与改动前一致
  const single = render('---\ntitle: 甲\n\n正文。\n');
  assert.equal(single.includes('class="fm"'), false);
  assert.match(single, /<hr/);
});

test('声明区：正文里的 --- 分隔线照旧（不误伤）', () => {
  const html = render('第一段。\n\n---\n\n第二段。\n');
  assert.equal(html.includes('class="fm"'), false);
  assert.match(html, /<hr/);
});

test('声明区：声明块整段被吃掉，正文渲染与「删掉声明块」逐字一致', () => {
  const src = fm('title: 甲', 'tags:', '  - 日记');
  const body = '\n正文第一段。\n';
  assert.equal(render(src), render(src).replace(render(body), '') + render(body));
  const stripped = render(src).replace(/^<div class="fm">[\s\S]*?<\/div>\n/, '');
  assert.equal(stripped, render(body), '摘掉声明块之后的正文，应与只渲染正文完全相同');
});

test('声明区：BOM 开头照样认得出', () => {
  const html = render('\uFEFF' + fm('title: 甲'));
  assert.match(html, /^<div class="fm">/);
});

test('声明区：CRLF 行尾照样认得出、字段值不带 \\r', () => {
  const src = ['---', 'title: 甲', '创建日期: 2025-04-10', '---', '', '正文。'].join('\r\n');
  assert.deepEqual(rows(src), [['title', ['甲']], ['创建日期', ['2025-04-10']]]);
});

/* ================= 二、收起还是铺开 ================= */

test('声明区：3 项以内直接铺开，不折', () => {
  const html = render(fm('a: 1', 'b: 2', 'c: 3'));
  assert.equal(html.includes('<details'), false);
  assert.equal(rows(fm('a: 1', 'b: 2', 'c: 3')).length, 3);
});

test('声明区：超过 3 项收成一行「声明 · N 项」，内容仍在这块里、默认收着', () => {
  const src = fm('a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5');
  const html = render(src);
  assert.match(html, /<details class="fm-fold"><summary class="fm-summary">声明 · 5 项<\/summary>/);
  assert.equal(html.includes('<details class="fm-fold" open'), false, '默认必须是收起的');
  assert.equal(rows(src).length, 5, '收起不等于丢掉——五行都还在 DOM 里');
});

test('声明区：空声明整块不显示，但两条横线也不许漏成分隔线', () => {
  for (const src of ['---\n---\n\n正文。\n', '---\n\n---\n\n正文。\n']) {
    const html = render(src);
    assert.equal(html.includes('class="fm"'), false, '空声明不留任何痕迹');
    assert.equal(html.includes('<hr'), false, '那两条 --- 不能被漏给 hr 规则');
    assert.match(html, /正文。/);
  }
  // 全是注释、没有一个字段也算空
  const onlyComment = render('---\n# 只是句注释\n---\n\n正文。\n');
  assert.equal(onlyComment.includes('class="fm"'), false);
});

/* ================= 三、值怎么整理（#12 定稿） ================= */

test('声明区：字段顺序按文件原顺序，不重排、不合并同名', () => {
  const src = fm('z: 末', 'a: 首', 'm: 中', 'a: 又一个 a');
  assert.deepEqual(rows(src).map(([k]) => k), ['z', 'a', 'm', 'a']);
});

test('声明区：引号去掉（单引号含转义、双引号）', () => {
  assert.deepEqual(rows(fm("title: '甲'", 'source: "https://x.com/a?b=1"', "author: 'O''Brien'")),
    [['title', ['甲']], ['source', ['https://x.com/a?b=1']], ['author', ["O'Brien"]]]);
});

test('声明区：布尔翻成「是 / 否」，不画勾选框', () => {
  const src = fm('进行中: false', '完成: true');
  assert.deepEqual(rows(src), [['进行中', ['否']], ['完成', ['是']]]);
  assert.equal(render(src).includes('task-box'), false, '声明区不许出现真能点的勾选框');
});

test('声明区：列表两种写法都成多个值——块列表与方括号', () => {
  assert.deepEqual(rows(fm('tags:', '  - 工作', '  - AI')), [['tags', ['工作', 'AI']]]);
  assert.deepEqual(rows(fm('tags: [xiaobao/旅游攻略, xiaobao/雨崩]')),
    [['tags', ['xiaobao/旅游攻略', 'xiaobao/雨崩']]]);
});

test('声明区：日期原样、不本地化；数字原样', () => {
  assert.deepEqual(rows(fm('创建日期: 2025-04-10', 'bookId: 25164805')),
    [['创建日期', ['2025-04-10']], ['bookId', ['25164805']]]);
});

test('声明区：空值留白，不凭空造一个值出来', () => {
  // `key:` 后面什么都没有、`key: []` 空列表 —— 两种都只在库里见到过，照原样留白
  assert.deepEqual(rows(fm('author:', '创作载体: []')), [['author', []], ['创作载体', []]]);
  assert.equal(rows(fm('author:')).length, 1, '字段本身仍要在——留白不等于丢掉这一行');
});

test('声明区：多行块标量（`|`）换行铺开、不截断', () => {
  const src = fm('description: |', '  第一行。', '  第二行。', 'title: 甲');
  const got = rows(src);
  assert.deepEqual(got, [['description', ['第一行。\n第二行。']], ['title', ['甲']]]);
  assert.match(render(src), /white-space: pre-wrap|class="fm-v"/);
});

test('声明区：`tags` 复用全应用唯一那份标签实现，裸名字不加 `#`', () => {
  const html = render(fm('tags:', '  - 工作'));
  assert.match(html, /<span class="tag-chip">工作<\/span>/);
  assert.equal(html.includes('tag-chip">#'), false, 'YAML 里是裸名字，不替它加 #');
  // 与正文里的同一个类名、同一份实现（不是"另一套看起来像的样式"）
  assert.match(render('#工作'), /<span class="tag-chip">#工作<\/span>/);
});

/* ================= 四、不设白名单 ================= */

test('声明区：认得的字段名一个不改地画出来——不设白名单', () => {
  const src = fm('随便什么名: 值一', '以后新增的字段: 值二', 'anotherKey: 3');
  assert.deepEqual(rows(src), [['随便什么名', ['值一']], ['以后新增的字段', ['值二']], ['anotherKey', ['3']]]);
});

test('声明区：键与值都转义，不给 HTML 注入留口子', () => {
  const html = render(fm('k<img src=x onerror=1>: <b>粗</b>'));
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<b>粗</b>'), false);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /&lt;b&gt;粗&lt;\/b&gt;/);
});

/* ================= 五、纯函数边界 ================= */

test('findFrontmatter：只认开头，且必须闭合', () => {
  assert.deepEqual(findFrontmatter('---\na: 1\n---\n正文'), { raw: 'a: 1', lineCount: 3 });
  assert.equal(findFrontmatter('前言\n---\na: 1\n---\n'), null);
  assert.equal(findFrontmatter('---\na: 1\n正文（没闭合）'), null);
  assert.equal(findFrontmatter('  ---\na: 1\n---\n'), null, '有缩进的 --- 不算');
  assert.deepEqual(findFrontmatter('---\n---\n正文'), { raw: '', lineCount: 2 });
});

test('parseFrontmatterFields：认不出的行跳过，不造假字段', () => {
  assert.deepEqual(parseFrontmatterFields('这不是字段\nkey: 值'), [{ key: 'key', values: ['值'] }]);
});

test('声明区：认不出的行不会让整块消失，也不会多出字段', () => {
  const src = fm('这不是字段', 'key: 值');
  assert.deepEqual(rows(src), [['key', ['值']]]);
});
