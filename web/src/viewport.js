// 可见视口与编辑动作区（#65）。
//
// 键盘弹起时，布局视口（window.innerHeight 那一套）往往不变，缩小的是
// visualViewport。贴在布局底部的动作区（保存 / 取消）因此会被键盘盖住，
// 只露一条边甚至完全看不见。这里只算「布局底部被遮住了多少」，由
// initViewport 把它写进 :root 的 --vv-inset；CSS 让编辑动作区随它上移。
//
// **侧栏底部「新建 / 设置」横条是例外，固定不动**（design-brief §6 第 6 条、
// #55 决议第四节）：它不读这个变量，两者绝不写成同一套。把横条也顶上去会
// 压缩搜索结果的可见面积，是用户明确否掉的方案。
//
// 本模块只改一个 CSS 变量，**不 render、不换任何输入框节点**（§6 第 1 条：
// 输入法组字中换掉节点会当场断掉）。真键盘、真拼音输入法、逐帧白屏、
// 明暗两套视觉留真机 / 真浏览器验。

/** 写到 :root 的 CSS 变量名；样式段只让下面的 FOLLOWERS 读它。 */
export const INSET_VAR = '--vv-inset';

/** 跟随可见视口的目标：只有编辑动作区。 */
export const VIEWPORT_FOLLOWERS = Object.freeze(['.edit-actions']);
/** 明确不跟随的目标：侧栏底部「新建 / 设置」横条，固定不动。 */
export const VIEWPORT_EXCLUDED = Object.freeze(['.sidebar-foot']);

/**
 * 布局底部被遮住的像素数：
 *
 *   innerHeight − (visualViewport.offsetTop + visualViewport.height)
 *
 * 没有 visualViewport（老浏览器 / node 单测）时按 0；异常、非法、负值输入
 * 一律夹到 0，绝不返回负数。小数（高 DPI 常见）保留精度，不擅自取整。
 */
export function computeBottomInset({ innerHeight = 0, visualViewport = null } = {}) {
  if (!visualViewport) return 0;
  const h = Number(visualViewport.height);
  const top = Number(visualViewport.offsetTop) || 0;
  const ih = Number(innerHeight) || 0;
  if (!Number.isFinite(h) || h <= 0) return 0;
  const inset = ih - (top + h);
  return Number.isFinite(inset) && inset > 0 ? inset : 0;
}

/**
 * DOM 接线：监听 visualViewport 的 resize / scroll 与 window.resize，每次重算
 * inset 并写到 documentElement 的 --vv-inset。**只改这一个变量**，不碰
 * .sidebar-foot、不换任何输入框节点。依赖 window / document 全部可注入，
 * 便于 node 单测换假的；无 DOM 时安全退化为 null，不抛。
 */
export function initViewport(deps = {}) {
  const win = deps.window || (typeof window !== 'undefined' ? window : null);
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  if (!win || !doc || !doc.documentElement ||
      typeof doc.documentElement.style?.setProperty !== 'function') return null;
  const root = doc.documentElement;
  const vv = win.visualViewport || null;

  function sync() {
    const inset = computeBottomInset({
      innerHeight: win.innerHeight,
      visualViewport: vv ? { height: vv.height, offsetTop: vv.offsetTop } : null,
    });
    root.style.setProperty(INSET_VAR, inset + 'px');
    return inset;
  }

  if (vv && typeof vv.addEventListener === 'function') {
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
  }
  if (typeof win.addEventListener === 'function') win.addEventListener('resize', sync);
  sync();
  return { sync };
}
