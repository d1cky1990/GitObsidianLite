import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import {
  buildWikilinkIndex,
  hydrateWikilinkIndex,
  serializeWikilinkIndex,
  parseWikilink,
  lookupWikilink,
  renderWikilink,
  installWikilinkRule,
} from './wikilinks.js';

// 一棵小树：笔记既有根目录下的，也有子目录里的；非笔记文件用来验「存在但不是笔记」
const TREE = [
  { type: 'blob', path: '日总结/2026-05-08.md' },
  { type: 'blob', path: '工作/周报.md' },
  { type: 'blob', path: 'Aseprite.md' },
  { type: 'blob', path: '重名/同名.md' },
  { type: 'blob', path: '另一个/同名.md' },
  { type: 'blob', path: '附件/图.canvas' },
  { type: 'blob', path: '附件/图.png' },
  { type: 'blob', path: '大纲.base' },
  { type: 'tree', path: '附件' },
];

const index = buildWikilinkIndex(TREE);
const rawUrl = (p) => `/api/raw?path=${encodeURIComponent(p)}`;

test('索引把笔记与非笔记分开，且忽略目录节点', () => {
  assert.equal(index.notes.get('Aseprite'), 'Aseprite.md');
  assert.equal(index.notes.get('周报'), '工作/周报.md');
  assert.equal(index.files.get('图.canvas'), '附件/图.canvas');
  assert.equal(index.notes.has('附件'), false);
  assert.equal(index.files.has('附件'), false);
});

test('重名笔记先到先得（与改动前的 basename 规则一致，可达落点不变）', () => {
  assert.equal(index.notes.get('同名'), '重名/同名.md');
});

test('非 blob 与空路径不进索引', () => {
  const idx = buildWikilinkIndex([
    { type: 'blob', path: '' },
    { type: 'tree', path: '空的' },
    null,
    { type: 'blob' },
  ]);
  assert.equal(idx.notePaths.length, 0);
  assert.equal(idx.filePaths.length, 0);
});

/* ---------- 拆 [[...]] ---------- */

test('拆显式别名', () => {
  assert.deepEqual(parseWikilink('目标|别名'), { target: '目标', label: '别名' });
  assert.deepEqual(parseWikilink('目标|'), { target: '目标', label: '目标' });
  assert.deepEqual(parseWikilink('甲|乙|丙'), { target: '甲', label: '乙' });
});

test('拆标题锚点；标签为空时用锚点文字兜底，不把文字吞掉（#7）', () => {
  assert.deepEqual(parseWikilink('目标#标题'), { target: '目标', label: '目标' });
  assert.deepEqual(parseWikilink('#标题'), { target: '', label: '标题' });
  assert.deepEqual(parseWikilink('#甲#乙'), { target: '', label: '甲#乙' });
  assert.deepEqual(parseWikilink('|别名'), { target: '', label: '别名' });
  assert.deepEqual(parseWikilink('目标#锚|别名'), { target: '目标', label: '别名' });
});

/* ---------- 查目标 ---------- */

test('basename 命中笔记（默认链接格式「能短则短」）', () => {
  assert.deepEqual(lookupWikilink(index, 'Aseprite', 'x.md'), { kind: 'note', path: 'Aseprite.md' });
  assert.deepEqual(lookupWikilink(index, '周报', 'x.md'), { kind: 'note', path: '工作/周报.md' });
});

test('basename 命中仓库文件（目标不是 .md，但确实存在）', () => {
  assert.deepEqual(lookupWikilink(index, '图.canvas', 'x.md'), { kind: 'file', path: '附件/图.canvas' });
  assert.deepEqual(lookupWikilink(index, '大纲.base', 'x.md'), { kind: 'file', path: '大纲.base' });
});

test('仓库根相对路径命中（链接格式设置成「绝对路径」写出来的样子）', () => {
  assert.deepEqual(lookupWikilink(index, '日总结/2026-05-08', '随手记.md'), {
    kind: 'note',
    path: '日总结/2026-05-08.md',
  });
  assert.deepEqual(lookupWikilink(index, '/工作/周报', '随手记.md'), {
    kind: 'note',
    path: '工作/周报.md',
  });
  assert.deepEqual(lookupWikilink(index, '附件/图.canvas', '随手记.md'), {
    kind: 'file',
    path: '附件/图.canvas',
  });
});

test('笔记目录相对命中（链接格式设置成「相对路径」写出来的样子）', () => {
  assert.deepEqual(lookupWikilink(index, '../日总结/2026-05-08', '工作/随手记.md'), {
    kind: 'note',
    path: '日总结/2026-05-08.md',
  });
  assert.deepEqual(lookupWikilink(index, './周报', '工作/随手记.md'), {
    kind: 'note',
    path: '工作/周报.md',
  });
});

test('根相对优先于目录相对（Obsidian 的匹配顺序），两种都不中才判不存在', () => {
  assert.deepEqual(lookupWikilink(index, '工作/周报', '工作/随手记.md'), {
    kind: 'note',
    path: '工作/周报.md',
  });
});

test('带 .md 与不带等价', () => {
  assert.deepEqual(lookupWikilink(index, 'Aseprite.md', 'x.md'), { kind: 'note', path: 'Aseprite.md' });
  assert.deepEqual(lookupWikilink(index, '日总结/2026-05-08.md', 'x.md'), {
    kind: 'note',
    path: '日总结/2026-05-08.md',
  });
});

test('目标不存在 ≠ 目标为空', () => {
  assert.deepEqual(lookupWikilink(index, 'ChatGPT', 'x.md'), { kind: 'missing' });
  // 注意：lookup 收的是**拆好的目标**，不是 [[...]] 的原文——`[[#标题]]` 拆出来目标为空
  assert.deepEqual(lookupWikilink(index, '', 'x.md'), { kind: 'empty' });
  assert.deepEqual(lookupWikilink(index, '   ', 'x.md'), { kind: 'empty' });
});

test('越出仓库根不静默退化（复用 vault-refs 的越根判据）', () => {
  assert.deepEqual(lookupWikilink(index, '../../x', '工作/随手记.md'), { kind: 'missing' });
});

test('索引没拿到时是「不知道」，不是「不存在」', () => {
  assert.deepEqual(lookupWikilink(null, 'Aseprite', 'x.md'), { kind: 'unknown' });
});

test('双链目标是字面字符串，不做百分号解码（与图片引用相反）', () => {
  const idx = buildWikilinkIndex([{ type: 'blob', path: '100%纯.md' }]);
  assert.deepEqual(lookupWikilink(idx, '100%纯', 'x.md'), { kind: 'note', path: '100%纯.md' });
  assert.deepEqual(lookupWikilink(idx, '100%25纯', 'x.md'), { kind: 'missing' });
});

/* ---------- 渲染 ---------- */

test('可达笔记：可点链接，带 data-wikilink', () => {
  const html = renderWikilink(index, 'Aseprite', 'x.md', { rawUrl });
  assert.equal(html, '<a class="wikilink" data-wikilink="Aseprite">Aseprite</a>');
});

test('非笔记文件：走 /api/raw，不再当成「未找到笔记」', () => {
  const html = renderWikilink(index, '图.canvas|那张图', 'x.md', { rawUrl });
  assert.match(html, /class="wikilink wikilink-file"/);
  assert.match(html, /href="\/api\/raw\?path=%E9%99%84%E4%BB%B6%2F%E5%9B%BE\.canvas"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
  assert.match(html, />那张图</);
  // 它已经是真 `<a href>`，不能再挂 data-wikilink——main.js 的点击分支是按这个属性抓的，
  // 挂上就会 preventDefault 之后 window.open 再开一次，同一个文件开两个标签页。
  assert.doesNotMatch(html, /data-wikilink=/);
});

test('目标不存在：渲染成非链接，且带上想指向的目标名', () => {
  const html = renderWikilink(index, 'ChatGPT|那个聊天机器人', 'x.md', { rawUrl });
  assert.equal(html, '<span class="wikilink wikilink-broken" data-wikilink-broken="ChatGPT">那个聊天机器人</span>');
  assert.doesNotMatch(html, /<a /);
});

test('空目标：只留文字，不再渲染成空标签把标题吞掉', () => {
  const html = renderWikilink(index, '#某标题', 'x.md', { rawUrl });
  assert.equal(html, '某标题');
  assert.equal(renderWikilink(index, '|别名', 'x.md', { rawUrl }), '别名');
});

test('索引没拿到：中性可点重试，样子与可达链接不同', () => {
  const html = renderWikilink(null, 'Aseprite', 'x.md', { rawUrl });
  assert.match(html, /class="wikilink wikilink-unknown"/);
  assert.match(html, /data-wikilink="Aseprite"/);
});

test('目标名里的尖括号被转义（不因文件名而注入）', () => {
  const html = renderWikilink(index, '<img src=x>.md|别名', 'x.md', { rawUrl });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-wikilink-broken="&lt;img src=x&gt;\.md"/);
});

/* ---------- 缓存往返 ---------- */

test('序列化只存路径，读回来索引等价', () => {
  const saved = serializeWikilinkIndex(index);
  assert.deepEqual(Object.keys(saved).sort(), ['files', 'notes']);
  assert.equal(saved.notes.includes('工作/周报.md'), true);
  const again = hydrateWikilinkIndex(saved);
  assert.deepEqual(lookupWikilink(again, '周报', 'x.md'), { kind: 'note', path: '工作/周报.md' });
  assert.deepEqual(lookupWikilink(again, '图.canvas', 'x.md'), { kind: 'file', path: '附件/图.canvas' });
  assert.deepEqual(lookupWikilink(again, '工作/周报', 'x.md'), { kind: 'note', path: '工作/周报.md' });
});

test('缓存值坏掉时退化成空索引，不抛', () => {
  const idx = hydrateWikilinkIndex({ notes: '不是数组', files: null });
  assert.deepEqual(lookupWikilink(idx, '周报', 'x.md'), { kind: 'missing' });
  assert.equal(hydrateWikilinkIndex(undefined).notePaths.length, 0);
});

/* ---------- 接到 markdown-it 上 ---------- */

function render(markdown, notePath, idx = index) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installWikilinkRule(md, { getIndex: () => idx, rawUrl });
  return md.render(markdown, { notePath });
}

test('端到端：四种结果各就各位', () => {
  const html = render(
    '可达 [[Aseprite]] / 别名 [[工作/周报|周报]] / 文件 [[图.canvas]] / 断链 [[ChatGPT]] / 空 [[#某标题]]',
    'x.md',
  );
  assert.match(html, /<a class="wikilink" data-wikilink="Aseprite">Aseprite<\/a>/);
  assert.match(html, /<a class="wikilink" data-wikilink="工作\/周报">周报<\/a>/);
  assert.match(html, /class="wikilink wikilink-file"/);
  assert.match(html, /class="wikilink wikilink-broken"/);
  assert.match(html, /空 某标题<\/p>/);
});

test('端到端：#7 第 4 条回归——[[#标题]] 不再渲染成空标签', () => {
  const html = render('见 [[#安装步骤]] 一节', 'x.md');
  assert.doesNotMatch(html, /data-wikilink=""/);
  assert.match(html, /见 安装步骤 一节/);
});

test('端到端：可达链接的行为与改动前一致（仍是 a.wikilink + data-wikilink）', () => {
  assert.equal(render('[[Aseprite]]', 'x.md'), '<p><a class="wikilink" data-wikilink="Aseprite">Aseprite</a></p>\n');
});

test('端到端：索引为 null 时不假装是可达链接', () => {
  const html = render('[[Aseprite]]', 'x.md', null);
  assert.match(html, /wikilink-unknown/);
  assert.doesNotMatch(html, /<a class="wikilink" /);
});
