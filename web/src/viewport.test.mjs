// viewport.js 的几何 / 接线测试（#65）。
//
// 接缝：纯几何 + 可注入假 window / document 的接线层。真键盘弹起、真拼音输入法、
// 逐帧白屏、明暗两套视觉留真机 / 真浏览器（wave2-brief「测试接缝」）。
//
// 钉的是工单第 4 条与 §6 第 6 条：动作区按**可见视口**摆，不能假设「页面高度
// = 屏幕高度」；侧栏底部「新建 / 设置」横条是例外、固定不动，绝不写成同一套。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INSET_VAR, VIEWPORT_FOLLOWERS, VIEWPORT_EXCLUDED,
  computeBottomInset, initViewport,
} from './viewport.js';

/* ---------- 纯几何：布局底部被遮住了多少 ---------- */

test('computeBottomInset：没有 visualViewport（老浏览器 / node）时按 0，不假设页面高度=屏幕高度', () => {
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: null }), 0);
  assert.equal(computeBottomInset({ innerHeight: 844 }), 0);
  assert.equal(computeBottomInset(), 0);
});

test('computeBottomInset：键盘弹起 = innerHeight − (offsetTop + height)', () => {
  // 844 的屏，键盘占掉底部 344：可见视口高 500、贴顶
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: 500, offsetTop: 0 } }), 344);
  // 页面被顶上去 44（地址栏收起等）：被遮住的是 844 − (44 + 500) = 300
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: 500, offsetTop: 44 } }), 300);
});

test('computeBottomInset：键盘收起（可见视口=布局视口）时回到 0，动作区位置复原', () => {
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } }), 0);
  assert.equal(computeBottomInset({ innerHeight: 700, visualViewport: { height: 700, offsetTop: 0 } }), 0);
});

test('computeBottomInset：异常 / 非法取值一律夹到 0，绝不返回负数', () => {
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: 1000, offsetTop: 0 } }), 0);
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: 500, offsetTop: 900 } }), 0);
  assert.equal(computeBottomInset({ innerHeight: 0, visualViewport: { height: 500 } }), 0);
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: NaN } }), 0);
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: 0 } }), 0);
  assert.equal(computeBottomInset({ innerHeight: 844, visualViewport: { height: -10 } }), 0);
  assert.equal(computeBottomInset({ innerHeight: NaN, visualViewport: { height: 500 } }), 0);
  // 小数（高 DPI 下常见）保留精度，不擅自取整
  assert.equal(computeBottomInset({ innerHeight: 844.5, visualViewport: { height: 500.25, offsetTop: 0 } }), 344.25);
});

/* ---------- 「两者不是同一套」：动作区随动，横条固定不动 ---------- */

test('VIEWPORT_FOLLOWERS 只含编辑动作区，明确不含侧栏底部横条', () => {
  assert.ok(VIEWPORT_FOLLOWERS.includes('.edit-actions'));
  assert.ok(!VIEWPORT_FOLLOWERS.includes('.sidebar-foot'));
  assert.ok(VIEWPORT_EXCLUDED.includes('.sidebar-foot'));
  assert.ok(!VIEWPORT_EXCLUDED.includes('.edit-actions'));
  // 两个集合不许有交集：把横条也顶上去是用户明确否掉的方案
  const overlap = VIEWPORT_FOLLOWERS.filter((s) => VIEWPORT_EXCLUDED.includes(s));
  assert.deepEqual(overlap, []);
});

/* ---------- 接线层：只写 --vv-inset，不换任何输入框节点 ---------- */

/** 假环境：记录 root.style.setProperty 的每次调用、收集注册的事件回调。 */
function fakeEnv({ innerHeight = 844, metrics = { height: 500, offsetTop: 0 } } = {}) {
  const calls = [];
  const listeners = {};
  const root = { style: { setProperty: (k, v) => calls.push([k, v]) } };
  const on = (scope) => (type, fn) => { (listeners[scope + ':' + type] ||= []).push(fn); };
  const vv = metrics === null ? null : {
    get height() { return metrics.height; },
    get offsetTop() { return metrics.offsetTop; },
    addEventListener: on('vv'),
  };
  const win = { innerHeight, visualViewport: vv, addEventListener: on('win') };
  const doc = { documentElement: root };
  return { win, doc, calls, listeners, metrics };
}

test('initViewport：把 inset 写进 :root 的 --vv-inset，且只写这一个变量', () => {
  const env = fakeEnv();
  const ctl = initViewport({ window: env.win, document: env.doc });
  assert.ok(ctl, '注入完整环境时返回控制器');
  assert.equal(INSET_VAR, '--vv-inset');
  assert.deepEqual(env.calls, [['--vv-inset', '344px']], '首次同步算出被遮住的 344px');
});

test('initViewport：visualViewport 的 resize / scroll 与 window.resize 都重算', () => {
  const env = fakeEnv();
  initViewport({ window: env.win, document: env.doc });
  assert.ok(env.listeners['vv:resize'], '监听 visualViewport resize');
  assert.ok(env.listeners['vv:scroll'], '监听 visualViewport scroll');
  assert.ok(env.listeners['win:resize'], '监听 window resize');

  env.metrics.height = 844; // 键盘收起：可见视口回到整屏
  env.listeners['vv:resize'][0]();
  assert.equal(env.calls.at(-1)[1], '0px', '收起后动作区位置复原');

  env.metrics.height = 400; // 键盘更高
  env.listeners['vv:scroll'][0]();
  assert.equal(env.calls.at(-1)[1], '444px');

  env.metrics.height = 600;
  env.listeners['win:resize'][0]();
  assert.equal(env.calls.at(-1)[1], '244px');
  // 全程只碰 --vv-inset，不碰 .sidebar-foot、不换任何节点
  assert.ok(env.calls.every(([k]) => k === '--vv-inset'));
});

test('initViewport：sync() 可手动调用，返回当次算出的 inset', () => {
  const env = fakeEnv({ metrics: { height: 600, offsetTop: 0 } });
  const ctl = initViewport({ window: env.win, document: env.doc });
  assert.equal(ctl.sync(), 244);
  assert.equal(env.calls.at(-1)[1], '244px');
});

test('initViewport：没有 visualViewport 时退化为 0，仍不报错', () => {
  const env = fakeEnv({ metrics: null });
  const ctl = initViewport({ window: env.win, document: env.doc });
  assert.ok(ctl);
  assert.deepEqual(env.calls, [['--vv-inset', '0px']]);
});

test('initViewport：node 无 window / document 时安全返回 null（不抛）', () => {
  assert.equal(initViewport({ window: null, document: { documentElement: { style: { setProperty() {} } } } }), null);
  assert.equal(initViewport({ window: {}, document: null }), null);
  assert.equal(initViewport(), null);
});
