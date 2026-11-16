// render-states.js 的规则测试（#64）。
//
// 工单 #64「空状态与阅读态四档失败」可单测的那层：纯 HTML 生成 + 失败分档。
// 断言的是行为 / 文案 / 结构（附录 C 定稿字面、视觉规范类名），不是重算实现；
// 不碰 DOM、不碰网络、不碰正文渲染插件。真浏览器的落位、明暗两套视觉留真机。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_PROMPT, READ_COPY, INVALID_LABEL, REMOVE_LABEL, GONE_MESSAGE,
  PENDING_CLASSES, BROKEN_CLASSES,
  escapeHtml, classifyReadError, recentItemHtml, emptyStateHtml, readingStateHtml,
} from './render-states.js';

/* ---------- 空状态：首次无记录仍完整、不像出错、不转圈 ---------- */

test('emptyStateHtml：第一次用一条记录都没有 → 完整提示 + 留白，不像出错、不转圈', () => {
  const html = emptyStateHtml({ recents: [] });
  assert.match(html, /class="empty-state"/, '有完整的空状态容器');
  assert.ok(html.includes(escapeHtml(EMPTY_PROMPT)), '一句主提示在');
  // 不像还在加载：没有转圈 / 骨架 / 核对中 / 加载字样
  assert.ok(!/spinner|skeleton|shimmer|loading|read-loading/i.test(html), '不显示任何加载态');
  assert.ok(!html.includes('核对中'), '不显示「核对中」');
  assert.ok(!/class="[^"]*(danger|error|is-invalid)/i.test(html), '不像出错了（没有危险/错误整块）');
  assert.ok(!html.includes('recent-item'), '没有可列的最近条目');
  assert.ok(!html.includes('只存在这台设备'), '界面上不交代「只存在这台设备」');
});

test('EMPTY_PROMPT：语气直说、不喊口号、不用感叹号、不交代本机', () => {
  assert.ok(EMPTY_PROMPT.length > 0);
  assert.ok(!/[!！]/.test(EMPTY_PROMPT), '不用感叹号');
  assert.ok(!/只存在这台设备|本机|缓存/.test(EMPTY_PROMPT));
});

test('emptyStateHtml：有记录 → 名字 + 一行浅色父目录，最多 5 条', () => {
  const recents = [
    '日记/2026/05-14.md', '日记/2025/05-14.md', 'a.md', 'b/c.md', 'd.md',
  ];
  const html = emptyStateHtml({ recents });
  const items = html.match(/class="recent-item"/g) || [];
  assert.equal(items.length, 5, '正好 5 条');
  assert.ok(html.includes('05-14.md'), '名字在');
  assert.ok(html.includes('日记/2026') && html.includes('日记/2025'), '112 组同名靠父目录分得开');
  assert.ok(html.includes('class="recent-parent"'), '父目录是单独一行（浅色由 CSS 定）');
  // 超过 5 条要截断，防止调用方塞了更多
  const capped = emptyStateHtml({ recents: [...recents, 'extra.md'] });
  assert.equal((capped.match(/class="recent-item"/g) || []).length, 5, '超过 5 条截断到 5');
});

test('emptyStateHtml：只有确认真不在的那条标「已失效」，且不整条变红', () => {
  const html = emptyStateHtml({
    recents: ['gone.md', 'ok.md'],
    invalid: ['gone.md'],
  });
  assert.ok(html.includes(INVALID_LABEL), '「已失效」文字在');
  assert.ok(html.includes('class="recent-invalid"'), '标注落在内层 12px 危险色 span 上');
  assert.ok(html.includes('data-recent-invalid="1"'), '已失效条目可被点击重新核对');
  assert.ok(html.includes('data-recent-path="gone.md"'), '带上路径供重新核对');
  // 不整条变红：外层链接仍是普通 recent-item，没有整条危险色类
  assert.ok(!/class="recent-item[^"]*(danger|is-invalid|broken)/.test(html), '整条不加危险色类');
  // 只标那一条，没被标的不带标注
  assert.equal((html.match(/data-recent-invalid="1"/g) || []).length, 1, '只有确认真不在的那条被标');
  assert.equal((html.match(/class="recent-invalid"/g) || []).length, 1, '「已失效」只出现一次');
  assert.ok(html.includes('data-recent-path="ok.md"'), '正常条目也在、仍可点');
  // 名字与父目录都保留
  assert.ok(html.includes('gone.md') || html.includes('根目录'), '原名 / 父目录仍在');
});

/* ---------- 最近打开单条：转义、可点、同名分得开 ---------- */

test('recentItemHtml：路径做 HTML 转义，防注入', () => {
  const bad = 'a/"><script>alert(1)</script>.md';
  const html = recentItemHtml({ path: bad });
  assert.ok(!html.includes('<script>'), '危险标签被转义，没有裸 script');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&quot;'), '尖括号 / 引号被转义');
});

test('recentItemHtml：名字 + 父目录，同名不同父目录分得开', () => {
  const a = recentItemHtml({ path: '日记/2026/05-14.md' });
  const b = recentItemHtml({ path: '日记/2025/05-14.md' });
  assert.ok(a.includes('05-14.md') && a.includes('日记/2026'));
  assert.ok(b.includes('05-14.md') && b.includes('日记/2025'));
  assert.notEqual(a, b, '两条同名靠父目录区分，HTML 不同');
  assert.ok(a.includes('href="#/edit/'), '普通条目点开走阅读态');
});

test('escapeHtml：五种字符都转义', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

/* ---------- 阅读态失败分档：三档互不冒充 ---------- */

test('classifyReadError：要密码 / 这篇不在了 / 连不上，三档互不冒充', () => {
  assert.equal(classifyReadError({ auth: true, status: 401 }), 'password');
  assert.equal(classifyReadError({ status: 401 }), 'password', '401 一律当作要密码');
  assert.equal(classifyReadError({ notFound: true, status: 404 }), 'missing');
  assert.equal(classifyReadError({ status: 404 }), 'missing');
  assert.equal(classifyReadError({ status: 500 }), 'offline', '服务端报错 ≠ 这篇不在了');
  assert.equal(classifyReadError(new TypeError('Failed to fetch')), 'offline', '断网 = 连不上');
});

test('readingStateHtml(loading)：R-1 一小段加载，不是空白、不整屏骨架乱跳', () => {
  const html = readingStateHtml('loading', { path: 'a.md' });
  assert.match(html, /class="read-state read-loading"/);
  assert.ok(html.includes(READ_COPY.loading), '有一句加载说明');
  assert.ok(!/spinner|skeleton|shimmer/i.test(html), '没有整屏骨架 / 闪烁动画');
  assert.ok(html.trim().length > 0, '不是空白页');
  assert.ok(!html.includes('连不上') && !html.includes('不在了'), '加载态不冒充任何失败');
});

test('readingStateHtml(missing)：R-3 明说「这篇不在了」，不喊连不上', () => {
  const html = readingStateHtml('missing', { path: 'a.md' });
  assert.match(html, /read-missing/);
  assert.ok(html.includes('这篇不在了，可能被改名或删掉了'), '附录 C 定稿字面');
  assert.ok(!html.includes('连不上'), '不冒充 R-4');
  assert.ok(html.includes('href="#/"'), '给一条回到空状态的路');
});

test('readingStateHtml(offline)：R-4 明说「连不上」，给重试，不喊不在了', () => {
  const html = readingStateHtml('offline', { path: '日记/a.md' });
  assert.match(html, /read-offline/);
  assert.ok(html.includes('连不上'), '说连不上');
  assert.ok(!html.includes('不在了') && !html.includes('找不到'), '不冒充 R-3 / 不说「没有」');
  assert.ok(html.includes('data-read-retry="日记/a.md"'), '重试带着原来那篇的路径');
  assert.ok(html.includes('重试'), '有重试动作');
});

test('readingStateHtml(password)：要密码直接弹解锁框，背后不喊没连上', () => {
  const html = readingStateHtml('password', { path: 'a.md' });
  assert.equal(html, '', '要密码这一档不落任何阅读失败文案');
  assert.ok(!html.includes('连不上'), '不在解锁框背后再喊一句没连上');
  assert.ok(!html.includes('不在了'));
});

test('READ_COPY：三档文案两两不同，语气合规；R-2 中性态与失败态分得开', () => {
  assert.equal(READ_COPY.missing, GONE_MESSAGE, 'R-3 与点已失效确认不在用同一句定稿');
  assert.equal(REMOVE_LABEL, '从列表里去掉', '附录 C 定稿动作');
  assert.notEqual(READ_COPY.loading, READ_COPY.missing);
  assert.notEqual(READ_COPY.missing, READ_COPY.offline);
  assert.notEqual(READ_COPY.loading, READ_COPY.offline);
  assert.equal(READ_COPY.pending, '文件名单还在加载…', 'R-2 名单未到的中性说明照抄附录 C');
  assert.ok(!/找不到|确实没有|连不上/.test(READ_COPY.pending), '中性态不冒充「确实找不到」或「连不上」');
  for (const v of Object.values(READ_COPY)) {
    assert.ok(!/[!！]/.test(v), '没有感叹号：' + v);
  }
  // 中性占位（名单未到）与「确实找不到」用的是两套不相交的类，明暗两套才分得开
  assert.ok(PENDING_CLASSES.includes('img-pending') && PENDING_CLASSES.includes('wikilink-unknown'));
  assert.ok(BROKEN_CLASSES.includes('img-broken') && BROKEN_CLASSES.includes('wikilink-broken'));
  for (const c of PENDING_CLASSES) assert.ok(!BROKEN_CLASSES.includes(c), c + ' 不与失败态共用类');
});
