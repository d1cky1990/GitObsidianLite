// 编辑态守卫（#61 建接口占位 / #65 填充实现）。
//
// 两个跨票导出名不许改：isLocked() / guardExitEdit()。
//   - isLocked()      —— 编辑 / 冲突态锁死侧栏；#66 据此把三个文件动作置灰但仍能按。
//   - guardExitEdit() —— 有改动要退出编辑时先问「放弃改动？」，返回是否放行。
//
// 这一层只有纯规则 + 可注入依赖的守卫，不碰 DOM、不碰网络、不发请求。
// main.js 在接线处 configureEditorGuard({...}) 注入真实的 mode / 草稿基准 / 确认框；
// 单测用 createEditorGuard(假依赖) 把每条分支走一遍。DOM 交互、真输入法组字、
// 可见视口、明暗两套视觉留真浏览器 / 真机（wave2-brief「测试接缝」）。

/** 逐字定过的文案集中一处（design-brief 附录 C），HTML 与提示都读它，别散进分支。 */
export const EDIT_COPY = Object.freeze({
  updated: '远端已更新，已自动加载最新内容',
  unreadable: '连不上，读不到最新内容',
  gone: '这篇在远端已经不在了',
  discard: '放弃改动？',
  lockedHint: '先保存或取消，再看别的',
  fileOpsHint: '先保存或取消，再改文件',
});

export const SAVE_COPY = Object.freeze({
  saved: '已保存',
  merged: '合并已保存',
  unresolved: '还有差异未处理',
  offline: '连不上，没保存上',
  gone: '这篇不在了，没保存上',
  other: '没保存上',
});

/* ---------- 1. 锁死侧栏 ---------- */

/** 编辑 / 冲突态锁死侧栏；阅读 / 目录 / 空状态不锁。 */
export function isLockedMode(mode) {
  return mode === 'edit' || mode === 'conflict';
}

/* ---------- 3. 未保存保护 ---------- */

/** 草稿与「进入编辑那一刻」的基准逐字比；null / undefined 都当空串归一。 */
export function hasUnsavedChanges(draft, baseline) {
  return String(draft == null ? '' : draft) !== String(baseline == null ? '' : baseline);
}

/** 退出编辑是否放行：没改动直接放行；有改动只有确认「放弃改动？」才放行。 */
export function discardDecision({ dirty = false, confirmed = false } = {}) {
  return !dirty || confirmed === true;
}

/* ---------- 2. 进编辑前先读远端最新版 ---------- */

/**
 * 进编辑前那次远端核对的结果（工单 2，作废旧规矩「读取失败照常进编辑态」）。
 * 只有「版本号没变 / 变了」两种进编辑；读不到、不在了、要密码一律停在阅读态。
 * enterEdit 让接线层不必再散着判一遍。
 */
export function classifyEditRead({ err = null, fresh = null, currentSha = '' } = {}) {
  if (err) {
    // 要密码：api.js 已派发 need-password 弹解锁框，背后不再喊「连不上」
    if (err.auth) return { kind: 'auth', fresh: null, message: '', enterEdit: false };
    if (err.notFound) return { kind: 'gone', fresh: null, message: EDIT_COPY.gone, enterEdit: false };
    return { kind: 'unreadable', fresh: null, message: EDIT_COPY.unreadable, enterEdit: false };
  }
  if (!fresh) return { kind: 'unreadable', fresh: null, message: EDIT_COPY.unreadable, enterEdit: false };
  if (fresh.sha === currentSha) {
    // 一个字不提示，直接进编辑
    return { kind: 'unchanged', fresh, message: '', enterEdit: true };
  }
  // 换成最新再进，并提示那句；同步换 sha，避免下一次保存必然报假冲突
  return { kind: 'updated', fresh, message: EDIT_COPY.updated, enterEdit: true };
}

/* ---------- 5. 保存失败分类 ---------- */

/**
 * 只有「撞远端改动且拿得到 remote 正文」才是冲突（进冲突态、草稿不丢）。
 * 连不上 / 这篇不在了 / 其它各说各的，**绝不许说成冲突**；要密码不背后喊。
 */
export function classifySaveError(e) {
  const err = e || {};
  if (err.conflict && err.remote) {
    return { kind: 'conflict', remote: err.remote, message: '' };
  }
  if (err.notFound) return { kind: 'gone', message: SAVE_COPY.gone };
  if (err.auth) return { kind: 'auth', message: '' };
  // fetch 抛的 TypeError 没有 status；5xx 也归「连不上」。两者都不是冲突
  const status = err.status;
  const offline = status == null || (typeof status === 'number' && status >= 500);
  if (offline) return { kind: 'offline', message: SAVE_COPY.offline };
  return { kind: 'other', message: err.message || SAVE_COPY.other };
}

/* ---------- 7. 提示条时长 ---------- */

/** 普通 2.5 秒、带一个动作 8 秒；不带动作绝不给 8 秒。 */
export function toastDuration(action) {
  return action ? 8000 : 2500;
}

/* ---------- 6. 冲突链条 ---------- */

/** 冲突 → 编辑 → 阅读，每次只退一层；不退回目录、不回空状态（C-4）。 */
export function nextModeOnBack(mode) {
  if (mode === 'conflict') return 'edit';
  return 'read';
}

/* ---------- 可注入依赖的守卫 ---------- */

/**
 * 工厂：getMode / getDirty / confirm 全由外部注入，便于单测与跨票接线。
 * confirm 缺省用原生 window.confirm（文案逐字取 EDIT_COPY.discard）；node 无 DOM 时
 * 返回 false，绝不误弹系统框。没改动时**不调** confirm，避免多出一次无谓的打断。
 */
export function createEditorGuard(deps = {}) {
  const getMode = typeof deps.getMode === 'function' ? deps.getMode : () => 'read';
  const getDirty = typeof deps.getDirty === 'function' ? deps.getDirty : () => false;
  const confirmDiscard = typeof deps.confirm === 'function'
    ? deps.confirm
    : (msg) => (typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? !!window.confirm(msg) : false);
  return {
    isLocked() { return isLockedMode(getMode()); },
    guardExitEdit() {
      const dirty = !!getDirty();
      // 文案由守卫拥有，注入的确认框只管收下并回答，不必自己再抄一遍
      const confirmed = dirty ? !!confirmDiscard(EDIT_COPY.discard) : true;
      return discardDecision({ dirty, confirmed });
    },
  };
}

// 模块级单例：#66 只调 isLocked()，#65 的接线只调 configureEditorGuard 一次。
let _guard = createEditorGuard();

/** main.js 唯一接线入口：注入真实状态读取与「放弃改动？」确认框。 */
export function configureEditorGuard(deps) {
  _guard = createEditorGuard(deps);
  return _guard;
}

/** 测试间恢复默认（不锁、无改动、退出放行）。 */
export function resetEditorGuard() {
  _guard = createEditorGuard();
  return _guard;
}

export function isLocked() { return _guard.isLocked(); }
export function guardExitEdit() { return _guard.guardExitEdit(); }
