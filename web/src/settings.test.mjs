// settings.js 的规则测试（#63）。
//
// 工单 #63 设置面板里能从 DOM / 网络抽出来的纯逻辑：新建落点读写归一（跨票接口，
// #66 用）、黑白三档即时生效、关于文案（取不到提交号只显示版本号）、三块面板 HTML、
// 「指定目录不在了」核对三态与两条出路。断言的是行为 / 文案 / 结构，不是重算实现。
// DOM 接线、真刷新首帧、主题两套视觉留真浏览器 / 真机验。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THEME_KEY, THEME_VALUES, getThemePreference } from './theme.js';
import {
  TARGET_KEY, DEFAULT_TARGET, TARGET_MODES, THEME_OPTIONS, APP_VERSION, NEW_TARGET_COPY,
  normalizeTarget, getNewNoteTarget, setNewNoteTarget, selectTheme,
  formatAbout, readBuildCommit, settingsHtml,
  classifyDirProbe, verifyNewNoteTarget, newNoteTargetIssueHtml,
} from './settings.js';

function mockStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}
function mockRoot() { return { dataset: {}, style: {} }; }
function mockMatchMedia(darkInitially) {
  return {
    matches: darkInitially,
    addEventListener() {}, removeEventListener() {},
  };
}

/* ---------- 契约常量 ---------- */

test('契约：新建落点键 / 默认档 / 两档取值 / 主题三档 / 版本号是定值', () => {
  assert.equal(TARGET_KEY, 'gitobsidianlite.newNoteTarget.v1');
  assert.deepEqual(DEFAULT_TARGET, { mode: 'selected', dir: '' });
  assert.deepEqual(TARGET_MODES, ['selected', 'fixed']);
  assert.deepEqual(THEME_OPTIONS.map((o) => o.value), THEME_VALUES, '黑白三档与 theme.js 同一套取值');
  assert.equal(APP_VERSION, '0.1.0');
  assert.equal(THEME_KEY, 'gitobsidianlite.theme');
});

/* ---------- 新建落点：读写、归一、坏值、写失败不抛（跨票接口 get/set） ---------- */

test('normalizeTarget：只收 selected / fixed，坏值一律回落到默认档', () => {
  assert.deepEqual(normalizeTarget(null), DEFAULT_TARGET);
  assert.deepEqual(normalizeTarget(undefined), DEFAULT_TARGET);
  assert.deepEqual(normalizeTarget('fixed'), DEFAULT_TARGET, '字符串不算 fixed 对象');
  assert.deepEqual(normalizeTarget({ mode: 'neon', dir: 'x' }), DEFAULT_TARGET);
  assert.deepEqual(normalizeTarget({ mode: 'fixed', dir: 123 }), { mode: 'fixed', dir: '' }, 'dir 非字符串清空');
  assert.deepEqual(normalizeTarget({ mode: 'fixed', dir: '日记/2026' }), { mode: 'fixed', dir: '日记/2026' });
  // 返回的是新对象，不共享 DEFAULT_TARGET 引用
  const a = normalizeTarget(null);
  a.dir = 'polluted';
  assert.deepEqual(normalizeTarget(null), DEFAULT_TARGET, '默认档未被污染');
});

test('getNewNoteTarget：本机没存过 → 默认「选中的文件夹」', () => {
  assert.deepEqual(getNewNoteTarget(mockStorage()), DEFAULT_TARGET);
});

test('getNewNoteTarget：坏 JSON / 非法值都回落默认档；存储读不了不抛', () => {
  assert.deepEqual(getNewNoteTarget(mockStorage({ [TARGET_KEY]: '{bad json' })), DEFAULT_TARGET);
  assert.deepEqual(getNewNoteTarget(mockStorage({ [TARGET_KEY]: '42' })), DEFAULT_TARGET);
  assert.deepEqual(getNewNoteTarget(mockStorage({ [TARGET_KEY]: JSON.stringify({ mode: 'neon' }) })), DEFAULT_TARGET);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() {} };
  assert.deepEqual(getNewNoteTarget(broken), DEFAULT_TARGET);
});

test('setNewNoteTarget / getNewNoteTarget：fixed 档往返，dir 原样保留', () => {
  const s = mockStorage();
  const t = setNewNoteTarget({ mode: 'fixed', dir: '日记/2026' }, s);
  assert.deepEqual(t, { mode: 'fixed', dir: '日记/2026' });
  assert.deepEqual(getNewNoteTarget(s), { mode: 'fixed', dir: '日记/2026' });
  // 改回默认档
  assert.deepEqual(setNewNoteTarget({ mode: 'selected', dir: 'x' }, s), DEFAULT_TARGET);
  assert.deepEqual(getNewNoteTarget(s), DEFAULT_TARGET);
});

test('setNewNoteTarget：非法值归一为默认档；写失败不抛、仍返回归一值', () => {
  const s = mockStorage();
  assert.deepEqual(setNewNoteTarget({ mode: 'neon' }, s), DEFAULT_TARGET);
  assert.deepEqual(getNewNoteTarget(s), DEFAULT_TARGET);
  const broken = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.deepEqual(setNewNoteTarget({ mode: 'fixed', dir: 'x' }, broken), { mode: 'fixed', dir: 'x' });
});

/* ---------- 黑白三档：选完立刻生效、不确认、当前档一眼看得出 ---------- */

test('selectTheme：三档都写进本机记录并立刻落到 data-theme / color-scheme（不刷新、不确认）', () => {
  for (const pref of ['light', 'dark']) {
    const s = mockStorage();
    const root = mockRoot();
    assert.equal(selectTheme(pref, { storage: s, root, matchMedia: () => mockMatchMedia(true) }), pref);
    assert.equal(s.getItem(THEME_KEY), pref);
    assert.equal(root.dataset.theme, pref, '立刻生效：data-theme 当帧就写');
    assert.equal(root.style.colorScheme, pref);
    assert.equal(getThemePreference(s), pref);
  }
});

test('selectTheme：system 档按系统外观解析，非法值归一 system', () => {
  const s = mockStorage();
  const root = mockRoot();
  const v = selectTheme('system', { storage: s, root, matchMedia: () => mockMatchMedia(true) });
  assert.equal(v, 'system');
  assert.equal(s.getItem(THEME_KEY), 'system');
  assert.equal(root.dataset.theme, 'dark', 'system + 系统深色 → 深色');

  const s2 = mockStorage();
  const root2 = mockRoot();
  assert.equal(selectTheme('neon', { storage: s2, root: root2, matchMedia: () => mockMatchMedia(false) }), 'system');
  assert.equal(s2.getItem(THEME_KEY), 'system');
  assert.equal(root2.dataset.theme, 'light');
});

/* ---------- 关于：版本号 + 提交短号；取不到只显示版本号、不让构建失败 ---------- */

test('formatAbout：有提交号 → 版本号 · 短号；取不到 → 只显示版本号', () => {
  assert.equal(formatAbout({ version: '0.1.0', commit: '3f9c2a1' }), '0.1.0 · 3f9c2a1');
  assert.equal(formatAbout({ version: '0.1.0', commit: '' }), '0.1.0');
  assert.equal(formatAbout({ version: '0.1.0', commit: '   ' }), '0.1.0');
  assert.equal(formatAbout(), '0.1.0', '缺省参数也不抛');
  assert.equal(formatAbout({ version: '2.0', commit: 'abc' }), '2.0 · abc');
});

test('readBuildCommit：node 无构建注入时返回空串、不抛（构建取不到号也不许失败）', () => {
  const c = readBuildCommit();
  assert.equal(typeof c, 'string');
  assert.equal(c, '', '未注入 __APP_COMMIT__ 时为空串');
});

/* ---------- 设置面板：只装三块、当前档可见、选 fixed 才露目录、返回目录、不装多余开关 ---------- */

test('settingsHtml：三块齐全（黑白分段 / 新建落点 / 关于）+ 自带「‹ 返回目录」', () => {
  const html = settingsHtml({ theme: 'system', target: DEFAULT_TARGET, version: '0.1.0', commit: '3f9c2a1' });
  assert.ok(html.includes('settings-theme'), '黑白模式块在');
  assert.ok(html.includes('settings-target'), '新建落点块在');
  assert.ok(html.includes('settings-about'), '关于块在');
  assert.ok(html.includes('0.1.0 · 3f9c2a1'), '版本号 + 提交短号在');
  assert.ok(html.includes('data-settings-back'), '面板自带「返回目录」');
});

test('settingsHtml：黑白三档分段选择器，当前档一眼看得出（只有一个 aria-pressed=true）', () => {
  const html = settingsHtml({ theme: 'dark', target: DEFAULT_TARGET });
  for (const v of ['light', 'dark', 'system']) {
    assert.ok(html.includes('data-theme-opt="' + v + '"'), '档位 ' + v + ' 在');
  }
  // 全文有两组分段（主题 / 新建落点），各有一个当前档；这里只数主题那一段。
  const themeBlock = html.slice(html.indexOf('settings-theme'), html.indexOf('settings-target'));
  assert.equal((themeBlock.match(/aria-pressed="true"/g) || []).length, 1, '主题分段里只有一个当前档');
  assert.ok(/data-theme-opt="dark"[^>]*aria-pressed="true"/.test(themeBlock), 'dark 是当前档');
  assert.ok(html.includes('is-active'), '当前档另有边框/底色类，不只靠颜色');
});

test('settingsHtml：新建落点两档，当前档标出；选 fixed 才露「是哪个目录」和入口', () => {
  const selected = settingsHtml({ theme: 'light', target: { mode: 'selected', dir: '' } });
  assert.ok(selected.includes('data-target-mode="selected"'));
  assert.ok(selected.includes('data-target-mode="fixed"'));
  assert.ok(!selected.includes('data-target-dir'), '默认档不露指定目录入口');

  const fixed = settingsHtml({ theme: 'light', target: { mode: 'fixed', dir: '日记/2026' } });
  assert.ok(fixed.includes('data-target-dir'), 'fixed 档才露目录');
  assert.ok(fixed.includes('日记/2026'), '露出的是哪个目录');
  assert.ok(/data-target-mode="fixed"[^>]*aria-pressed="true"/.test(fixed), 'fixed 是当前档');
});

test('settingsHtml：不装访问密码、不装「连的是哪个仓库」', () => {
  const html = settingsHtml({ theme: 'light', target: DEFAULT_TARGET });
  assert.ok(!html.includes('访问密码'));
  assert.ok(!html.includes('连的是哪个仓库'));
});

test('settingsHtml：dir / version / commit 做 HTML 转义，防注入', () => {
  const bad = '"><script>alert(1)</script>';
  const html = settingsHtml({ theme: 'light', target: { mode: 'fixed', dir: bad }, version: bad, commit: bad });
  assert.ok(!html.includes('<script>'), '没有裸 script');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&quot;'));
});

/* ---------- 指定目录核对：一次轻请求、三态互不冒充、不追改名搬家 ---------- */

test('classifyDirProbe：非空数组=在 / 空数组=不在了 / 问不到=连不上', () => {
  assert.equal(classifyDirProbe({ ok: true, entries: [{ name: 'a.md' }] }), 'ok');
  assert.equal(classifyDirProbe({ ok: true, entries: [] }), 'missing');
  assert.equal(classifyDirProbe({ ok: true, entries: null }), 'missing');
  assert.equal(classifyDirProbe({ ok: false, error: new Error('fetch failed') }), 'offline');
  assert.equal(classifyDirProbe(null), 'offline');
  assert.equal(classifyDirProbe({ ok: false, error: { status: 404 } }), 'offline',
    '断网/要密码/服务端报错一律说连不上，不许说找不到');
});

test('verifyNewNoteTarget：默认档（选中的文件夹）不核对、不发起请求', async () => {
  let calls = 0;
  const r = await verifyNewNoteTarget(DEFAULT_TARGET, { probe: () => { calls += 1; return []; } });
  assert.equal(r.kind, 'ok');
  assert.equal(calls, 0, 'selected 档不该去问目录在不在');
});

test('verifyNewNoteTarget：fixed 档只问一次那一层，在/不在/连不上三态', async () => {
  const t = { mode: 'fixed', dir: '日记/2026' };
  let calls = 0;
  let seen = null;
  const probe = (dir) => { calls += 1; seen = dir; return [{ name: 'a.md' }]; };
  const ok = await verifyNewNoteTarget(t, { probe });
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.dir, '日记/2026');
  assert.equal(calls, 1, '只一次轻请求，不追改名搬家');
  assert.equal(seen, '日记/2026', '问的就是指定那一层');

  const missing = await verifyNewNoteTarget(t, { probe: () => [] });
  assert.equal(missing.kind, 'missing', '空数组 = 那一层不在了');
  const offline = await verifyNewNoteTarget(t, { probe: () => { throw new Error('offline'); } });
  assert.equal(offline.kind, 'offline', '请求失败 = 连不上');
});

test('verifyNewNoteTarget：没注入 probe 不猜、归连不上；坏 target 回落默认档不核对', async () => {
  assert.equal((await verifyNewNoteTarget({ mode: 'fixed', dir: 'x' }, {})).kind, 'offline');
  assert.equal((await verifyNewNoteTarget(null, { probe: () => [] })).kind, 'ok');
});

/* ---------- 两条出路文案：不在了给两条，断网只说连不上、不冒充 ---------- */

test('NEW_TARGET_COPY：不在了 / 连不上 / 两条出路是定值、语气合规', () => {
  assert.equal(NEW_TARGET_COPY.missing, '指定的目录不在了');
  assert.ok(NEW_TARGET_COPY.offline.includes('连不上'));
  assert.ok(!NEW_TARGET_COPY.offline.includes('找不到'));
  assert.equal(NEW_TARGET_COPY.fixGeneric, '去设置改通用路径');
  assert.equal(NEW_TARGET_COPY.fixHere, '就在这里改这一次');
  for (const v of Object.values(NEW_TARGET_COPY)) assert.ok(!/[!！]/.test(v));
});

test('newNoteTargetIssueHtml(missing)：当场报错 + 两条出路，不喊连不上', () => {
  const html = newNoteTargetIssueHtml('missing', '日记/2026');
  assert.ok(html.includes('指定的目录不在了'));
  assert.ok(html.includes('去设置改通用路径'));
  assert.ok(html.includes('就在这里改这一次'));
  assert.ok(html.includes('data-target-fix="settings"') && html.includes('data-target-fix="here"'));
  assert.ok(!html.includes('连不上'), '「不在了」不冒充「连不上」');
  assert.ok(html.includes('日记/2026'), '带着指定目录供两条出路使用');
});

test('newNoteTargetIssueHtml(offline)：说连不上、不说找不到/不在了、不给两条出路', () => {
  const html = newNoteTargetIssueHtml('offline', 'x');
  assert.ok(html.includes('连不上'));
  assert.ok(!html.includes('找不到'));
  assert.ok(!html.includes('指定的目录不在了'));
  assert.ok(!html.includes('data-target-fix='), '断网不给「不在了」那两条出路');
});

test('newNoteTargetIssueHtml(ok)：没问题时不落任何报错', () => {
  assert.equal(newNoteTargetIssueHtml('ok', 'x'), '');
  assert.equal(newNoteTargetIssueHtml('whatever', 'x'), '');
});
