import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import {
  resolveVaultRef,
  installVaultImageRule,
  brokenImageHtml,
  BROKEN_IMAGE_CLASS,
} from './vault-refs.js';

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

/* ---------- 接到 markdown-it 上 ---------- */

function render(markdown, notePath) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  installVaultImageRule(md, { rawUrl: (p) => `/api/raw?path=${encodeURIComponent(p)}` });
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
