// editor-guard.js 的规则测试（#65 填充；替换 #61 的占位契约测试）。
//
// 接缝：这一层全是纯规则 + 可注入依赖的守卫，不碰 DOM、不碰网络。
// 用 node --test + import 被测模块本身整体跑；DOM 交互 / 真输入法 / 可见视口
// 留真浏览器与真机（wave2-brief「测试接缝」）。
//
// 钉的是工单「要做的」7 条里能纯化的部分：
//   1 锁死侧栏（编辑 / 冲突态）  2 进编辑读远端三分类
//   3 未保存保护（放弃改动？）   5 保存失败不许互相冒充
//   6 冲突链条退一层             7 提示条时长（普通 2.5s / 带动作 8s）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDIT_COPY, SAVE_COPY,
  isLockedMode, hasUnsavedChanges, discardDecision,
  classifyEditRead, classifySaveError, toastDuration, nextModeOnBack,
  createEditorGuard, configureEditorGuard, resetEditorGuard,
  isLocked, guardExitEdit,
} from './editor-guard.js';

/* ---------- 占位契约回归：导出名、默认值、布尔、不抛 ---------- */

test('契约：两个导出都是函数，默认不锁、退出编辑放行，返回布尔且不抛', () => {
  resetEditorGuard();
  assert.equal(typeof isLocked, 'function');
  assert.equal(typeof guardExitEdit, 'function');
  assert.equal(typeof isLocked(), 'boolean');
  assert.equal(isLocked(), false, '默认阅读态不锁死侧栏');
  assert.equal(typeof guardExitEdit(), 'boolean');
  assert.equal(guardExitEdit(), true, '默认没有改动，退出编辑直接放行');
});

/* ---------- 1. 锁死侧栏：编辑 / 冲突态 ---------- */

test('isLockedMode：只有编辑态与冲突态锁死侧栏，阅读 / 目录 / 空值都不锁', () => {
  assert.equal(isLockedMode('edit'), true);
  assert.equal(isLockedMode('conflict'), true);
  assert.equal(isLockedMode('read'), false);
  assert.equal(isLockedMode('list'), false);
  assert.equal(isLockedMode(''), false);
  assert.equal(isLockedMode(undefined), false);
  assert.equal(isLockedMode(null), false);
});

/* ---------- 3. 未保存保护：「改过东西」的判定 ---------- */

test('hasUnsavedChanges：草稿与进入编辑时的基准逐字比，一字不差才算没改', () => {
  assert.equal(hasUnsavedChanges('原文', '原文'), false);
  assert.equal(hasUnsavedChanges('原文', '原文\n'), true);
  assert.equal(hasUnsavedChanges('', ''), false);
  assert.equal(hasUnsavedChanges('加了字', ''), true);
  // null / undefined 都当空串归一，不把「没内容」判成有改动
  assert.equal(hasUnsavedChanges(undefined, null), false);
  assert.equal(hasUnsavedChanges(0, '0'), false);
});

test('discardDecision：没改动直接放行；有改动只有确认才放行，取消就留编辑态', () => {
  assert.equal(discardDecision({ dirty: false, confirmed: false }), true);
  assert.equal(discardDecision({ dirty: false, confirmed: true }), true);
  assert.equal(discardDecision({ dirty: true, confirmed: true }), true, '确认放弃 → 放行');
  assert.equal(discardDecision({ dirty: true, confirmed: false }), false, '取消 → 留编辑态');
});

test('createEditorGuard：没改动不弹「放弃改动？」；有改动才问，且按回答放行', () => {
  const asked = [];
  const confirm = (msg) => { asked.push(msg); return true; };
  let mode = 'edit', dirty = false;
  const g = createEditorGuard({ getMode: () => mode, getDirty: () => dirty, confirm });

  assert.equal(g.isLocked(), true);
  dirty = false;
  assert.equal(g.guardExitEdit(), true, '没改动：直接放行');
  assert.equal(asked.length, 0, '没改动不许弹确认框');

  dirty = true;
  assert.equal(g.guardExitEdit(), true, '有改动 + 确认 → 放行');
  assert.deepEqual(asked, [EDIT_COPY.discard], '问的必须是逐字定过的「放弃改动？」');
});

test('createEditorGuard：有改动选「留在编辑态」时不放行，草稿交由调用方原样保留', () => {
  const g = createEditorGuard({ getMode: () => 'edit', getDirty: () => true, confirm: () => false });
  assert.equal(g.guardExitEdit(), false);
});

test('createEditorGuard：isLocked 跟着注入的 mode 实时变（不是构造时快照）', () => {
  let mode = 'read';
  const g = createEditorGuard({ getMode: () => mode, getDirty: () => false, confirm: () => false });
  assert.equal(g.isLocked(), false);
  mode = 'edit';
  assert.equal(g.isLocked(), true);
  mode = 'conflict';
  assert.equal(g.isLocked(), true);
  mode = 'read';
  assert.equal(g.isLocked(), false);
});

test('单例：configureEditorGuard 注入后 isLocked / guardExitEdit 生效，reset 回默认', () => {
  resetEditorGuard();
  assert.equal(isLocked(), false);
  configureEditorGuard({ getMode: () => 'conflict', getDirty: () => true, confirm: () => false });
  assert.equal(isLocked(), true);
  assert.equal(guardExitEdit(), false);
  configureEditorGuard({ getMode: () => 'read', getDirty: () => false, confirm: () => false });
  assert.equal(isLocked(), false);
  assert.equal(guardExitEdit(), true);
  resetEditorGuard();
  assert.equal(isLocked(), false);
});

/* ---------- 2. 进编辑前先读远端最新版 ---------- */

test('classifyEditRead：版本号没变 → 直接进编辑、一个字不提示', () => {
  const v = classifyEditRead({ err: null, fresh: { sha: 's1', content: '原文' }, currentSha: 's1' });
  assert.equal(v.kind, 'unchanged');
  assert.equal(v.message, '');
  assert.equal(v.fresh.content, '原文');
});

test('classifyEditRead：版本号变了 → 换最新再进，提示那句逐字文案', () => {
  const fresh = { sha: 's2', content: '远端新正文' };
  const v = classifyEditRead({ err: null, fresh, currentSha: 's1' });
  assert.equal(v.kind, 'updated');
  assert.equal(v.message, '远端已更新，已自动加载最新内容');
  assert.equal(v.message, EDIT_COPY.updated);
  assert.equal(v.fresh, fresh, '换的就是读回来的最新版');
});

test('classifyEditRead：读不到 → 不进编辑，明说连不上（给重试），不再「照常放进编辑态」', () => {
  const v = classifyEditRead({ err: new Error('Failed to fetch'), fresh: null, currentSha: 's1' });
  assert.equal(v.kind, 'unreadable');
  assert.ok(v.message.includes('连不上'));
  assert.equal(v.message, EDIT_COPY.unreadable);
  assert.equal(v.enterEdit, false);
});

test('classifyEditRead：这篇不在了单独说「不在了」，不冒充「连不上」', () => {
  const e = new Error('404'); e.notFound = true;
  const v = classifyEditRead({ err: e, fresh: null, currentSha: 's1' });
  assert.equal(v.kind, 'gone');
  assert.ok(v.message.includes('不在了'));
  assert.equal(v.enterEdit, false);
});

test('classifyEditRead：要密码时不进编辑、也不在解锁框背后再喊一句', () => {
  const e = new Error('401'); e.auth = true;
  const v = classifyEditRead({ err: e, fresh: null, currentSha: 's1' });
  assert.equal(v.kind, 'auth');
  assert.equal(v.message, '');
  assert.equal(v.enterEdit, false);
});

test('classifyEditRead：五种结果都带 enterEdit（只有 unchanged / updated 放行）', () => {
  const fresh = { sha: 's1', content: 'x' };
  assert.equal(classifyEditRead({ fresh, currentSha: 's1' }).enterEdit, true);
  assert.equal(classifyEditRead({ fresh: { sha: 's2' }, currentSha: 's1' }).enterEdit, true);
  assert.equal(classifyEditRead({ err: new Error('x') }).enterEdit, false);
});

/* ---------- 5. 保存失败：不许互相冒充，尤其不许说成冲突 ---------- */

test('classifySaveError：撞远端改动（conflict + remote）才是冲突，草稿不能丢', () => {
  const e = new Error('409'); e.conflict = true; e.remote = { sha: 's9', content: '远端' };
  const v = classifySaveError(e);
  assert.equal(v.kind, 'conflict');
  assert.equal(v.remote, e.remote);
});

test('classifySaveError：连不上 / 这篇不在了各说各的，都不许说成冲突', () => {
  const offline = classifySaveError(new TypeError('Failed to fetch'));
  assert.equal(offline.kind, 'offline');
  assert.ok(offline.message.includes('连不上'));
  assert.ok(!offline.message.includes('冲突'));

  const gone = new Error('404'); gone.notFound = true;
  const g = classifySaveError(gone);
  assert.equal(g.kind, 'gone');
  assert.ok(g.message.includes('不在了'));
  assert.ok(!g.message.includes('冲突'));

  const server = new Error('500'); server.status = 500;
  assert.equal(classifySaveError(server).kind, 'offline', '服务端 5xx 归「连不上」');
});

test('classifySaveError：其它失败用原话，要密码不背后喊；带 conflict 但没 remote 不算冲突', () => {
  const other = classifySaveError(Object.assign(new Error('配额满了'), { status: 400 }));
  assert.equal(other.kind, 'other');
  assert.equal(other.message, '配额满了');
  assert.ok(!other.message.includes('冲突'));

  const auth = new Error('401'); auth.auth = true;
  assert.equal(classifySaveError(auth).kind, 'auth');

  const fake = new Error('409'); fake.conflict = true; // 没带 remote 正文
  assert.notEqual(classifySaveError(fake).kind, 'conflict', '拿不到远端正文就进不了冲突态');
});

test('SAVE_COPY / EDIT_COPY：几处逐字定过的文案集中一处，别散进分支', () => {
  assert.equal(EDIT_COPY.updated, '远端已更新，已自动加载最新内容');
  assert.equal(EDIT_COPY.discard, '放弃改动？');
  assert.equal(EDIT_COPY.fileOpsHint, '先保存或取消，再改文件');
  assert.equal(SAVE_COPY.saved, '已保存');
  assert.equal(SAVE_COPY.merged, '合并已保存');
  assert.equal(SAVE_COPY.unresolved, '还有差异未处理');
});

/* ---------- 7. 提示条时长：不带动作不许传 8 秒 ---------- */

test('toastDuration：普通 2.5 秒、带一个动作 8 秒；不带动作绝不给 8 秒', () => {
  assert.equal(toastDuration(null), 2500);
  assert.equal(toastDuration(undefined), 2500);
  assert.equal(toastDuration({ label: '撤销' }), 8000);
  assert.notEqual(toastDuration(null), 8000);
});

/* ---------- 6. 冲突链条：每次只退一层 ---------- */

test('nextModeOnBack：冲突 → 编辑 → 阅读，每次退一层，不退回目录 / 空状态', () => {
  assert.equal(nextModeOnBack('conflict'), 'edit');
  assert.equal(nextModeOnBack('edit'), 'read');
  assert.equal(nextModeOnBack('read'), 'read');
  assert.equal(nextModeOnBack(undefined), 'read');
});
