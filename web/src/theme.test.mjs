// theme.js 的规则测试。
//
// 主题只有一个真相：本机存 light / dark / system 三档，缺省 system；最终写进
// <html data-theme> 的只有解析后的 light / dark 两档。system 时还要跟着系统外观变。
// 这些是纯逻辑（存储与 DOM 都是可注入的边界），所以能在 node --test 里钉住。
//
// 与 web/index.html <head> 里那段内联定色脚本互为镜像：存储键、三档取值、
// system 的解析方式，任一处改了另一处必须同改（见 theme.js 顶部注释）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  THEME_KEY, THEME_VALUES, getThemePreference, setThemePreference, applyTheme,
} from './theme.js';

function mockStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

function mockRoot() {
  return { dataset: {}, style: {} };
}

// 可手动触发 change 的 matchMedia 桩，用来验 system 档跟随系统外观。
function mockMatchMedia(darkInitially) {
  let matches = darkInitially;
  const listeners = new Set();
  const mql = {
    get matches() { return matches; },
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    _fire(v) { matches = v; for (const fn of listeners) fn({ matches: v }); },
    get _listenerCount() { return listeners.size; },
  };
  return mql;
}

test('契约：存储键与三档取值是定值，供 index.html 内联脚本镜像对账', () => {
  assert.equal(THEME_KEY, 'gitobsidianlite.theme');
  assert.deepEqual(THEME_VALUES, ['light', 'dark', 'system']);
});

test('getThemePreference：缺省、坏值、非法值都回落到 system', () => {
  assert.equal(getThemePreference(mockStorage()), 'system');
  assert.equal(getThemePreference(mockStorage({ [THEME_KEY]: '' })), 'system');
  assert.equal(getThemePreference(mockStorage({ [THEME_KEY]: 'neon' })), 'system');
  // 存储本身读不了（隐私模式 / 配额）也不许抛
  const broken = { getItem() { throw new Error('blocked'); }, setItem() {} };
  assert.equal(getThemePreference(broken), 'system');
});

test('getThemePreference：三档合法值原样返回', () => {
  for (const v of ['light', 'dark', 'system']) {
    assert.equal(getThemePreference(mockStorage({ [THEME_KEY]: v })), v);
  }
});

test('setThemePreference：只写合法三档，非法值归一为 system', () => {
  const s = mockStorage();
  for (const v of ['light', 'dark', 'system']) {
    assert.equal(setThemePreference(v, s), v);
    assert.equal(s.getItem(THEME_KEY), v);
  }
  assert.equal(setThemePreference('neon', s), 'system');
  assert.equal(s.getItem(THEME_KEY), 'system');
  // setItem 抛异常也要兜住，不把启动流程带崩
  const broken = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal(setThemePreference('dark', broken), 'dark');
});

test('applyTheme：light / dark 直接落到 data-theme 与 color-scheme', () => {
  for (const pref of ['light', 'dark']) {
    const root = mockRoot();
    const got = applyTheme({ storage: mockStorage({ [THEME_KEY]: pref }), matchMedia: () => mockMatchMedia(true), root });
    assert.equal(got, pref);
    assert.equal(root.dataset.theme, pref);
    assert.equal(root.style.colorScheme, pref);
  }
});

test('applyTheme：system 时按系统外观解析，只写 light / dark', () => {
  const darkRoot = mockRoot();
  assert.equal(applyTheme({ storage: mockStorage({ [THEME_KEY]: 'system' }), matchMedia: () => mockMatchMedia(true), root: darkRoot }), 'dark');
  assert.equal(darkRoot.dataset.theme, 'dark');
  assert.equal(darkRoot.style.colorScheme, 'dark');

  const lightRoot = mockRoot();
  assert.equal(applyTheme({ storage: mockStorage({ [THEME_KEY]: 'system' }), matchMedia: () => mockMatchMedia(false), root: lightRoot }), 'light');
  assert.equal(lightRoot.dataset.theme, 'light');

  // 完全没有 matchMedia（老环境）时按浅色兜底，不抛
  const noMmRoot = mockRoot();
  assert.equal(applyTheme({ storage: mockStorage({ [THEME_KEY]: 'system' }), matchMedia: undefined, root: noMmRoot }), 'light');
  assert.equal(noMmRoot.dataset.theme, 'light');
});

test('applyTheme：system 档监听系统外观变化，变化立刻改 data-theme', () => {
  const mql = mockMatchMedia(false);
  const root = mockRoot();
  applyTheme({ storage: mockStorage({ [THEME_KEY]: 'system' }), matchMedia: () => mql, root });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(mql._listenerCount, 1);

  mql._fire(true);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  mql._fire(false);
  assert.equal(root.dataset.theme, 'light');
});

test('applyTheme：离开 system 档后撤掉监听，且重复 apply 不叠监听', () => {
  const mql = mockMatchMedia(false);
  const store = mockStorage({ [THEME_KEY]: 'system' });
  const root = mockRoot();
  const opts = { storage: store, matchMedia: () => mql, root };
  applyTheme(opts);
  applyTheme(opts); // 幂等
  assert.equal(mql._listenerCount, 1);

  store.setItem(THEME_KEY, 'dark');
  applyTheme(opts);
  assert.equal(mql._listenerCount, 0, '切到固定档后不该再跟着系统变');
  assert.equal(root.dataset.theme, 'dark');
  mql._fire(true); // 即便此刻系统变了，固定 dark 也不该被改回
  assert.equal(root.dataset.theme, 'dark');
});
