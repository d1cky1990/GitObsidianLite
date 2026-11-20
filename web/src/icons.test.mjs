// icons.js 的规则测试。
//
// 图标全部内联自绘 SVG：viewBox 0 0 24 24、线宽 1.5、currentColor、离线可用。
// 不用图标字体、emoji、外部请求。这里钉的是形状契约，不是某个路径好不好看。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ICONS, ICON_NAMES, icon } from './icons.js';

test('图标清单齐：§8.2 列的十六枚都在', () => {
  const expected = [
    'sidebar-open', 'close', 'clear', 'search', 'settings', 'new-note', 'back', 'more',
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

/* ---------- 评审修复第 5 条：正文顶栏⋯与旧列表页图标改用自绘 SVG 的形状契约 ---------- */

test('评审修复第5条：⋯/关闭/新建/笔记/文件夹/返回都是自绘 SVG，不夹带字符图标', () => {
  for (const name of ['more', 'close', 'new-note', 'note', 'folder', 'back']) {
    const svg = icon(name);
    assert.match(svg, /^<svg /, `${name} 应是内联 SVG`);
    assert.match(svg, /viewBox="0 0 24 24"/, `${name} 用统一画布`);
    assert.doesNotMatch(svg, /<img|<image|https?:|@font-face|class="fa/i, `${name} 不该引外部资源`);
    for (const ch of ['⋯', '¶', '▸', '＋', '×', '·', '☰', '✕', '✓', '⚙']) {
      assert.ok(!svg.includes(ch), `${name} 不该用字符 ${ch} 当图标`);
    }
  }
  // 「更多」是三个实心圆点的自绘 SVG，不是字符 ⋯
  const more = icon('more');
  assert.match(more, /<circle/);
  assert.ok(!more.includes('⋯'));
});

/* ---------- #69：齿轮读得出是齿轮、新建是纸身内加号、两枚叉只差大小 ---------- */

test('#69 三枚图标的形状契约（§8.2 路径原文）', () => {
  const gear = ICONS['settings'];
  // 外轮廓是一条闭合路径，不是放射线堆——旧版八根短线，20px 下像一颗太阳
  assert.equal((gear.match(/<path /g) || []).length, 1, '齿轮外轮廓是一条闭合路径');
  assert.match(gear, /Z"/, '外轮廓闭合');
  assert.match(gear, /<circle cx="12" cy="12" r="3"\/>/, '中心圆孔半径 3px、圆心在正中心');
  assert.doesNotMatch(gear, /M12 2\.6v2\.2/, '不许用放射线代替齿轮');

  const fresh = ICONS['new-note'];
  assert.equal((fresh.match(/<path /g) || []).length, 2, '纸身 + 折角两条曲线');
  assert.equal((fresh.match(/<line /g) || []).length, 2, '加号是纸身内一横一竖两条直线');
  assert.match(fresh, /M7\.875 3 L13\.5 3 L19\.125 8\.625/, '纸身 x 4.875~19.125、折角在右上');
  // 加号两条线都落在纸身内部（x 4.875~19.125 / y 3~21），不是纸旁另挂一个
  assert.match(fresh, /<line x1="12" y1="11\.625" x2="12" y2="17\.625"\/>/);
  assert.match(fresh, /<line x1="9" y1="14\.625" x2="15" y2="14\.625"\/>/);

  const clear = ICONS['clear'], close = ICONS['close'];
  assert.match(clear, /M7\.5 7\.5l9 9/, '清空叉端点距边 7.5px');
  assert.match(close, /M6 6l12 12/, '关闭叉端点距边 6px，比清空叉大一号');
  assert.notEqual(clear, close, '两枚叉不是同一个图形定义');
});
