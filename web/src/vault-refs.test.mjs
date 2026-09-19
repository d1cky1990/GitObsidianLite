import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import {
  resolveVaultRef,
  installVaultImageRule,
  brokenImageHtml,
  pickVaultImagePath,
  runtimeFailureReason,
  BROKEN_IMAGE_CLASS,
  PENDING_IMAGE_CLASS,
} from './vault-refs.js';
import { buildWikilinkIndex } from './wikilinks.js';

const vault = (notePath, ref) => resolveVaultRef(notePath, ref);

test('相对当前笔记所在目录解析', () => {
  assert.deepEqual(vault('a.md', 'images/x.png'), { kind: 'vault', path: 'images/x.png' });
  assert.deepEqual(vault('notes/sub/a.md', 'images/x.png'), { kind: 'vault', path: 'notes/sub/images/x.png' });
  assert.deepEqual(vault('notes/sub/a.md', './images/x.png'), { kind: 'vault', path: 'notes/sub/images/x.png' });
});

test('../ 上跳一级、多级', () => {
  assert.deepEqual(vault('notes/sub/a.md', '../assets/x.png'), { kind: 'vault', path: 'notes/assets/x.png' });
  assert.deepEqual(vault('a/b/c/d.md', '../../../x.png'), { kind: 'vault', path: 'x.png' });
});

test('以 / 开头按 vault 根相对（不是相对笔记目录）', () => {
  assert.deepEqual(vault('notes/sub/a.md', '/assets/x.png'), { kind: 'vault', path: 'assets/x.png' });
});

test('越出仓库根判为失败，不静默退化成根相对', () => {
  assert.deepEqual(vault('a.md', '../x.png'), { kind: 'invalid', reason: 'escape-root' });
  assert.deepEqual(vault('notes/a.md', '../../x.png'), { kind: 'invalid', reason: 'escape-root' });
  assert.deepEqual(vault('a.md', '/../x.png'), { kind: 'invalid', reason: 'escape-root' });
});

test('空引用判为失败', () => {
  assert.deepEqual(vault('a.md', ''), { kind: 'invalid', reason: 'empty' });
  assert.deepEqual(vault('a.md', '   '), { kind: 'invalid', reason: 'empty' });
  assert.deepEqual(vault('a.md', '/'), { kind: 'invalid', reason: 'empty' });
  assert.deepEqual(vault('a.md', './'), { kind: 'invalid', reason: 'empty' });
});

test('外部地址与后端接口原样放行', () => {
  for (const ref of [
    'https://a.com/x.png',
    'http://a.com/x.png',
    '//cdn.a.com/x.png',
    'data:image/png;base64,AAAA',
    '/api/raw?path=x.png',
  ]) {
    assert.equal(vault('notes/a.md', ref).kind, 'external', ref);
  }
});

test('百分号编码解回真实文件名（避免二次编码）', () => {
  assert.deepEqual(vault('a.md', 'images/%E4%B8%AD%E6%96%87.png'), { kind: 'vault', path: 'images/中文.png' });
  assert.deepEqual(vault('a.md', 'assets/%E5%B8%A6%20%E7%A9%BA%E6%A0%BC.png'), {
    kind: 'vault',
    path: 'assets/带 空格.png',
  });
  // 解不开的百分号按原样处理，不该抛
  assert.deepEqual(vault('a.md', 'x%zz.png'), { kind: 'vault', path: 'x%zz.png' });
});

test('反斜杠按分隔符处理（Obsidian 在 Windows 上会留 \\)', () => {
  assert.deepEqual(vault('notes/sub/a.md', 'images\\x.png'), { kind: 'vault', path: 'notes/sub/images/x.png' });
});

/* ---------- 相对解析失败后按文件名反查（#8） ---------- */

// 用真的 buildWikilinkIndex 建索引，不手搓一个「长得像索引」的对象——反查是这两个
// 模块的接缝，接缝只有用真实形状才测得出「它们其实对得上」。
const TREE = [
  { type: 'blob', path: 'assets/image_1683881602423_0.png' },
  { type: 'blob', path: 'assets/别的附件.png' },
  { type: 'blob', path: '工作/已到位.png' },
  { type: 'blob', path: '重名/同名.png' },
  { type: 'blob', path: '另一个/同名.png' },
  { type: 'blob', path: '一篇笔记.md' },
  { type: 'tree', path: 'assets' },
];
const index = buildWikilinkIndex(TREE);

test('反查：裸文件名（Obsidian 粘贴图的默认写法）落到 assets/ 下', () => {
  assert.equal(
    pickVaultImagePath(index, '工作/image_1683881602423_0.png'),
    'assets/image_1683881602423_0.png',
  );
  // 根目录笔记里写裸文件名也一样
  assert.equal(pickVaultImagePath(index, 'image_1683881602423_0.png'), 'assets/image_1683881602423_0.png');
});

test('反查：带目录却找错位置（根相对的写法写在子目录笔记里）', () => {
  assert.equal(pickVaultImagePath(index, '工作/assets/别的附件.png'), 'assets/别的附件.png');
});

test('路径在索引里本来就有：原样返回，可开的落点一律不变', () => {
  assert.equal(pickVaultImagePath(index, '工作/已到位.png'), '工作/已到位.png');
});

test('重名取树序第一个，与双链的 basename 规则同一条', () => {
  assert.equal(pickVaultImagePath(index, '随手记/同名.png'), '重名/同名.png');
});

test('反查也未命中：不改判，把请求原样发出去让真实的 404 如实报', () => {
  assert.equal(pickVaultImagePath(index, '工作/真没有.png'), '工作/真没有.png');
});

test('索引没拿到：同样维持现状（中性态由 404 分支负责，不在这里凭空判定）', () => {
  assert.equal(pickVaultImagePath(null, '工作/image_1683881602423_0.png'), '工作/image_1683881602423_0.png');
  assert.equal(pickVaultImagePath(undefined, '工作/已到位.png'), '工作/已到位.png');
});

test('反查只认非笔记文件：同名 .md 不会被当成图片拿去用', () => {
  // `.md` 走的是 notes 那份映射，files 里没有它 → 命不中 → 不改判
  assert.equal(pickVaultImagePath(index, '随手记/一篇笔记.md'), '随手记/一篇笔记.md');
});

test('中性占位的文案不指控「文件不存在」，也不共用断图的样式', () => {
  const html = brokenImageHtml({ reason: 'pending', ref: 'x.png' });
  assert.match(html, new RegExp(PENDING_IMAGE_CLASS));
  assert.doesNotMatch(html, /文件不存在/);
  assert.doesNotMatch(html, new RegExp(BROKEN_IMAGE_CLASS));
  assert.match(html, /<code>x\.png<\/code>/);
});

test('运行期取图失败：只有库内引用才可能「还在确认位置」', () => {
  // 库内引用 + 名单没到手 → 还有救，不能说死
  assert.equal(runtimeFailureReason({ vaultPath: '工作/x.png', indexReady: false }), 'pending');
  // 库内引用 + 名单已到手 → 反查已经跑过了，确实没有
  assert.equal(runtimeFailureReason({ vaultPath: '工作/x.png', indexReady: true }), 'missing');
  // 外链 / 解析即失败的写法：没有 data-vault-path，等名单也不会改变结果
  assert.equal(runtimeFailureReason({ vaultPath: '', indexReady: false }), 'missing');
  assert.equal(runtimeFailureReason({ vaultPath: '', indexReady: true }), 'missing');
  assert.equal(runtimeFailureReason({ indexReady: false }), 'missing');
});

test('「还在确认位置」的那句话不该出现「不存在」二字（无条件中性态是错的）', () => {
  const pending = brokenImageHtml({ reason: runtimeFailureReason({ vaultPath: 'a/x.png', indexReady: false }), ref: 'a/x.png' });
  assert.match(pending, new RegExp(PENDING_IMAGE_CLASS));
  const ext = brokenImageHtml({ reason: runtimeFailureReason({ vaultPath: '', indexReady: false }), ref: 'https://a.com/x.png' });
  assert.match(ext, new RegExp(BROKEN_IMAGE_CLASS));
  assert.match(ext, /文件不存在/);
});

/* ---------- 接到 markdown-it 上 ---------- */

function render(markdown, notePath, idx = null) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installVaultImageRule(md, {
    rawUrl: (p) => `/api/raw?path=${encodeURIComponent(p)}`,
    getIndex: () => idx,
  });
  return md.render(markdown, { notePath });
}

test('图片 src 改写成 raw 代理地址，并带上 data-vault-path', () => {
  const html = render('![](images/x.png)', 'notes/sub/a.md');
  assert.match(html, /src="\/api\/raw\?path=notes%2Fsub%2Fimages%2Fx\.png"/);
  assert.match(html, /data-vault-path="notes\/sub\/images\/x\.png"/);
});

test('根目录笔记的写法不变', () => {
  const html = render('![](images/x.png)', 'a.md');
  assert.match(html, /src="\/api\/raw\?path=images%2Fx\.png"/);
});

test('外部图片不动，也不带 data-vault-path', () => {
  const html = render('![](https://a.com/x.png)', 'notes/sub/a.md');
  assert.match(html, /src="https:\/\/a\.com\/x\.png"/);
  assert.doesNotMatch(html, /data-vault-path/);
});

test('解析失败就地给出可见提示，而不是留一张裂图', () => {
  const html = render('![](../../x.png)', 'notes/a.md');
  assert.match(html, new RegExp(BROKEN_IMAGE_CLASS));
  assert.match(html, /相对路径越出仓库根/);
  assert.match(html, /<code>\.\.\/\.\.\/x\.png<\/code>/);
  assert.doesNotMatch(html, /<img/);
});

test('提示里的引用做了转义（不因文件名带尖括号而注入）', () => {
  const html = render('![](%3Cimg%3E.png)', 'a.md');
  assert.doesNotMatch(html, /<img>/);
  assert.equal(brokenImageHtml({ reason: 'missing', ref: '<b>x</b>' }).includes('<b>'), false);
});

test('端到端：索引到位后，裸文件名引用指向 assets/ 下的真图（#8 的主场景）', () => {
  const html = render('![](image_1683881602423_0.png)', '工作/随手记.md', index);
  assert.match(html, /src="\/api\/raw\?path=assets%2Fimage_1683881602423_0\.png"/);
  assert.match(html, /data-vault-path="assets\/image_1683881602423_0\.png"/);
});

test('端到端：索引未到位时引用原样发请求（不假装、不改判）', () => {
  const html = render('![](image_1683881602423_0.png)', '工作/随手记.md', null);
  assert.match(html, /data-vault-path="工作\/image_1683881602423_0\.png"/);
  assert.doesNotMatch(html, /assets/);
});

test('端到端：索引到位也不动能开的那条（落点不变）', () => {
  const withIndex = render('![](已到位.png)', '工作/随手记.md', index);
  assert.equal(withIndex, render('![](已到位.png)', '工作/随手记.md', null));
  assert.match(withIndex, /data-vault-path="工作\/已到位\.png"/);
});

test('端到端：外链与后端接口引用不进反查，也不带 data-vault-path', () => {
  const html = render('![](https://a.com/x.png)\n\n![](/api/raw?path=y.png)', '工作/随手记.md', index);
  assert.match(html, /src="https:\/\/a\.com\/x\.png"/);
  assert.doesNotMatch(html, /data-vault-path/);
});
