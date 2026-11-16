// 空状态与阅读态四档失败的「落位与文案」（#64）。
//
// 这一层只生成 HTML 字符串、只做失败分档：不碰 DOM、不发请求、不碰正文渲染插件。
// 真正把这份 HTML 放进 #app、触发核对、注入 probe 的接线在 main.js（真浏览器验）。
// 正文渲染结果与改动前逐字节一致：本模块不产出 <article class="md"> 里的一字一句，
// 只决定外面空状态 / 失败态怎么落位、留多少白。

import { recentEntry, MAX_RECENT } from './recent.js';

// 空状态主提示（设计任务书 §4.5 / 视觉规范 §7.4）：一句，直说，不喊口号、不用感叹号，
// 不交代「只存在这台设备」。第一次用一条记录都没有时这句话仍在，配适当留白。
export const EMPTY_PROMPT = '从侧栏选一篇笔记开始阅读。';

// 附录 C 已定字面的文案与 §4.6 的措辞，集中一处，别散进各分支。
export const READ_COPY = {
  loading: '正在打开这篇…',                       // R-1 一小段加载（静态，不整屏骨架）
  pending: '文件名单还在加载…',                 // R-2 名单未到：中性「还没问到」说明
  missing: '这篇不在了，可能被改名或删掉了',     // R-3 / E-4 定稿字面
  offline: '连不上服务端，暂时读不到这篇，恢复联网后再试', // R-4 连不上
};
export const INVALID_LABEL = '已失效';
export const REMOVE_LABEL = '从列表里去掉';
export const GONE_MESSAGE = READ_COPY.missing;

// R-2 的契约：名单未到的中性占位用这些类，确实找不到用另一套，二者不相交——
// 明暗两套配色下才分得开（视觉规范 §7.3「未知 / 找不到 / 连不上」三档）。
// 中性占位与失败态的 DOM 由 vault-refs.js / wikilinks.js 的插件产出，本模块不生成它们，
// 这里只把「用哪套类」钉成一份可测的约定；着色在 style.css 的 /* #64 */ 段落。
export const PENDING_CLASSES = ['img-pending', 'wikilink-unknown'];
export const BROKEN_CLASSES = ['img-broken', 'wikilink-broken'];

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 阅读态读失败的三档（工单第 5 条）：要密码 / 这篇不在了 / 连不上，互不冒充。
 * 与 recent.js 的 classifyProbe 不是同一把尺：那边判「在 / 不在 / 问不到」，
 * 这边还要把 401 单独拆出来，好让解锁框说话、背后不喊没连上。
 */
export function classifyReadError(err) {
  if (err && (err.auth === true || err.status === 401)) return 'password';
  if (err && (err.notFound === true || err.status === 404)) return 'missing';
  return 'offline';
}

/**
 * 一条最近打开：名字 + 一行浅色父目录（905 篇里 112 组同名，只给名字等于碰运气）。
 * 已失效只在内层一个 12px 危险色 span 上标字，**整条不变红、不消失**（E-3）。
 * 所有条目都带 data-recent-path；失效条目额外带 data-recent-invalid，供点击重新核对（E-4）。
 *
 * @param {{path:string, name?:string, parent?:string, invalid?:boolean}} args
 * @returns {string} HTML
 */
export function recentItemHtml({ path, name, parent, invalid } = {}) {
  const p = path || '';
  const entry = (name != null && parent != null) ? { name, parent } : recentEntry(p);
  const flag = invalid
    ? '<span class="recent-invalid">' + INVALID_LABEL + '</span>'
    : '';
  return '<a class="recent-item" href="#/edit/' + encodeURIComponent(p) + '"' +
    ' data-recent-path="' + escapeHtml(p) + '"' +
    (invalid ? ' data-recent-invalid="1"' : '') + '>' +
    '<span class="recent-name">' + escapeHtml(entry.name) + '</span>' +
    '<span class="recent-parent">' + escapeHtml(entry.parent) + '</span>' +
    flag +
    '</a>';
}

/**
 * 空状态：一句提示 + 最近打开的 5 条。
 * 第一次用一条记录都没有时仍完整、不像出错、不转圈、不显示「核对中」、不交代本机存储。
 * 核对是 main.js 在出现这一刻后台发起的，结果到了会带着 invalid 重画一次就地标注；
 * 本函数本身不知道「正在核对」，所以没有任何 busy / 灰 / 挡的形态。
 *
 * @param {{recents?:string[], invalid?:string[]}} args
 * @returns {string} HTML
 */
export function emptyStateHtml({ recents = [], invalid = [] } = {}) {
  const bad = new Set(invalid || []);
  const list = (recents || []).slice(0, MAX_RECENT);
  const items = list.length
    ? '<div class="recent-list">' +
      list.map((p) => recentItemHtml({ path: p, invalid: bad.has(p) })).join('') +
      '</div>'
    : '';
  return '<section class="empty-state">' +
    '<p class="empty-prompt">' + escapeHtml(EMPTY_PROMPT) + '</p>' +
    items +
    '</section>';
}

/**
 * 阅读态四档的落位（工单第 2/5 条）。
 *  R-1 loading：一小段静态加载说明，不是空白页、不整屏骨架乱跳。
 *  R-2 不在这里：正文照常渲染，双链 / 图片由插件渲染成中性 img-pending /
 *      wikilink-unknown，名单到了由 ensureIndex → repaintWithIndex 整篇重画换掉，
 *      滚动位置与声明区展开态由那处自带。本模块不碰它，正文渲染结果才逐字节一致。
 *  R-3 missing：明说「这篇不在了」，给一条回到空状态的路。
 *  R-4 offline：明说「连不上」，给重试（带着原来那篇的路径）。
 *  R-4 password：返回空串 —— 要密码由 api.js 派发 need-password 弹解锁框，
 *      背后不落任何失败文案、不再喊一句没连上。
 *
 * @param {'loading'|'missing'|'offline'|'password'} kind
 * @param {{path?:string}} opts
 * @returns {string} HTML
 */
export function readingStateHtml(kind, { path = '' } = {}) {
  if (kind === 'password') return '';
  const back = '<a class="read-back" href="#/">回到空状态</a>';
  if (kind === 'loading') {
    return '<section class="read-state read-loading">' +
      '<p class="read-msg">' + READ_COPY.loading + '</p>' +
      '</section>';
  }
  if (kind === 'missing') {
    return '<section class="read-state read-failure read-missing">' +
      '<p class="read-msg">' + READ_COPY.missing + '</p>' + back +
      '</section>';
  }
  return '<section class="read-state read-failure read-offline">' +
    '<p class="read-msg">' + READ_COPY.offline + '</p>' +
    '<button class="read-retry" data-read-retry="' + escapeHtml(path) + '">重试</button>' +
    back +
    '</section>';
}
