// icons.js 的规则测试。
//
// 图标全部内联自绘 SVG：viewBox 0 0 24 24、线宽 1.5、currentColor、离线可用。
// 不用图标字体、emoji、外部请求。这里钉的是形状契约，不是某个路径好不好看。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ICONS, ICON_NAMES, icon } from './icons.js';

test('图标清单齐：§8.2 列的十五枚都在', () => {
  const expected = [
    'sidebar-open', 'close', 'search', 'settings', 'new-note', 'back', 'more',
    'chevron-right', 'chevron-down', 'folder', 'note', 'invalid', 'warning', 'error', 'success',
  ];
  for (const name of expected) {
    assert.equal(typeof ICONS[name], 'string', `缺图标 ${name}`);
    assert.ok(ICONS[name].length > 0, `图标 ${name} 不能是空路径`);
  }
  assert.deepEqual([...ICON_NAMES].sort(), [...expected].sort());
});

test('icon() 产出合规内联 SVG，尺寸可传', () => {
  const svg = icon('close');
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /stroke-width="1\.5"/);
  assert.match(svg, /stroke-linecap="round"/);
  assert.match(svg, /stroke-linejoin="round"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /width="20"/);
  assert.match(svg, /height="20"/);

  const big = icon('search', 22);
  assert.match(big, /width="22"/);
  assert.match(big, /height="22"/);
});

test('图标离线可用：无外链、无图标字体、无 emoji、无位图', () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    assert.doesNotMatch(svg, /https?:|url\(|<image|<img|@font-face|class="fa/i, `${name} 不该引外部资源`);
    for (const ch of ['✕', '＋', '⚙', '▸', '✓', '·']) {
      assert.ok(!svg.includes(ch), `${name} 不该用字符/emoji 当图标`);
    }
  }
});

test('未知图标名返回空串，不画一个坏占位', () => {
  assert.equal(icon('does-not-exist'), '');
  assert.equal(icon(''), '');
});
