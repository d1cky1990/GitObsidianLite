// 侧栏搜索：放大镜 ↔ 输入框的点/滑规则、四态、结果与落位（#63）。
//
// 这一层只做纯逻辑与 HTML 字符串：不碰 DOM 事件、不发请求、不碰正文渲染插件。
// 真正把输入框展开/收起、只切 hidden、接线点滑与结果刷新的 initSidebarSearch()
// 在同文件下方（DOM 层，真浏览器验），main.js 只做一处接线。
//
// 搜索数据源是手机上那份全库名单（wikilinkIndex.notePaths），走 search.js 的
// searchTitles()，**零新增按词取数请求**。结果只搜标题与路径、一组、按路径序、
// 不截断（原型里的 60 条是演示、searchTitles 默认 100 条也要显式盖掉）。

import { searchTitles, normalizeQuery } from './search.js';

// 四态文案（设计任务书附录 C 定稿字面）。互不冒充：「还没问到」「没有」「连不上」
// 是三件事。集中在常量一处，HTML 生成与单测都读它，别散进各分支。
export const SEARCH_COPY = {
  checking: '正在确认网络…',                            // S-1：那次很轻的版本身份请求还没回来
  offline: '连不上服务端，搜索暂时用不了。恢复联网后再试。', // S-2：断网，不拿过期名单硬搜
  empty: '标题和路径里都没有',                          // S-3：网络确认过 + 名单已到 + 确实没匹配
  loading: '文件名单还在加载…',                        // S-4：名单还没到，与「没有」分开说
};

// 框外手势三种：点空白 / 点可点物 / 任意处滑。
export const GESTURES = ['tap-blank', 'tap-clickable', 'scroll'];

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 六行点/滑表（§3.2）的纯决策。
 *
 *   框空 → 三种手势都「收成放大镜」并取消输入状态；
 *   有词 → 三种手势都「只失焦、框与词与结果留着」。
 * 点可点物「那个东西照常触发」、滑动「列表照常滚」是叠加执行，不是二选一，
 * 所以这里只把它们标成 letClickableRun / letScrollRun，由接线层不去阻止默认行为。
 * backToTree 只给「框空 + 点空白」：点可点物时 view 归那个东西决定，滑动时不打断
 * 滚动，二者都不该顺手把侧栏抢回树。
 *
 * @param {{hasQuery?:boolean, gesture?:string}} args
 */
export function decideOutsideGesture({ hasQuery = false, gesture = 'tap-blank' } = {}) {
  const clickable = gesture === 'tap-clickable';
  const scroll = gesture === 'scroll';
  const collapse = !hasQuery;
  return {
    collapse,                       // 收成放大镜（输入框 → 放大镜按钮）
    keepQuery: !!hasQuery,          // 框与词与结果是否留着
    blur: true,                     // 六种都取消输入状态（失焦，但不换节点、不清词除非收起）
    letClickableRun: clickable,     // 那个东西照常触发
    letScrollRun: scroll,           // 列表照常滚、收起不打断滚动
    backToTree: collapse && gesture === 'tap-blank',
  };
}

/**
 * 判定一次点击/触摸是不是「框外」。点叉、点搜索框内部、输入法键盘都不算框外。
 * 传入的是接线层从 DOM 抽好的布尔描述，保持本函数纯、可单测。
 *
 * @param {{inSearchRow?:boolean, onClearButton?:boolean, isImeKeyboard?:boolean}} args
 * @returns {{outside:boolean, isClear:boolean}}
 */
export function classifyTapRegion({ inSearchRow = false, onClearButton = false, isImeKeyboard = false } = {}) {
  if (onClearButton) return { outside: false, isClear: true }; // 点叉优先级最高
  if (isImeKeyboard) return { outside: false, isClear: false }; // 输入法键盘不算框外
  if (inSearchRow) return { outside: false, isClear: false };   // 点框内不算框外
  return { outside: true, isClear: false };
}

/**
 * 只搜标题与路径、零新增请求、**不截断**、按路径序。
 * searchTitles 默认 limit=100（原型又截成 60），本票显式传 Infinity 盖掉，
 * 905 篇量级搜常见词一条不少。名单为 null / 非数组时由 searchTitles 兜底成空。
 */
export function runTitleSearch(notePaths, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  return searchTitles(notePaths, q, Number.POSITIVE_INFINITY);
}

/**
 * 四态判定，互不冒充。断网优先于结果：连不上时不许拿本机那份可能过期的名单硬搜，
 * 也不许说成「没有」。只有网络确认过 + 名单已到 + 确实没命中，才说「标题和路径里都没有」。
 *
 * @param {{online:boolean|null, indexReady:boolean, hits:Array}} args
 * @returns {{kind:'checking'|'offline'|'loading'|'empty'|'results', text:string}}
 */
export function searchStatus({ online = null, indexReady = false, hits = [] } = {}) {
  if (online === null) return { kind: 'checking', text: SEARCH_COPY.checking };
  if (online === false) return { kind: 'offline', text: SEARCH_COPY.offline };
  if (!indexReady) return { kind: 'loading', text: SEARCH_COPY.loading };
  if (!hits || hits.length === 0) return { kind: 'empty', text: SEARCH_COPY.empty };
  return { kind: 'results', text: '' };
}

/**
 * 一条结果：名字 + 一行父目录（905 篇里 112 组同名，只给名字等于碰运气），
 * 点一条在右边打开（href 到 #/edit/），带 data-sb-hit 供打开时定位。不挂分组标题。
 */
export function searchResultHtml(r) {
  const path = (r && r.path) || '';
  const name = r && r.name != null ? r.name : path;
  const dir = (r && r.dir) || '';
  return '<a class="res res-sb" href="#/edit/' + encodeURIComponent(path) + '"' +
    ' data-sb-hit="' + escapeHtml(path) + '">' +
    '<span class="res-name">' + escapeHtml(name) + '</span>' +
    (dir ? '<span class="res-dir">' + escapeHtml(dir) + '</span>' : '') +
    '</a>';
}

/** 四态时出一句文案；有结果时一组铺开，不截断、不分组。 */
export function searchResultsHtml({ online = null, indexReady = false, hits = [] } = {}) {
  const status = searchStatus({ online, indexReady, hits });
  if (status.kind !== 'results') {
    return '<div class="sb-status sb-status-' + status.kind + '">' + escapeHtml(status.text) + '</div>';
  }
  return hits.map(searchResultHtml).join('');
}

/** 有搜索词时底部横条「新建」用 hidden 隐藏（设置永远在，别用透明留个能按的按钮）。 */
export function shouldHideNewButton(query) {
  return !!normalizeQuery(query);
}

/**
 * 点叉：只清空当前这个词，焦点与键盘都留着、人能接着打；词一空侧栏内容回到目录树。
 * 点叉与点搜索框内部都不算框外，所以不收成放大镜；也**绝不重建输入框节点**
 * （换了节点中文输入法组字当场断，§6 第 1 条）。
 */
export function decideClear() {
  return {
    clearInput: true,
    keepFocus: true,
    backToTree: true,
    rebuildInput: false,
    collapse: false,
  };
}
