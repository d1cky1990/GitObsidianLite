import MarkdownIt from 'markdown-it';
import {
  listDir, listTree, listHead, readFile, writeFile, createFile, deleteFile, rawUrl,
} from './api.js';
import { installVaultImageRule, brokenImageHtml, runtimeFailureReason } from './vault-refs.js';
import {
  installWikilinkRule, buildWikilinkIndex, hydrateWikilinkIndex, serializeWikilinkIndex, lookupWikilink,
} from './wikilinks.js';
import {
  dirOf, baseOf, joinPath, normalizeNewName, hasName, renameTarget, moveTarget, stemOf, commitMessage,
} from './file-names.js';
// #66 文件操作规则层：逐字文案、弹窗模型、常驻浮层骨架、树行入口判定、核对事件。
// 规则层在独立模块；但本文件仍有 #66 的接线与改造——文件开头的
// mountFileOpsLayer() IIFE 是一次性常驻浮层注入，submitDialog / doCreate /
// doDelete 等既有函数被就地改写，末尾 /* #66 */ 块是事件接线，详见下方骨架总注释。
import {
  TEXT, createdToast, deleteSuccess, createHint,
  createDialogModel, renameDialogModel, moveDialogModel, deleteDialogModel,
  dialogView, fileOpsLayerHtml, shouldStartLongPress,
  opsSheetHtml, pickerHtml, LONG_PRESS_MS,
  NEW_TARGET_CHECK_EVENT, newNoteTargetCheckDetail,
} from './file-ops-ui.js';
import { icon } from './icons.js';
import { installTaskRule, toggleTaskInContent, isTaskDoneLine } from './tasks.js';
// 勾选「先记本机、送到再划掉」（#60）：按篇聚合的待发记录、补发、粘性提示门。
import { createPendingChecks, allowToast } from './pending-checks.js';
// Tasks 记号（#28）：列表项里的 ⏳📅✅… 翻成胶囊标签；```tasks 查询块给一句说明加
// 可展开原文，不执行。两者的规则各自住在自己的文件里。
import { installTaskMarkerRule } from './task-markers.js';
import { installTasksQueryRule } from './tasks-query.js';
// 标签（#14 定稿 → #29）：`#标签` 画成小胶囊。识别规则与「画一个标签」共用一份，
// #12 的声明区将来要画 YAML 的 `tags` 字段也走它（`tagChipHtml`）。
import { installTagRule } from './tags.js';
// 声明区（#12 定稿 → #30）：文件开头那段 YAML 摘出来，画在正文上方一块可折叠的区域。
// 它挂的是块级规则，所以顺序跟上面几条行内规则不相干；只要排在 `hr` 之前就行（见其注释）。
import { installFrontmatterRule } from './frontmatter.js';
// 搜索（#16 定稿 → #33）：入口常驻列表页顶部，**只搜标题与路径**——那靠的是上面
// 那份全库名单，零新增请求。正文搜索与本机正文副本已在 2026-10-27 下架（`docs/adr/0003`）。
import { searchTitles, normalizeQuery } from './search.js';
import './style.css';

// ---- #61 一屏两栏骨架，以及后续票在本文件留下的接线与改造 ------------------
// 模块边界仍主张「新逻辑优先放独立模块」（handoff「降低合并冲突的模块边界」），
// 但本文件**并不是**「只做 import 与一处接线」——后续各票在这里留下了三类东西：
//   1. 一次性常驻浮层注入：文件开头的 mountFileOpsLayer() IIFE（#66），把
//      #dlg-input 等常驻节点挂到 body 末尾，此后只切 hidden / 改文本，绝不重建。
//   2. 既有动作的接线与改造：submitDialog / doCreate / doDelete / relocate 等
//      既有函数被就地改写（#66）；进编辑 / 冲突的 UI 意图接到 editor-guard（#65）；
//      空状态与最近打开（#64）、侧栏搜索与设置（#63）、树（#62）各在文件末尾有
//      自己的 /* #NN */ 接线块。这些改动落在本文件的函数体里，不是搬去独立模块。
//   3. 各模块 import，以及 render() 开头调用的 syncFileOpsLayer()（#66 常浮层同步）。
// 文件不重排、不全文件格式化；各票接线块并存，按函数名与 /* #NN */ 注释定位。
// 硬约束（别踩）：骨架只建一次（mountShell 幂等），所有输入框节点（侧栏搜索框、
// 编辑区、弹窗 #dlg-input）自始至终不替换，「有 / 没有」只切 hidden —— 中文输入法
// 组字时换掉输入节点会当场断掉。作者样式里的 display 会盖掉默认 [hidden]，
// style.css 已补 !important。
// 三个契约模块（导出名固定，后续票按同一接口填充，不另造一套）：
//   theme.js        → getThemePreference / setThemePreference / applyTheme（由 layout.js 接）
//   tree.js         → buildTree / sortEntries / refreshTree / getSelectedFolder /
//                     setSelectedFolder / selectPath（#62 填充）
//   editor-guard.js → isLocked / guardExitEdit（#65 填充）
// 自绘图标、三个词状态、地址栏/返回/落地语义分别在 icons.js / navigation.js，
// 骨架 HTML 与开合接线在 layout.js，由下面 initLayout() 一处接好。
import { initLayout, SIDEBAR_BREAKPOINT } from './layout.js';
// 评审修复第 1 条：返回四层落地（纯决策与地址栏落点在 navigation.js，DOM 接线在本文件）
import { CLOSE_NOTE_HREF, backDirective, resolveLanding, landingProbeFromIndex } from './navigation.js';
import { getSelectedFolder, initTree, selectPath, setSelectedFolder, refreshTree, notifySidebarShown } from './tree.js';
// #64 空状态与阅读态四档失败：规则层 recent.js + 落位层 render-states.js。
// 只在这里 import 与下面几处接线，不动 md 实例与插件顺序、不动正文渲染。
import {
  addRecent, removeRecent, replaceRecentPath, readRecent, writeRecent,
  checkRecents, recheckOne,
} from './recent.js';
import {
  emptyStateHtml, readingStateHtml, classifyReadError, GONE_MESSAGE, REMOVE_LABEL,
} from './render-states.js';
// #65 编辑态与冲突：锁死侧栏 / 未保存保护 / 进编辑读远端 / 保存失败分类 /
// 提示条时长 / 冲突链条，规则都在 editor-guard.js；可见视口接线在 viewport.js。
// 本处只做 import；UI 接线在末尾 /* #65 */ 块（syncEditorChrome / exitEdit /
// conflictBackToEdit / ui:back 等），与上方总注释所述「一次性注入、既有动作改造」
// 一并看，不重排文件、不把既有实现搬走。
import {
  isLocked, guardExitEdit, configureEditorGuard, hasUnsavedChanges,
  classifyEditRead, classifySaveError, toastDuration,
  EDIT_COPY, SAVE_COPY,
} from './editor-guard.js';
import { initViewport } from './viewport.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// 待办勾选框（#13/#27）：渲染钩子把列表项开头的 `[ ]`/`[x]` 换成方框，
// 方框上带它在源文里的行号，点击时按行号切换（见 onTaskClick）。
installTaskRule(md);
// 顺序要紧：记号的钩子要跑在勾选框之后——它切的是勾选框留下的那段文字。
installTaskMarkerRule(md);
installTasksQueryRule(md);

// 双链与图片共用同一份索引（`#7` 建的，含非 `.md` 文件的 basename → 路径）：
// 双链拿它判「解不解得开」，图片拿它在相对解析失败后按文件名反查（`#8`）。
// `wikilinkIndex` 与 `wikilinkIndexPromise` 都声明在两个插件之前，是因为渲染钩子会读它们
// （此时还只是闭包，不取值的）。
let wikilinkIndex = null;

// 图片 / 附件：src 先相对当前笔记所在目录解析成 vault 内路径，解析不到再按文件名反查，
// 最后都走 raw 代理。
// `isIndexPending` 区分「正在拉清单」与「清单没拉到」：前者摆中性占位等着（不白跑一趟必然
// 404 的请求），后者照常发请求——等下去也不会变，能开的那几张还得能开。
installVaultImageRule(md, {
  rawUrl,
  getIndex: () => wikilinkIndex,
  isIndexPending: () => wikilinkIndexPromise !== null,
});

installWikilinkRule(md, { getIndex: () => wikilinkIndex, rawUrl });

// 标签（#29）：插在 link 规则之前——`link` 一旦命中就整体吃掉了，插在它后面
// 等于放跑 `[文字](url#锚点)` 里的锚点。
installTagRule(md);

// 声明区（#30）：块级规则，认的是文件最开头那两条 `---`。挂在这里只是跟其他几条
// 摆在一起；它必须在 `hr` 之前跑（否则 `---` 已经变成分隔线了），这一点由它自己保证。
installFrontmatterRule(md);

// 骨架只建一次（mountShell 幂等）：注入 #shell 里的两栏 DOM（含 #app），应用
// 主题第一帧之后那次读取，接好侧栏开合 / 占位历史 / 返回四层。必须在取 #app
// 之前跑——index.html 现在只留 #shell 容器，#app 由骨架生成。
initLayout();

const app = document.getElementById('app');

// 解析出来的路径也可能在仓库里并不存在（后端 404，或回来的不是图片）。
// error 事件不冒泡，但在捕获阶段会经过祖先节点，所以监听器挂在 #app 上。
//
// 404 只说「这个地址上没有文件」，**不等于**「文件不存在」：裸文件名的图片引用（Obsidian
// 的默认写法）解析出来本就在别人家的目录里，只要全库文件名单到手就还能按文件名找回来
// （见 vault-refs.js 的 pickVaultImagePath）。
//
// 清单**正在拉**时轮不到这里——那时渲染的是中性占位，压根不发请求。所以走到这里的 404
// 只有两种：清单已到手（反查找过了，确实没有）、或清单**没拉到**（等下去也不会变，只是
// 我们判不了「确实没有」）。判据是 runtimeFailureReason，且它对没有 data-vault-path 的
// 外链不生效——一张挂掉的推特图不该被说成「还在确认位置」。
app.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.failed) return;
  img.dataset.failed = '1';
  const vaultPath = img.dataset.vaultPath || '';
  const holder = document.createElement('span');
  holder.innerHTML = brokenImageHtml({
    reason: runtimeFailureReason({ vaultPath, indexReady: !!wikilinkIndex }),
    ref: vaultPath || img.getAttribute('src') || '',
  });
  img.replaceWith(holder.firstChild);
}, true);

// #66 文件操作常驻浮层：一次性注入到 body（在 #app / 骨架之外），之后 render() 开头的
// syncFileOpsLayer() 只切 hidden / 改文本，绝不重建 #dlg-input —— 中文拼音组字不中断
// （§6 第 1 条）。操作表 / 目录选择器各有宿主，没有输入框，内容可随状态重建。
(function mountFileOpsLayer() {
  const box = document.createElement('div');
  box.innerHTML = fileOpsLayerHtml();
  const layer = box.firstElementChild;
  if (!layer || !document.body) return;
  document.body.appendChild(layer);
  // 输入框事件一次性绑定（常驻节点，绝不每次 render 重复 addEventListener）：
  const inp = document.getElementById('dlg-input');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const d = state.dialog;
    if (!d) return;
    d.value = inp.value;
    if (d.error) d.error = ''; // 一改动就清掉上一句撞名提示；不重画、不换节点
  });
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitDialog(); });
})();

/* ---------- 访问密码（服务端配置了 APP_PASSWORD 时启用） ---------- */
function showPasswordModal() {
  if (document.getElementById('pw-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'pw-overlay';
  overlay.innerHTML = `
    <div class="pw-box">
      <div class="pw-title">访问密码</div>
      <input id="pw-input" type="password" placeholder="输入访问密码"
             autocomplete="current-password" autocapitalize="off">
      <button id="pw-btn">进入</button>
      <div id="pw-err" class="pw-err"></div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#pw-input');
  const btn = overlay.querySelector('#pw-btn');
  const err = overlay.querySelector('#pw-err');
  btn.disabled = true;

  async function submit() {
    const v = input.value.trim();
    if (!v) return;
    btn.disabled = true;
    err.textContent = '';
    localStorage.setItem('appPassword', v);
    try {
      const resp = await fetch('/api/head', { headers: { 'X-Auth': v } });
      if (resp.ok) {
        location.reload(); // 密码对了，重载后所有请求带上密码
      } else {
        localStorage.removeItem('appPassword');
        err.textContent = '密码不对，再试试';
        input.select();
      }
    } catch (e) {
      err.textContent = '网络错误，请重试';
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.addEventListener('input', () => { btn.disabled = !input.value.trim(); });
  input.focus();
}
window.addEventListener('need-password', showPasswordModal);

// 文件名 → 路径索引（用于双链判定与跳转、图片引用的按文件名反查），带 HEAD sha 增量缓存。
//
// 索引要能回答三种问题，所以笔记与非笔记分开存：「是笔记」「是仓库文件（不是笔记）」
// 「不存在」。只收 .md 的老做法会把「文件明明存在」说成「未找到笔记」——#7 要修的正是这个。
//
// 缓存只存路径清单，映射读回时重建：映射能从路径推出来，存两份就是让它们有机会漂移。
const INDEX_CACHE_KEY = 'fileIndexCache.v2';
const LEGACY_INDEX_CACHE_KEY = 'fileIndexCache.v1';
let wikilinkIndexPromise = null;
// 最近一次问到的仓库版本身份。切回标签页时拿它比一次——一样就什么都不做，
// 不一样才重建清单（重建要 3~5 秒，不该每次切回来都付）。
let lastHead = '';

function readCachedIndex() {
  try {
    const raw = localStorage.getItem(INDEX_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && data.head && data.index) return data;
  } catch (e) { /* 坏值当没有 */ }
  return null;
}

function writeCachedIndex(head, index) {
  try {
    localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify({ head, index: serializeWikilinkIndex(index) }));
  } catch (e) { /* 忽略（可能超配额） */ }
}

/**
 * 索引就绪的 Promise。
 *
 * **失败会 reject，不吞成空索引**——空索引会让每一条双链都渲染成「文件不存在」，
 * 把一次网络故障说成上千条断链。渲染层把「拿不到」和「确实没有」当成两件事：
 * 前者渲染成中性可点重试的样式，后者才报不存在。图片同理：双链渲染成
 * `wikilink-unknown`，图片渲染成 `img-pending`，而且**不会**退化成「文件不存在」。
 *
 * **也不拦在打开笔记的路上**：整棵树实测 3~5 秒（`/api/file` 只要 1 秒），把它 `await`
 * 进 `openFile` 就是把打开一篇笔记从 1 秒拖成 4 秒。所以这里是预热 + 就绪后补渲染，
 * 而不是 await。开方见 `openFile`。
 */
function ensureIndex({ force = false } = {}) {
  if (wikilinkIndexPromise) return wikilinkIndexPromise;
  if (wikilinkIndex && !force) return Promise.resolve(wikilinkIndex);
  const p = (async () => {
    try { localStorage.removeItem(LEGACY_INDEX_CACHE_KEY); } catch (e) { /* 忽略 */ }
    // 1. 拿 HEAD sha，与缓存对比
    const cached = readCachedIndex();
    const head = await listHead();
    lastHead = head.sha;
    if (cached && cached.head === head.sha) {
      wikilinkIndex = hydrateWikilinkIndex(cached.index);
      return wikilinkIndex;
    }
    // 2. HEAD 变了（或没有缓存），拉全量重建
    const data = await listTree();
    const index = buildWikilinkIndex(data.tree);
    writeCachedIndex(head.sha, index);
    wikilinkIndex = index;
    return index;
  })();
  wikilinkIndexPromise = p;
  // 这一份 promise 就是「清单正在拉」的唯一真相，**settle 之后必须清掉**。
  // 清了它，`isIndexPending()` 才真的是「正在拉」；留着不清，它会永远为真——
  // 而图片规则先问它再问清单，于是每一张库内图片都被摆成「正在确认位置」的中性占位，
  // 永远换不成真图。这条接线是 #8 当时漏的，做 #33 时才在真浏览器里看见。
  const settle = () => { if (wikilinkIndexPromise === p) wikilinkIndexPromise = null; };
  p.then(settle, settle);
  // 索引到位 → 把上一次渲染里的中性「不知道」换成真实判定。
  // 只在只读状态补：编辑中重渲染会丢光标与未提交的输入。
  p.then(repaintWithIndex, () => {});
  // 搜索那边也等这份名单：索引来得比第一个字晚时，结果得自己补上
  p.then(() => {
    if (state.view === 'list' && normalizeQuery(state.query)) onQueryChanged();
  }, () => {});
  return p;
}

/**
 * 索引到位后补一次渲染。
 *
 * 整篇重画（不是只改双链）：图片引用的反查结果同样取决于索引，中性占位也要一起换掉。
 * 从插件一路看下来，改名的代价比留一个说谎的函数名小。
 *
 * 只在只读态补：编辑中重渲染会丢光标与未提交的输入。
 * 补渲染会整块替换 `#app`，所以要自己把两样东西带过去——否则用户读着读着页面跳回顶部，
 * 或者刚点开的声明区自己又收起来（那一下不比跳回顶部轻）。
 */
function repaintWithIndex() {
  if (state.view !== 'editor' || state.mode !== 'read') return;
  const y = window.scrollY;
  // 声明区（#30）的展开态跟着走一趟：它是原生 <details>，DOM 一换就回到默认的收起，
  // 而用户此刻正盯着展开的那份看。**只带当前这一屏**——下次打开这篇仍是收起的，
  // 那条定稿说的「收起状态不记忆」管的是跨次打开，不是这一次内部重画。
  const fmOpen = document.querySelector('.fm-fold')?.open === true;
  render();
  if (fmOpen) {
    const fold = document.querySelector('.fm-fold');
    if (fold) fold.open = true;
  }
  window.scrollTo(0, y);
  // 搜索命中的那处高亮也跟着走一趟：重画会把 <mark> 抹掉，而用户正是顺着它找过来的
  if (state.hitMark) {
    const article = document.querySelector('article.md');
    if (article) { unwrapHits(article); highlightFirst(article, state.hitMark.query); }
  }
}


/* ---------- 搜索：在线才给结果 ---------- */

// 搜的是手机上那份全库名单，而它是**每次打开应用时与远端对齐**的。连那次很轻的版本身份
// 请求都问不到（= 断网）时，手上那份可能已经过期：搜得到的东西可能早被改名、删掉了。
// 所以宁可保守，整个搜索先不给结果——不展示可能过时的名单，与「不许把不知道说成没有」
// 是同一条规矩。断网不删任何东西，恢复联网再搜就是了。
let onlineCache = { at: 0, ok: false };
// 「在线」可以信 15 秒；「离线」只信 3 秒——刚恢复网络的人回头再搜一次，不该被上一秒的
// 失败结论挡在门外。这两个数不一样是有意的。
const ONLINE_TTL_OK = 15000;
const ONLINE_TTL_FAIL = 3000;

async function checkOnline() {
  const ttl = onlineCache.ok ? ONLINE_TTL_OK : ONLINE_TTL_FAIL;
  if (onlineCache.at && Date.now() - onlineCache.at < ttl) return onlineCache.ok;
  try {
    await listHead();
    onlineCache = { at: Date.now(), ok: true };
  } catch (e) {
    onlineCache = { at: Date.now(), ok: false };
  }
  return onlineCache.ok;
}

/* ---------- 结果 ---------- */

function resultRow(r) {
  return '<a class="res" href="#/edit/' + encodeURIComponent(r.path) + '"' +
    ' data-hit="' + esc(r.path) + '" data-hitq="' + esc(normalizeQuery(state.query)) + '">' +
    '<span class="res-title"><span class="ic md" aria-hidden="true">' + icon('note', 18) + '</span><span class="nm">' + esc(r.name) + '</span>' +
    (r.dir ? '<span class="res-dir">' + esc(r.dir) + '</span>' : '') + '</span>' +
    '</a>';
}

function renderResults() {
  const q = normalizeQuery(state.query);
  if (!q) return '';
  // 断网 / 还没问清网络：**不出结果**，也不说「没找到」——那会把一次网络故障说成没有这篇笔记
  if (state.online === null) return '<div class="res-status dim">正在确认网络…</div>';
  if (state.online === false) return '<div class="res-status dim">连不上服务端，搜索暂时用不了。恢复联网后再试。</div>';

  // 只有一组结果，就不必再挂一个分组标题当空壳——列表本身已经说明它是什么
  const titles = wikilinkIndex ? searchTitles(wikilinkIndex.notePaths, q) : [];
  if (titles.length) return titles.map(resultRow).join('');
  return '<div class="res-empty dim">' +
    (wikilinkIndex ? '标题和路径里都没有' : '文件名单还在加载…') + '</div>';
}

/* ---------- 搜索框 ---------- */

// 每次改词给一个序号：先发的请求回来晚了，就别拿旧结果盖新的那一次
let searchSeq = 0;

/* ---------- 列表页的骨架 ---------- */
//
// **搜索框只建一次，之后再也不换掉它。** 这条不是讲究，是能不能打中文的前提：
// 整页重画会把 <input> 换成一个新节点，而中文输入法正在组字时，节点一换组字就断了
// （真输入法通路实测：框被换成新的、组字再也不会结束、接着敲的字母全糊在一起）。
// 所以列表页拆成骨架 + 内容区，重画只改内容区。
//
// 光标丢不丢只是它的一个后果，根子是**节点不能换**。

function listShellHtml() {
  return '<header class="bar">' +
    '<div class="search-row">' +
    '<input id="q" class="search-input" type="text" placeholder="只搜标题与路径"' +
    ' autocapitalize="off" autocomplete="off" spellcheck="false">' +
    '<button class="search-clear" id="q-clear" data-act="clearQuery" aria-label="清空搜索">' + icon('close', 18) + '</button>' +
    '</div>' +
    '<span class="crumbs" id="list-crumbs"></span>' +
    '</header>' +
    '<main class="list" id="list-main"></main>' +
    '<button class="fab" id="fab-new" data-act="newFile">' + icon('new-note', 18) + ' 新建笔记</button>' +
    '<div id="list-overlays"></div>' +
    '<div id="list-toast"></div>';
}

/** 输入法正在组字。组字期间：不重画、不搜、更不碰那个框里的值。 */
let searchComposing = false;

function wireSearch() {
  const inp = document.getElementById('q');
  if (!inp) return;
  inp.addEventListener('compositionstart', () => { searchComposing = true; });
  inp.addEventListener('compositionend', () => {
    searchComposing = false;
    // 拼完了才搜——搜的该是拼出来的词，不是中间那串字母
    if (inp.value === state.query) return;
    state.query = inp.value;
    onQueryChanged();
  });
  inp.addEventListener('input', (e) => {
    if (e.isComposing || searchComposing) return;  // 组字中：等它结束
    if (inp.value === state.query) return;         // 提交组字那一下会再补一个 input
    state.query = inp.value;
    onQueryChanged();
  });
}

/**
 * 词变了：先把「正在确认网络」画出来，再发那次很轻的请求。**每打一个字都重画**——
 * 结果是从手上那份名单算出来的，不比词多要一次数据。
 */
function onQueryChanged() {
  const seq = ++searchSeq;
  if (!normalizeQuery(state.query)) { state.online = null; render(); return; }
  render();
  (async () => {
    const ok = await checkOnline();
    if (seq !== searchSeq) return;
    state.online = ok;
    // 名单没到就顺手催一次。失败过的那次会把 promise 清掉，所以这是一次真的重试——
    // 不然断网时打开的那一页，恢复联网后搜索会一直空着（名单永远停在中性态）。
    // 只在确认在线时催：离线时每个字都去拉一遍清单，是把一次故障放大成无数次。
    if (ok && !wikilinkIndex) ensureIndex().catch(() => {});
    if (seq !== searchSeq) return;
    render();
  })();
}

/* ---------- 点进去落在命中那一段 ---------- */
//
// #16 定的实现口径：不必先算行号——打开后在那篇的渲染结果里找到命中的那段文字、滚过去。

function unwrapHits(root) {
  for (const m of root.querySelectorAll('mark.search-hit')) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  }
}

function highlightFirst(root, query) {
  const q = normalizeQuery(query);
  if (!q) return null;
  // 命中的那段原文可能夹着 markdown 记号（原文 `**粗**`，渲染出来没有星号），
  // 整句找不到就退一步、拿里面最长的词试——落点落在「那一段」就够用了
  const cands = [q, ...q.split(/\s+/).filter((t) => t.length >= 2).sort((a, b) => b.length - a.length)];
  for (const c of cands) {
    const m = wrapFirstText(root, c);
    if (m) return m;
  }
  return null;
}

function wrapFirstText(root, needle) {
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const at = node.data.toLowerCase().indexOf(lower);
    if (at === -1) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const mark = document.createElement('mark');
    mark.className = 'search-hit';
    try {
      range.surroundContents(mark);
      return mark;
    } catch (e) {
      return node.parentElement; // 跨节点的情形不为它写第二套，落在附近就行
    }
  }
  return null;
}

function applyPendingHit() {
  const hit = state.pendingHit;
  state.pendingHit = null;
  if (!hit) return;
  const article = document.querySelector('article.md');
  if (!article) return;
  const mark = highlightFirst(article, hit.query);
  if (!mark) return;
  state.hitMark = hit;
  mark.scrollIntoView({ block: 'center' });
}

/* ---------- 冲突合并：字符级 diff ---------- */
function diffSeq(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ t: 'equal', x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', x: a[i] }); i++; }
    else { out.push({ t: 'ins', x: b[j] }); j++; }
  }
  while (i < m) out.push({ t: 'del', x: a[i++] });
  while (j < n) out.push({ t: 'ins', x: b[j++] });
  return out;
}

function makeFragments(localText, remoteText) {
  const ops = diffSeq([...localText], [...remoteText]);
  const frags = [];
  let id = 0;
  for (const op of ops) {
    const last = frags[frags.length - 1];
    if (last && last.type === op.t) last.text += op.x;
    else frags.push({ id: id++, type: op.t, text: op.x });
  }
  return frags;
}

function newDecisions(fragments) {
  const d = {};
  for (const f of fragments) if (f.type !== 'equal') d[f.id] = { decision: null };
  return d;
}

function isAllResolved(conflict) {
  for (const f of conflict.fragments) {
    if (f.type === 'equal') continue;
    const d = conflict.decisions[f.id];
    if (!d || !d.decision) return false;
  }
  return true;
}

function computeMerged(conflict) {
  let out = '';
  for (const f of conflict.fragments) {
    if (f.type === 'equal') out += f.text;
    else { const d = conflict.decisions[f.id]; if (d && d.decision === 'accept') out += f.text; }
  }
  return out;
}

const state = {
  view: 'list', // 'list' | 'editor'
  path: '', // 当前目录（list）或文件路径（editor）
  // #61 三个词各有唯一真相（GLOSSARY.md）。旧 path 同时当「目录」与「文件」用，
  // 才会拼出 `某篇.md/新笔记.md`；新建落点只读 selectedDir，绝不读 openedPath。
  selectedDir: getSelectedFolder(), // 选中的文件夹（新建落点；tree.js #62 填充）
  openedPath: '', // 打开的那篇（address bar 只跟它走）
  editingPath: '', // 正在编辑的那篇（编辑 / 冲突态）
  sidebarOpen: false, // 侧栏开合（窄屏滑出 / 宽屏收起）
  entries: [], // 旧整页列表页遗留；仅保留的 renderList() 读取，路由改动后主路径不再写入
  file: null, // { path, sha, content }
  mode: 'read', // 'read' | 'edit' | 'conflict'
  draft: '',
  message: '',
  busy: false,
  conflict: null, // { local, remote, fragments, decisions, previewOpen, copyPrompt }
  activeFrag: null, // 当前点击的 diff 片段 id

  // ---- 文件操作（#26）的状态，全是「当前屏幕上多出来的一层」 ----
  ops: null, // { path } —— 「⋯」点开的那张操作表
  dialog: null, // { type:'prompt'|'confirm', ... } —— 新建 / 重命名 / 删除确认
  picker: null, // { dir, entries, busy } —— 移动时的目录选择器
  toastAction: null, // { label, run } —— 删除后的「撤销」按钮
  undo: null, // { path, content, dir } —— 撤销删除要用的原稿
  openInEdit: null, // 新建之后要直接进编辑态的那条路径

  // ---- 进编辑态之前那次远端核对（#34 / #65） ----
  editChecking: false, // 正在读最新版，按钮显示忙态；也当连点锁
  editReadError: '', // #65 读不到远端时停在阅读态的那句说明（空 = 正常）

  // ---- 搜索（#33） ----
  query: '', // 搜索框里的词（空 = 正常翻目录）
  online: null, // null = 还没问过；true / false = 那次很轻的版本身份请求的结果
  pendingHit: null, // { path, query } —— 刚点的搜索结果，打开后要滚到命中那一段
  hitMark: null, // 已经滚过去的那处，补渲染时要把它画回来

  // ---- #64 空状态与阅读态失败落位 ----
  readState: null, // { kind:'loading'|'missing'|'offline', path } —— R-1 加载 / R-3 / R-4 落位；null = 正常阅读
  emptyActive: false, // 没打开笔记时正文区显示空状态（出现那一刻后台核对最近打开）
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 提示条可以带一个动作（目前只有删除后的「撤销」）。带动作的多留一会儿——一句 2.5 秒
// 就没了的提示，配上要去找的按钮，等于没给。
let toastTimer = null;
function toast(msg, action = null) {
  if (!allowToast(state.toastAction, action)) return; // #60：送不到的提示不许被普通提示顶掉
  state.message = msg;
  state.toastAction = action;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.message !== msg) return; // 期间又被别的提示顶掉了，别把新的收走
    state.message = ''; state.toastAction = null; render();
  }, toastDuration(action)); // #65：普通 2.5s / 带动作 8s，与 editor-guard 单测同源
}

/**
 * 路由（评审修复第 2/3 条）：接上 navigation.js 的 resolveLanding()。
 *  - 分享链接 /edit/ → 阅读态、侧栏关着（F-13）；
 *  - 根 hash / 未知 hash → 右侧空状态（#64 的最近打开与四档失败态不进旧列表页）；
 *  - 旧目录链接 /dir/ → landDirLink()：不再进 renderList() 旧整页列表，改为
 *    侧栏选中该文件夹 + 右侧空状态，逐级上退与那句话由 resolveLanding 给。
 */
function navigate() {
  const hash = location.hash.slice(1) || '';
  if (hash.startsWith('/dir/')) { landDirLink(location.hash); return; }
  const probe = landingProbeFromIndex(wikilinkIndex ? wikilinkIndex.notePaths : null);
  // online 恒 true：分享链接 / 根 hash 不依赖名单，不能被「名单还没到」误判成断网
  // （#64 判据 3：断网时空状态也不弹提示）。exists 对这两类 hash 不会被调用。
  const landing = resolveLanding({ hash: location.hash, exists: probe.exists, online: true });
  if (landing.kind === 'note') {
    // F-13：分享链接落阅读态、侧栏关着。openFile() 不改 hash / 不碰侧栏；窄屏侧栏
    // 默认关（layout initLayout 的 isWide() && !collapsed），宽屏常驻是骨架定稿
    // G-6，不强行关。正文渲染一字不改。
    openFile(landing.path);
    return;
  }
  // empty（根 hash / 未知 hash）：直接落右侧空状态，不加载旧整页目录列表；断网时空状态不弹提示，
  // 最近打开的核对由 showEmptyState 发起（#64 判据 3）。
  state.view = 'list';
  showEmptyState();
}

/**
 * 旧目录链接落地（评审修复第 2/3 条）。**不回 renderList() 旧整页列表**：
 * 右侧先落空状态，侧栏按名单判出的那一级选中；message 逐字说给用户。
 * 名单还没到时挂既有 ensureIndex 那一份 promise（不新增请求）：到手重判、
 * 失败＝断网说「连不上」，都不谎报上退、不说「找不到」（F-13 / F-14）。
 */
function landDirLink(hash) {
  state.view = 'list';
  state.mode = 'read';   // 复位编辑/冲突锁，避免空状态下侧栏仍被 isLocked() 锁死
  state.readState = null;
  showEmptyState();
  const decide = () => {
    if (location.hash !== hash) return;   // 期间已离开这条旧链接，别覆盖用户的新操作
    const probe = landingProbeFromIndex(wikilinkIndex ? wikilinkIndex.notePaths : null);
    applyDirLanding(resolveLanding({ hash, exists: probe.exists, online: probe.online }));
  };
  if (wikilinkIndex) { decide(); return; }
  // 复用启动预热那一份正在进行的 promise（不新增请求）；若既没到手也没在拉
  // （上一次尝试已失败 settle），按「问不到」说连不上，不再发请求。
  if (!wikilinkIndexPromise) {
    showEmptyState();
    toast('连不上');
    return;
  }
  wikilinkIndexPromise.then(decide, () => {
    if (location.hash !== hash) return;
    showEmptyState();
    toast('连不上');   // 断网 / 问不到，不冒充「不在了」、不谎报上退
  });
}

/** 把 dir / offline 落地结果画出来：侧栏选中 + 右侧空状态，不进旧列表页。 */
function applyDirLanding(landing) {
  if (landing.kind === 'offline') {
    showEmptyState();
    toast(landing.message || '连不上');
    return;
  }
  // dir：侧栏选中该文件夹（#62 的 setSelectedFolder / 树定位），右侧空状态。
  try { setSelectedFolder(landing.path); } catch (_) { /* 树未接线时忽略 */ }
  showEmptyState();
  if (landing.message) toast(landing.message);  // 「这个目录不在了，已上退到这里」
}

async function openFile(path) {
  closeOverlays();
  // 换了一篇就把上一处搜索命中丢掉；同一条路径则是刚从结果里点进来的，留着给下面用
  if (!state.pendingHit || state.pendingHit.path !== path) {
    state.pendingHit = null;
    state.hitMark = null;
  }
  // #64 R-1：正文还在路上 —— 一小段加载落位在正文区，不是空白页、不整屏骨架乱跳。
  // 不复用 list 态的 busy 转圈：那会把「打开一篇」画成整个目录页在加载。
  state.readState = { kind: 'loading', path };
  state.emptyActive = false;
  render();
  try {
    // 双链要在**渲染期**就判得出解不解得开，但索引本身（一次全树拉取，实测 3~5 秒）
    // 不能拦在这次打开的路上——那会把打开一篇笔记从 1 秒拖成 4 秒。所以：预热，不 await。
    // 索引还没到就先按中性「不知道」渲染，到了由 ensureIndex 补一次 render 换掉。
    // 索引拿不到不算打开失败：正文照读。（#64 R-2：名单到了由 repaintWithIndex 整篇
    // 重画换掉中性占位，滚动位置与声明区展开态由那处自带，本票不改它。）
    ensureIndex().catch(() => {});
    const file = await readFile(path);
    state.view = 'editor';
    state.file = file; state.path = path;
    state.mode = 'read'; state.draft = file.content;
    // 新建完直接进来的那一次：跳过阅读态，落笔就写（空笔记停在阅读态没有意义）
    if (state.openInEdit === path) { state.mode = 'edit'; state.openInEdit = null; }
    state.readState = null;
    recordOpen(path); // #64 每次成功打开就置顶、去重、截断到 5 条
  } catch (e) {
    // #64 三档失败拆开，不再一句 toast(e.message) + 回根目录合并了事。
    const kind = classifyReadError(e);
    if (kind === 'password') {
      // 要密码：api.js 已派发 need-password 弹解锁框，背后不喊没连上、不 toast、
      // 不回根目录；保留当前 hash，解锁成功后 reload 会重新打开这一篇。
      state.readState = null;
      state.emptyActive = true;
    } else {
      state.readState = { kind, path }; // R-3 这篇不在了 / R-4 连不上，落位在正文区
    }
  }
  render();
  if (state.view === 'editor' && state.pendingHit && !state.readState) applyPendingHit();
}

// #60：从编辑 / 冲突态「回到阅读态」的统一落点。退出编辑这一刻就补发那篇没送到的
// 勾选（判据 5 后半），不必再等下一次切回前台 / 冷启动。replay 只在这一处调用。
function backToRead() {
  state.mode = 'read';
  pendingChecks.replay();
}

/**
 * 保存（#65）：忙态落在被按的那个按钮上，不用全局提示代劳；保存期间不整页重画，
 * 也就不会换掉用户正在打字的那个输入框节点。撞远端改动才进冲突态且草稿不丢；
 * 连不上 / 这篇不在了 / 其它各说各的，**绝不许说成冲突**。分类在 classifySaveError。
 */
async function save() {
  const btn = document.getElementById('save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  state.busy = true;
  try {
    const r = await writeFile(state.file.path, state.draft, state.file.sha, commitMessage.edit(state.file.path));
    state.file.sha = r.sha; state.file.content = state.draft;
    backToRead();
    refreshTree(); // #66 保存之后树就地刷新
    toast(SAVE_COPY.saved);
  } catch (e) {
    const verdict = classifySaveError(e);
    if (verdict.kind === 'conflict') { enterConflict(verdict.remote); render(); }
    else if (verdict.kind !== 'auth') toast(verdict.message); // 要密码时解锁框已在说话
  } finally {
    state.busy = false;
    // 仍停在编辑态时恢复按钮；切到阅读 / 冲突态的那次 render 已重建动作区，取不到就跳过
    const b = document.getElementById('save-btn');
    if (b) { b.disabled = false; b.textContent = '保存'; }
  }
}

/**
 * 点「编辑」：进编辑态之前先核一次远端（#34 / #65）。
 *
 * 手机上不留正文副本，连不上时写下的字在保存那一刻必然丢——所以**读不到就不进编辑**
 * （作废旧规矩「读取失败照常进编辑态」）。忙态落在被按的那个按钮上、连点只发一次
 * 请求。版本号没变直接进、一个字不提示；变了换最新再进并提示那句；读不到停在阅读态，
 * 明说连不上 / 不在了，动作区给「重试」。结果分类在 editor-guard.js 的 classifyEditRead。
 */
async function startEdit() {
  if (state.editChecking) return;              // 连点别发两次请求
  const path = state.path, sha = state.file.sha;
  state.editChecking = true; state.editReadError = ''; render();

  let fresh = null, err = null;
  try { fresh = await readFile(path); } catch (e) { err = e; }
  state.editChecking = false;

  // 读的这段时间里换了篇 / 退出了这一屏：这次核对的结果没有归属，丢掉。
  // （丢了也要把忙态清掉，否则回到阅读态时按钮永远停在「读取中…」）
  if (state.view !== 'editor' || state.path !== path || state.mode !== 'read') { render(); return; }

  const verdict = classifyEditRead({ err, fresh, currentSha: sha });
  if (!verdict.enterEdit) {
    // 停在阅读态：落位一句说明 + 动作区「重试」，不用会 2.5 秒消失的全局提示代劳。
    // 要密码时 api.js 已派发 need-password 弹解锁框，背后不再喊一句（message 为空）。
    state.editReadError = verdict.message;
    render();
    return;
  }

  // 版本号必须**同步换掉**：不换的话下一次保存必然 409，把一条本来不存在的冲突报给用户
  if (verdict.kind === 'updated') { state.file = verdict.fresh; state.draft = verdict.fresh.content; }
  state.mode = 'edit'; render();
  if (verdict.message) toast(verdict.message);
}

function enterConflict(remote) {
  const local = state.draft;
  const fragments = makeFragments(local, remote.content);
  state.mode = 'conflict';
  state.conflict = { local, remote, fragments, decisions: newDecisions(fragments), previewOpen: false, copyPrompt: false };
  state.activeFrag = null;
}

function decide(fragId, decision) {
  const d = state.conflict.decisions[fragId] = state.conflict.decisions[fragId] || { decision: null };
  d.decision = decision === 'cancel' ? null : decision;
  state.activeFrag = null;
  render();
}

async function commitMerge() {
  if (!isAllResolved(state.conflict)) { toast(SAVE_COPY.unresolved); return; }
  const merged = computeMerged(state.conflict);
  state.busy = true; render();
  try {
    const r = await writeFile(state.file.path, merged, state.conflict.remote.sha, commitMessage.merge(state.file.path));
    state.file.sha = r.sha; state.file.content = merged;
    backToRead(); state.conflict = null;
    toast(SAVE_COPY.merged);
  } catch (e) {
    toast(e.message);
  }
  state.busy = false; render();
}

async function saveCopy(which) {
  const c = state.conflict;
  const base = state.file.path;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  state.busy = true; render();
  try {
    if (which === 'keepLocal') {
      // 这两笔里第一笔是**更新**（带 sha），第二笔是**新建**（不带 sha → 服务端走 POST）
      await writeFile(base, c.local, c.remote.sha, commitMessage.keepLocal(base));
      await createFile(stem + '.conflict.md', c.remote.content, commitMessage.copySheet(stem + '.conflict.md'));
      toast('已保留本地版本，远端存为 ' + stem + '.conflict.md');
    } else {
      await createFile(stem + '.local.md', c.local, commitMessage.copySheet(stem + '.local.md'));
      toast('已保留远端版本，本地存为 ' + stem + '.local.md');
    }
    await openFile(base);
  } catch (e) {
    toast(e.message);
  }
  state.busy = false; render();
}

/* ---------- 渲染 ---------- */

function render() {
  syncEditorChrome(); // #65：编辑 / 冲突态锁死侧栏（☰ 显隐、动作区容器），见末尾接线块
  syncFileOpsLayer(); // #66：常驻浮层同步（在 app.innerHTML 重画之外，#dlg-input 不换节点）
  // #64：阅读加载 / 三档失败落位优先；其次是没打开笔记时的空状态。
  // 成功打开后 readState=null、emptyActive=false、view=editor，落到原 renderEditor()，
  // 正文渲染结果与改动前逐字节一致（本票不碰 md 实例 / 插件顺序 / <article class="md">）。
  if (state.readState) { renderReadState(); return; }
  if (state.emptyActive && state.view !== 'editor') { renderEmptyState(); return; }
  if (state.view === 'editor') renderEditor();
  else showEmptyState(); // 评审修复收尾：不该出现的 view 一律落空状态，不再掉回 renderList() 旧整页列表
}

/**
 * 关掉这篇（评审修复第 1 条）：界面「‹ 返回」与系统返回共用这一处。
 * 右侧回空状态、地址栏回根、侧栏按定稿保持（不强行关）。
 * 不新增历史：用 replaceState 把「当前这一条」钉成根 —— 不用 location.hash=
 * （会 push 一条，点完再按系统返回那篇又打开一次，design-brief 附录 B 第 513 行
 * 点名的毛病），也不用 history.back()（系统返回时浏览器已自行回退一条，再叠一次
 * 就退两层 / 制造「按了没反应」）。旧规矩「返回＝回目录」整条作废。
 */
function closeNote(href) {
  state.view = 'list';
  state.readState = null;
  try {
    history.replaceState(history.state, '', location.pathname + location.search + (href || CLOSE_NOTE_HREF));
  } catch (_) { /* 老环境忽略 */ }
  showEmptyState();
}

function crumbs(path) {
  const parts = path ? path.split('/').filter(Boolean) : [];
  let html = '<a href="#/">根</a>';
  let acc = '';
  parts.forEach((p, i) => {
    acc += (acc ? '/' : '') + p;
    html += ' <span class="sep">/</span> <a href="#/dir/' + encodeURIComponent(acc) + '">' + esc(p) + '</a>';
  });
  return html;
}

function renderToast() {
  if (!state.message) return '';
  const act = state.toastAction
    ? '<button class="toast-act" data-act="toastAction">' + esc(state.toastAction.label) + '</button>'
    : '';
  return '<div class="toast' + (act ? ' with-act' : '') + '"><span class="toast-txt">' +
    esc(state.message) + '</span>' + act + '</div>';
}

function renderList() {
  const sorted = [...state.entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  // 行拆成两段：能点的链接区 + 行尾的操作区。
  // 这两段必须是**兄弟**——按钮塞进 <a> 里是非法嵌套，点按钮会顺手把笔记也打开。
  const items = sorted.map((e) => {
    // 评审修复第 5 条：行图标改用 icons.js 的自绘 SVG，不再用 ▸/¶/· 字符。
    // 局部变量叫 glyph，别遮蔽顶部 import 的 icon()。
    const glyph = e.type === 'dir' ? icon('folder', 18) : icon('note', 18);
    // 目录行不给「⋯」：目录的改名 / 移动 / 删除都要逐个文件重写（Gitee 没有目录级动作）,
    // 本版不做。放一个只会说「不支持」的按钮，比没有按钮更烦人。
    const more = e.type === 'dir'
      ? ''
      : '<button class="row-more" data-more="' + esc(e.path) + '" aria-label="更多操作">' + icon('more', 20) + '</button>';
    if (e.type === 'dir') {
      return '<div class="row"><a class="row-main" href="#/dir/' + encodeURIComponent(e.path) + '"><span class="ic dir" aria-hidden="true">' + glyph + '</span><span class="nm">' + esc(e.name) + '</span></a></div>';
    }
    if (e.name.endsWith('.md')) {
      return '<div class="row"><a class="row-main" href="#/edit/' + encodeURIComponent(e.path) + '"><span class="ic md" aria-hidden="true">' + glyph + '</span><span class="nm">' + esc(e.name) + '</span></a>' + more + '</div>';
    }
    return '<div class="row dim"><span class="row-main"><span class="ic" aria-hidden="true">' + glyph + '</span><span class="nm">' + esc(e.name) + '</span></span>' + more + '</div>';
  }).join('');

  // 搜索框常驻在这一页顶部（#16 定的入口）。有词的时候正文区换成结果——
  // 面包屑此时收起来：结果的上下文是「哪几篇」，不是「现在站在哪个目录」。
  const searching = !!normalizeQuery(state.query);

  // 骨架只建一次；之后每次重画只换内容区（见上面那段注释：搜索框那个节点不能换）
  if (!document.getElementById('list-main')) {
    app.innerHTML = listShellHtml();
    wireSearch();
  }

  const inp = document.getElementById('q');
  // 组字中绝不碰它的值——那会把输入法正在拼的东西抹掉
  if (!searchComposing && inp.value !== state.query) inp.value = state.query;
  document.getElementById('q-clear').hidden = !state.query;

  const crumbsEl = document.getElementById('list-crumbs');
  crumbsEl.innerHTML = crumbs(state.path);
  crumbsEl.hidden = searching;

  document.getElementById('list-main').innerHTML = searching
    ? renderResults()
    : (state.busy ? '<div class="center">加载中…</div>' : (items || '<div class="center dim">（空目录）</div>'));

  // 新建只在目录页出现（笔记页没有它），搜索时也收起来——它跟结果无关。
  // 显隐由滚动方向决定，见 onScroll。
  document.getElementById('fab-new').hidden = searching;
  document.getElementById('list-overlays').innerHTML = renderOverlays();
  document.getElementById('list-toast').innerHTML = renderToast();

  applyFab();
  wireDialog();
}

/* ---------- 文件操作的浮层：常驻层 + 操作表 / 弹窗 / 目录选择器（#66） ---------- */

/**
 * #66 常驻浮层同步：把 state.dialog 经 dialogView() 机械写到 #fo-modal 各常驻节点，
 * 操作表 / 目录选择器 HTML 写进各自宿主。**#dlg-input 只在「新打开」(fresh) 时设 value
 * 并聚焦，其余重画绝不覆盖** —— 中文拼音组字不中断、撞名拒绝也不把名字改掉。
 * 目录选择器打开时弹窗暂时收起（同一常驻浮层里就地切换），选完带着新目录回来。
 */
function syncFileOpsLayer() {
  const layer = document.getElementById('file-ops-layer');
  if (!layer) return;
  const d = state.dialog;
  const v = dialogView(d);
  const byId = (id) => document.getElementById(id);
  const setHidden = (id, hidden) => { const n = byId(id); if (n) n.hidden = hidden; };
  const setText = (id, text) => { const n = byId(id); if (n) n.textContent = text; };

  const showModal = v.show && !state.picker; // 选目录时弹窗收起，只显示选择器
  // 先让常驻层可见再 focus：祖先还是 display:none 时 element.focus() 不生效，
  // 首次打开弹窗会落不到焦点（输入框聚焦是判据 4「名字输入框已聚焦」）。
  layer.hidden = !(showModal || state.ops || state.picker);
  const mask = layer.querySelector('.fo-mask');
  if (mask) mask.hidden = !showModal;
  setHidden('fo-modal', !showModal);

  if (v.show) {
    setText('fo-title', v.title);
    setHidden('fo-hint', !v.showHint);
    setText('fo-hint', v.hint);
    setHidden('fo-warn', !v.showWarn);
    setText('fo-warn', v.warn);
    setHidden('fo-body', !v.showBody);
    const body = byId('fo-body');
    if (body) body.innerHTML = v.bodyHtml; // 删除正文含 <b>撤销</b>（renderEmphasis 已转义）
    setHidden('dlg-input', !v.showInput);
    const inp = byId('dlg-input');
    if (inp && v.fresh) { inp.value = v.value; inp.focus(); }
    setHidden('fo-dir', !v.showDir);
    setText('fo-dir-label', v.dirLabel);
    setText('fo-err', v.error);
    const ok = byId('fo-ok');
    if (ok) { ok.textContent = v.okLabel; ok.className = v.okClass; ok.dataset.act = v.okAct; }
  }
  if (d && d.__fresh) d.__fresh = false; // 后续重画不再覆盖正在组字的输入框

  const opsHost = byId('fo-ops-host');
  if (opsHost) opsHost.innerHTML = renderOps();
  const pickerHost = byId('fo-picker-host');
  if (pickerHost) pickerHost.innerHTML = renderPicker();
}

/** #66：浮层已迁到 body 末尾的常驻层，这里留空——避免 app.innerHTML 重画时换掉 #dlg-input。 */
function renderOverlays() {
  return '';
}

/** 「⋯」点开的操作表。三个动作，编辑 / 冲突态置灰但仍能按（与 #65 同一句锁提示）。 */
function renderOps() {
  if (!state.ops) return '';
  return opsSheetHtml({
    name: baseOf(state.ops.path),
    locked: isLocked(),
    lockedHint: EDIT_COPY.fileOpsHint,
  });
}

/** #66：弹窗由 syncFileOpsLayer() + dialogView() 同步到常驻 #fo-modal，不再返回 HTML。 */
function renderDialog() {
  return '';
}

/** 目录选择器：复用今天「移动笔记」那套（逐层 / 上一级 / 就放这里 /「（没有子目录）」）。 */
function renderPicker() {
  return state.picker ? pickerHtml(state.picker) : '';
}

/** #66：#dlg-input 常驻，input / keydown 已在 mountFileOpsLayer 里一次性绑定，
 *  value 与聚焦由 syncFileOpsLayer() 的 fresh 分支处理；这里不再重复绑定、不换节点。 */
function wireDialog() {
  // 有意留空：保留既有调用点，避免每次 render 重复 addEventListener 把组字打断。
}

/* ---------- 文件操作：#26 的四个动作 ---------- */
//
// 两条硬规矩，四条路都照做：
//   1. **每一步写都带 sha 核对**。不带 sha 的那次只用于「建新文件」——那是唯一一件
//      没有旧版本可比的事。不为了历史好看改用 Gitee 的批量提交端点，那个不核对版本。
//   2. **多步操作先做不会造成损失的那一步**。改名 / 移动一律「先建新、再删旧」：
//      第二步失败时库里只多一份副本，看得见也删得掉；反过来先删就会真的丢东西。

function closeOverlays() {
  state.ops = null;
  state.dialog = null;
  state.picker = null;
}

/** #66 新建：落点只读「选中的文件夹」与设置里的「指定目录」，绝不读打开的那篇路径。 */
function openCreate({ skipCheck = false } = {}) {
  state.ops = null;
  state.picker = null;
  const target = getNewNoteTarget();
  state.dialog = Object.assign(
    createDialogModel({ selectedFolder: getSelectedFolder(), target }),
    { __fresh: true },
  );
  // 打开新建弹窗那一刻派发核对事件（#63 的 initSettings 已监听：指定目录在不在、
  // 三态与两条出路文案；断网一律说「连不上」）。
  if (!skipCheck) {
    document.dispatchEvent(new CustomEvent(NEW_TARGET_CHECK_EVENT, {
      detail: newNoteTargetCheckDetail(target),
    }));
  }
  render();
}

function openRename(path) {
  state.ops = null;
  state.dialog = Object.assign(renameDialogModel({ path }), { __fresh: true });
  render();
}

/** #66 移动：与新建同一形态（名字 + 已填好的目录，目录就在弹窗里改），不再另起二级确认。 */
function openMove(path) {
  state.ops = null;
  state.dialog = Object.assign(moveDialogModel({ path }), { __fresh: true });
  render();
}

function openDelete(path) {
  state.ops = null;
  state.dialog = deleteDialogModel({ path });
  render();
}

/** 弹窗的「确定」。填名字的动作先过一遍本地规则，省一次注定失败的写。 */
async function submitDialog() {
  const d = state.dialog;
  if (!d || d.type !== 'prompt') return;
  const n = normalizeNewName(d.value);
  if (!n.ok) { d.error = n.error; render(); return; }
  if (d.action === 'create') await doCreate(d.dir, n.name); // 落点取弹窗里的目录，绝不读 state.path
  else if (d.action === 'rename') await doRename(d.subject, n.name);
  else if (d.action === 'move') {
    const to = joinPath(d.dir, n.name); // 目录就在弹窗里改，名字沿用预填（可改）
    if (to === d.subject) { toast('位置没变'); render(); return; }
    await doMove(d.subject, to);
  }
}

async function confirmDialog() {
  const d = state.dialog;
  if (!d || d.type !== 'confirm') return;
  if (d.action === 'delete') await doDelete(d.subject);
  // #66 移动已改成与新建同形态的 prompt 弹窗（submitDialog 处理），不再走 confirm
}

/* ---------- 新建 ---------- */

async function doCreate(dir, name) {
  const path = joinPath(dir, name);
  const prev = state.dialog; // 撞名重开时保留用户原始输入 / 改过的目录，不改名字
  closeOverlays();
  state.busy = true; render();
  try {
    // Gitee 不收空内容（`400 content is empty`），一篇空笔记得至少写一个换行
    await createFile(path, '\n', commitMessage.create(path));
  } catch (e) {
    state.busy = false;
    if (e.exists) {
      // 撞名 → 拒绝并说「这个名字已经有了」：不自动加后缀、不二次确认、不改名字。
      // __fresh:false + 常驻 #dlg-input → 正在组字的名字原样保留，不覆盖。
      state.dialog = Object.assign(
        {}, prev || createDialogModel({ selectedFolder: getSelectedFolder(), target: getNewNoteTarget() }),
        { error: TEXT.duplicate, __fresh: false },
      );
    } else {
      toast('没建成：' + e.message);
    }
    render();
    return;
  }
  state.busy = false;
  refreshTree(); // #66 写后树就地刷新
  // 新建完直接进这篇、并且直接进编辑态：空笔记停在阅读态没有意义。
  state.openInEdit = path;
  location.hash = '#/edit/' + encodeURIComponent(path);
  toast(createdToast(name));
}

/* ---------- 删除（含撤销） ---------- */

async function doDelete(path) {
  closeOverlays();
  state.busy = true; render();
  let src;
  try {
    // 删除前多读一遍正文：撤销要用它重建。顺带拿到当前 sha——删这一步必须带 sha 核对，
    // 用旧 sha 会被 Gitee 挡下来（`Blob SHA does not match`），而那道挡是对的：
    // 这篇要是在别处被改过，直接删就把别人的改动一起删了。
    src = await readFile(path);
  } catch (e) {
    state.busy = false; toast('没删成：' + e.message); render(); return;
  }
  try {
    await deleteFile(src.path, src.sha, commitMessage.remove(path));
  } catch (e) {
    state.busy = false;
    toast(e.conflict ? '这篇在别处被改过，先打开看一眼再删' : '没删成：' + e.message);
    render();
    return;
  }
  state.undo = { path: src.path, content: src.content, dir: dirOf(path) };
  state.busy = false;
  removeRecentFromStore(path); // #64 应用内删掉的那篇（含正在读的）→ 从最近打开去掉那条
  // #66：删完右侧回空状态、侧栏不关、树里选中退回它所在的文件夹（作废旧规矩「回目录」）。
  setSelectedFolder(state.undo.dir);
  refreshTree();               // 写后树就地刷新
  state.view = 'list';         // 不再停留在已删那篇的阅读 / 编辑态
  showEmptyState();            // 右侧空状态（保留 #64 最近列表落位）
  toast(deleteSuccess(baseOf(path)), { label: TEXT.undoAction, run: undoDelete });
}

async function undoDelete() {
  const u = state.undo;
  if (!u) return;
  state.undo = null;
  state.busy = true; render();
  try {
    // 一次新建就是全部——内容照原样放回去。
    // 原本是 0 字节的文件只能回来成一个空行：Gitee 建不出空内容的文件（实测）。
    await createFile(u.path, u.content || '\n', commitMessage.undoDelete(u.path));
    state.busy = false;
    refreshTree(); // #66 写后树就地刷新
    toast('已恢复 ' + baseOf(u.path));
  } catch (e) {
    state.busy = false;
    toast(e.exists ? '没能恢复：那个位置上又有东西了' : '没能恢复：' + e.message);
  }
  render();
}

/* ---------- 重命名 / 移动：都是「先建新、再删旧」 ---------- */

async function doRename(oldPath, newName) {
  const dir = dirOf(oldPath);
  const next = renameTarget(oldPath, newName);
  const prev = state.dialog; // 撞名重开时保留输入的名字，不改名、不自动加后缀
  closeOverlays();
  if (next === oldPath) { toast('名字没变'); render(); return; }
  state.busy = true; render();
  try {
    // 先确认新名字没被占。这一步是读，失败了不会留下半成品
    const entries = await listDir(dir);
    if (hasName(entries, newName, { except: oldPath })) {
      state.busy = false;
      state.ops = null;
      state.dialog = Object.assign({}, prev || renameDialogModel({ path: oldPath }),
        { error: TEXT.duplicate, __fresh: false });
      return render();
    }
  } catch (e) {
    state.busy = false; toast('没能开始：' + e.message); render(); return;
  }
  await relocate(oldPath, next, 'rename');
}

async function doMove(from, to) {
  closeOverlays();
  await relocate(from, to, 'move');
}

/**
 * 改名 / 移动的执行体。两步，顺序不能反。
 * @param {'rename'|'move'} verb
 */
async function relocate(from, to, verb) {
  state.busy = true; render();
  let src;
  try {
    // 正文与最新 sha 都现读：删旧那一步要用当前 sha，拿旧的会在半路上被 Gitee 挡下，
    // 那时候新的已经建好了，就等于白留一份副本。
    src = await readFile(from);
  } catch (e) {
    state.busy = false; toast('没能开始：' + e.message); render(); return;
  }
  const msg = verb === 'rename' ? commitMessage.rename(from, to) : commitMessage.move(from, to);

  // 第一步：建新路径。这一步失败等于什么都没发生
  try {
    await createFile(to, src.content, msg);
  } catch (e) {
    state.busy = false;
    toast(e.exists ? '那边已经有同名的了，没有改动' : '没有改动：新的那份没建起来（' + e.message + '）');
    refreshTree(); // #66 写后树就地刷新（这一步没建起来，也把当前名单对齐）
    render();
    return;
  }

  // 第二步：删旧路径。这一步失败库里会同时有新、旧两份——提示必须说清停在这儿，
  // 一句「失败」会让人以为什么都没动，然后下一次操作就把这个副本忘了
  try {
    await deleteFile(from, src.sha, msg);
  } catch (e) {
    state.busy = false;
    toast('新名字已经建好，旧的那份没删掉：' + e.message + '，现在两份都在');
    refreshTree(); // #66 半成品也刷树，让多出来的那份看得见、删得掉
    render();
    return;
  }

  state.busy = false;
  replaceRecentPathInStore(from, to); // #64 改名 / 移动 → 直接换成新路径（搬走的不追）
  // #66：右侧打开新路径、树里选中它、地址栏跟着换；不追旧链接、不报断链数。
  selectPath(to);
  refreshTree();
  location.hash = '#/edit/' + encodeURIComponent(to);
  toast(verb === 'rename' ? '已改名为 ' + baseOf(to) : '已移到 ' + (dirOf(to) || '根目录'));
}

/* ---------- 移动用的目录选择器 ---------- */

/** #66 目录选择器：从弹窗的目录块就地打开（onPick='dialog'），或 #63「指定目录」入口（onPick='settings'）。 */
function openPicker({ dir = '', onPick = 'dialog' } = {}) {
  state.ops = null;
  state.picker = { dir, entries: [], busy: true, error: '', onPick };
  render();
  loadPickerDir(dir);
}

async function loadPickerDir(dir) {
  const p = state.picker;
  if (!p) return;
  p.dir = dir; p.busy = true; p.error = ''; render();
  try {
    p.entries = await listDir(dir);
  } catch (e) {
    p.entries = [];
    p.error = '目录没读到：' + e.message;
  }
  p.busy = false; render();
}

/** 「就放这里」——目录回填到弹窗（就地改，不 confirm），或写回设置的「指定目录」。 */
function pickerMoveHere() {
  const p = state.picker;
  if (!p) return;
  // 还没读完就不能答应：清单没到手时判不了重名，也不该装作没听见
  if (p.busy) { p.error = '这个目录还没读完，稍等一下'; render(); return; }
  const dir = p.dir;
  if (p.onPick === 'settings') {
    // #63「指定目录」入口：把选中的目录写回设置（fixed 档），不改这一次
    setNewNoteTarget({ mode: 'fixed', dir });
    state.picker = null;
    render();
    return;
  }
  // 弹窗里的目录块（新建 / 移动同形态）：把目录回填到弹窗，目录就地改完，
  // 不另起二级确认；重名在 submitDialog 里判。
  const d = state.dialog;
  if (d) {
    d.dir = dir;
    if (d.action === 'create') d.hint = createHint(dir);
  }
  state.picker = null;
  render();
}

/* ---------- 悬浮「新建」按钮的显隐 ---------- */
//
// 向下滚就收起（把内容让出来），向上滚约 50px 再出现（想操作了）；
// 内容不足一屏、页面根本滚不动时**始终显示**——否则那个按钮永远出不来。
const FAB_REVEAL_PX = 50;
let fabVisible = true;
let fabAccum = 0;
let fabLastY = 0;

function pageScrollable() {
  return document.documentElement.scrollHeight - window.innerHeight > 4;
}

function applyFab() {
  const el = document.getElementById('fab-new');
  if (!el) return;
  el.classList.toggle('fab-hidden', !(!pageScrollable() || fabVisible));
}

/** 换一屏（进新目录）就回到默认：露着。 */
function resetFab() {
  fabVisible = true;
  fabAccum = 0;
  fabLastY = window.scrollY;
}

function onScroll() {
  const y = window.scrollY;
  const dy = y - fabLastY;
  fabLastY = y;
  if (!pageScrollable()) {
    fabVisible = true;
  } else if (dy > 0) {
    fabAccum = 0; fabVisible = false;
  } else if (dy < 0) {
    fabAccum += -dy;
    if (fabAccum >= FAB_REVEAL_PX) fabVisible = true;
  }
  applyFab();
}
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);

/* ---------- 待办勾选框（#13/#27/#28/#60） ---------- */
//
// 点一个存一个（#13 定稿）：点下立即在页面上勾上（乐观）。#60 起「先记本机、送到再划掉」：
// 每一笔记住自己是哪篇、第几行、勾成什么、点下那一刻那篇的版本号；提交时不再读屏幕，
// 换过篇也不会把甲篇的改动 / 版本号安到乙篇头上。按篇聚合、补发、合并、送不到判定
// 全住在 pending-checks.js，这里只做一处接线。
const pendingChecks = createPendingChecks({
  storage: window.localStorage,
  readFile,
  writeFile,
  toast,
  openNote: (path) => { location.hash = '#/edit/' + encodeURIComponent(path); },
  getScreen: () => ({ view: state.view, path: state.path, mode: state.mode }),
  setScreenSha: (sha) => { if (state.file) state.file.sha = sha; },
});

/** 点了某个方框：先乐观切换这一行，再记一笔待发并立刻发送。 */
function onTaskClick(line) {
  if (state.view !== 'editor' || state.mode !== 'read') return;
  const prev = state.file.content;
  const next = toggleTaskInContent(prev, line);
  if (next === null) return; // 行上没有标记（内容被别处改过）——不动
  // 提交信息按「这一勾的结果」选词，点下时就定下来，之后正文再变也不影响它
  const done = isTaskDoneLine(next.split('\n')[line]);
  const y = window.scrollY;
  state.file.content = next;
  render();
  window.scrollTo(0, y);
  pendingChecks.record({
    path: state.file.path,
    sha: state.file.sha,
    line,
    done,
    content: next, // 那一刻的正文只留内存供这一次发送，不落本机
  });
}

function renderEditor() {
  // #65：动作区落在 #61 骨架层的 #edit-actions（在 #app 之外、节点常驻、随可见
  // 视口移动），不再写进 #app 的 .foot——重画正文永不碰动作区，也不换输入框节点。
  // 冲突逐字比对界面与预览层内部一个字不改，只换落位。
  const actionsHost = document.getElementById('edit-actions');

  if (state.mode === 'conflict') {
    // C-4：顶上那颗「返回」退回编辑态（草稿原样、不加提示），不回目录。
    // #68：那颗按钮住在骨架顶栏（#btn-layer-back）——正文不再画第二条栏，
    // 篇名与它都由 syncEditorChrome() 按 state.mode 同步，这里一个字都不写。
    app.innerHTML =
      '<main class="editor-body">' + renderConflict() + '</main>' +
      renderToast();
    if (actionsHost) actionsHost.innerHTML = '<button class="primary" id="preview-btn">预览改动处理</button>';
    const pb = document.getElementById('preview-btn');
    if (pb) pb.addEventListener('click', () => { state.conflict.previewOpen = !state.conflict.previewOpen; state.conflict.copyPrompt = false; render(); });
    if (state.activeFrag != null) requestAnimationFrame(positionBubble);
    return;
  }

  const body = state.mode === 'read'
    ? '<article class="md">' + md.render(state.file.content, { notePath: state.path }) + '</article>'
    : '<textarea class="editor" id="editor">' + esc(state.draft) + '</textarea>';

  // 阅读态的「编辑」要先读一次最新版（#34 / #65），按钮有「读取中…」忙态；
  // 读不到就停在阅读态，落位一句说明并给「重试」，不进编辑。
  const actions = state.mode === 'read'
    ? (state.editChecking
      ? '<button class="primary" id="edit-btn" disabled>读取中…</button>'
      : (state.editReadError
        ? '<span class="action-note">' + esc(state.editReadError) + '</span>' +
          '<button class="primary" id="edit-btn">重试</button>'
        : '<button class="primary" id="edit-btn">编辑</button>'))
    : '<button id="cancel-btn">取消</button><button class="primary" id="save-btn">保存</button>';

  // 评审修复第 5 条：正文顶栏的「⋯」收口成骨架 layout.js 的 #btn-more（自绘 SVG、
  // 常驻在 #app 之外），即 #66 第 1 条的「主入口」；本处不再画第二颗字符「⋯」。
  // 编辑 / 冲突态的置灰仍按 isLocked() 单一真相，由末尾 syncEditorChrome() 把
  // is-disabled 类同步到 #btn-more；点开后的三个动作置灰与「先保存或取消，再改文件」
  // 锁提示走 renderOps() / [data-op]（#65/#66 同一口径），不另造一套锁判定。

  // 阅读态左上「‹ 返回」＝关掉这篇（评审修复第 1 条：与系统返回共用 closeNote()，
  // 不再用 href 跳回所在目录、也不新增历史）；编辑态换成「退出编辑」——手机上
  // 左上角那颗是回阅读态，不是「关掉这篇」，返回永远只退一层。
  // #68：这两个动作都不再画在正文里。阅读态按原型**不留返回键**（关掉这篇交给系统
  // 返回，见文件末尾的占位历史），编辑态那颗移到骨架顶栏；这里只留正文本身。
  app.innerHTML =
    '<main class="editor-body">' + body + '</main>' +
    renderOverlays() +
    renderToast();

  if (actionsHost) actionsHost.innerHTML = actions;

  const ta = document.getElementById('editor');
  if (ta) {
    ta.value = state.draft;
    ta.addEventListener('input', () => { state.draft = ta.value; });
  }
  const eb = document.getElementById('edit-btn');
  if (eb) eb.addEventListener('click', startEdit);
  const cb = document.getElementById('cancel-btn');
  if (cb) cb.addEventListener('click', exitEdit); // #65：有改动先问「放弃改动？」
  const sb = document.getElementById('save-btn');
  if (sb) sb.addEventListener('click', save);
  wireDialog();
}

/* ---------- 冲突合并渲染 ---------- */
function renderConflict() {
  const c = state.conflict;
  let html = '<div class="conflict-head">提交冲突 · 左右对照 · 点差异裁决</div>';
  html += '<div class="legend">' +
    '<span><span class="sw ld"></span>本地改动</span>' +
    '<span><span class="sw rd"></span>远端改动</span>' +
    '<span><span class="sw ac"></span>已采纳</span>' +
    '</div>';
  html += '<div class="merge-cols">';
  html += '<div class="merge-col"><div class="merge-col-head">本地版本（你的改动）</div><div class="merge-col-body">';
  for (const f of c.fragments) {
    if (f.type === 'equal') html += '<span>' + esc(f.text) + '</span>';
    else if (f.type === 'del') html += renderFrag(c, f, 'del');
  }
  html += '</div></div>';
  html += '<div class="merge-col"><div class="merge-col-head">远端版本（PC 改动）</div><div class="merge-col-body">';
  for (const f of c.fragments) {
    if (f.type === 'equal') html += '<span>' + esc(f.text) + '</span>';
    else if (f.type === 'ins') html += renderFrag(c, f, 'ins');
  }
  html += '</div></div>';
  html += '</div>';
  html += renderBubble();
  html += renderPreviewSheet();
  return html;
}

function renderFrag(c, f, cls) {
  const dec = (c.decisions[f.id] || {}).decision;
  let cl = 'frag ' + cls, mark = '';
  if (dec === 'accept') { cl += ' acc'; mark = '<em>已采纳</em>'; }
  else if (dec === 'reject') { cl += ' rej'; mark = '<em>已不采纳</em>'; }
  return '<span class="' + cl + '" data-fid="' + f.id + '">' + esc(f.text) + mark + '</span>';
}

function renderBubble() {
  if (state.activeFrag == null) return '';
  const f = state.conflict.fragments.find(x => x.id === state.activeFrag);
  if (!f || f.type === 'equal') return '';
  const dec = (state.conflict.decisions[f.id] || {}).decision;
  let btns = '';
  if (dec == null) btns = '<button data-d="accept">采纳</button><button data-d="reject">不采纳</button>';
  else if (dec === 'accept') btns = '<button data-d="cancel">取消采纳</button>';
  else btns = '<button data-d="cancel">取消不采纳</button>';
  return '<div class="bubble" id="bubble">' + btns + '</div>';
}

function renderPreviewSheet() {
  const c = state.conflict;
  if (!c.previewOpen) return '';
  const unresolved = !isAllResolved(c);
  const preview = computeMerged(c) + (unresolved ? '\n\n[ 还有差异未处理 ]' : '');
  let foot = '';
  if (c.copyPrompt) {
    foot = '<div class="copy-options">' +
      '<button data-copy="keepLocal">保留本地版本、远端存为副本</button>' +
      '<button data-copy="keepRemote">保留远端版本、本地存为副本</button>' +
      '</div>';
  } else {
    foot = '<div class="sheet-row">' +
      '<button data-act="closePreview">收起预览</button>' +
      '<button class="primary" data-act="commitMerge" ' + (unresolved ? 'disabled' : '') + '>提交合并</button>' +
      '<button data-act="openCopy">另存副本</button>' +
      '</div>';
  }
  return '<div class="sheet-mask" data-act="closePreview"></div>' +
    '<div class="sheet">' +
    '<div class="sheet-head">改动处理预览</div>' +
    (unresolved ? '<div class="sheet-unresolved">处理完所有 diff 才能提交合并</div>' : '') +
    '<div class="sheet-body">' + esc(preview) + '</div>' +
    '<div class="sheet-foot">' + foot + '</div>' +
    '</div>';
}

function positionBubble() {
  const fragEl = document.querySelector('[data-fid="' + state.activeFrag + '"]');
  const bubble = document.getElementById('bubble');
  if (!fragEl || !bubble) return;
  const f = fragEl.getBoundingClientRect();
  let left = f.left;
  const bw = bubble.offsetWidth;
  if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;
  if (left < 8) left = 8;
  bubble.style.left = left + 'px';
  bubble.style.top = (f.bottom + 4) + 'px';
  bubble.style.position = 'fixed';
}

document.addEventListener('click', async (e) => {
  // 搜索结果：先记下「点了哪一篇的哪个词」，打开后据此滚到命中那一段（不拦默认跳转）
  const resHit = e.target.closest('[data-hit]');
  if (resHit) state.pendingHit = { path: resHit.dataset.hit, query: resHit.dataset.hitq || '' };

  const dbtn = e.target.closest('[data-d]');
  if (dbtn) { decide(state.activeFrag, dbtn.dataset.d); return; }
  const frag = e.target.closest('[data-fid]');
  if (frag) {
    const fid = +frag.dataset.fid;
    state.activeFrag = (state.activeFrag === fid) ? null : fid;
    render();
    return;
  }
  // 待办勾选框：只有阅读态渲染得出它，编辑态 / 冲突态都没有
  const taskBox = e.target.closest('[data-task-line]');
  if (taskBox) { onTaskClick(+taskBox.dataset.taskLine); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    switch (a) {
      case 'closePreview': state.conflict.previewOpen = false; state.conflict.copyPrompt = false; render(); break;
      case 'commitMerge': commitMerge(); break;
      case 'openCopy': state.conflict.copyPrompt = true; render(); break;
      // ---- #26 / #66 文件操作 ----
      case 'newFile': openCreate(); break;
      case 'closeOps': state.ops = null; render(); break;
      case 'closeDialog': closeOverlays(); render(); break;  // 收起全部浮层，不清撤销提示
      case 'closePicker': state.picker = null; render(); break; // 只关选择器，弹窗带目录回来
      case 'pickDir': // 弹窗里的目录块：就地打开目录选择器改这一次
        openPicker({ dir: state.dialog ? state.dialog.dir : '', onPick: 'dialog' });
        break;
      case 'submitDialog': submitDialog(); break;
      case 'confirmDialog': confirmDialog(); break;
      case 'moveHere': pickerMoveHere(); break;
      // ---- 搜索（#33） ----
      case 'clearQuery': state.query = ''; onQueryChanged(); break;
      case 'toastAction': {
        const t = state.toastAction;
        state.toastAction = null;
        if (t) t.run();
        break;
      }
    }
    return;
  }
  // 「⋯」：按钮是行链接的**兄弟**节点，所以点它不会顺带把笔记打开
  const moreBtn = e.target.closest('[data-more]');
  if (moreBtn) { state.ops = { path: moreBtn.dataset.more }; render(); return; }
  const opBtn = e.target.closest('[data-op]');
  if (opBtn) {
    // #65：编辑 / 冲突态锁死，三个动作置灰但仍能按，按了给这一句（判据 7）。
    // 不自动先保存再执行；判定走 editor-guard 的 isLocked()，不另读 state.mode。
    if (isLocked()) { toast(EDIT_COPY.fileOpsHint); return; }
    const subject = state.ops ? state.ops.path : state.path;
    const op = opBtn.dataset.op;
    if (op === 'rename') openRename(subject);
    else if (op === 'move') openMove(subject); // #66：与新建同形态的弹窗，不另起目录确认
    else if (op === 'delete') openDelete(subject);
    return;
  }
  const enter = e.target.closest('[data-enter]');
  if (enter) { loadPickerDir(enter.dataset.enter); return; }
  const copy = e.target.closest('[data-copy]');
  if (copy) { saveCopy(copy.dataset.copy); return; }
  // 解不开的双链：不是链接，但点一下要说清它想指向谁（#7 保持这一行为）
  const dead = e.target.closest('[data-wikilink-broken]');
  if (dead) { e.preventDefault(); toast('文件不存在：' + dead.dataset.wikilinkBroken); return; }
  // 可达的笔记双链，以及索引未就绪时渲染出来的中性链接（后者在这里重试一次索引）
  const link = e.target.closest('[data-wikilink]');
  if (!link) return;
  e.preventDefault();
  await followWikilink(link.dataset.wikilink);
});

async function followWikilink(target) {
  let idx = wikilinkIndex;
  if (!idx) {
    try { idx = await ensureIndex(); }
    catch (e) { toast('索引加载失败，暂时打不开链接'); return; }
  }
  const hit = lookupWikilink(idx, target, state.path);
  if (hit.kind === 'note') { location.hash = '#/edit/' + encodeURIComponent(hit.path); return; }
  // 仓库内非笔记文件：渲染时给的是 <a href>，只有索引未就绪那条路才走到这里
  if (hit.kind === 'file') { window.open(rawUrl(hit.path), '_blank', 'noopener'); return; }
  toast('文件不存在：' + target);
}

// 索引预热：全树拉一次要 3~5 秒，趁用户翻目录时先跑起来，打开第一篇笔记时多半已就绪。
// 失败不在这里报——它会以中性「不知道」呈现，点击时还有一次重试（见 ensureIndex）。
ensureIndex().catch(() => {});

/* ---------- 切回这个标签页时顺带查一次（#32 §4 定的刷新时机） ---------- */
//
// 不做定时轮询：手机上的习惯是标签页挂着不关，而挂后台的页面会被系统冻结、定时器靠不住。
// 所以改在每次切回来时，走一遍那条很轻的「仓库最新版本身份」检查——同打开应用时那条路。
async function recheckRepo() {
  let head;
  try {
    head = await listHead();
  } catch (e) {
    onlineCache = { at: Date.now(), ok: false }; // 身份都问不到 = 断网，搜索跟着停
    return;
  }
  onlineCache = { at: Date.now(), ok: true };
  if (head.sha === lastHead) return;
  lastHead = head.sha;
  ensureIndex({ force: true }).catch(() => {}); // 清单变了要重建
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheckRepo();
});
// #60：切回前台补发没送到的勾选（与上面那条版本身份检查各管各的）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pendingChecks.replay();
});

window.addEventListener('hashchange', navigate);

/* ---------- #64：空状态与阅读态失败落位（只在这里接线，不改上面的函数体） ---------- */

// 本机的「最近打开」只有路径；已失效标注是内存态（上一次核对的结论，不写盘、不是永久判决）。
let recentPaths = readRecent();
let recentInvalid = new Set();

function recordOpen(path) {
  recentPaths = addRecent(recentPaths, path);
  writeRecent(recentPaths);
}
function removeRecentFromStore(path) {
  recentPaths = removeRecent(recentPaths, path);
  recentInvalid.delete(path);
  writeRecent(recentPaths);
  if (state.emptyActive) render();
}
function replaceRecentPathInStore(from, to) {
  recentPaths = replaceRecentPath(recentPaths, from, to);
  recentInvalid.delete(from);
  writeRecent(recentPaths);
}

// 真 probe：复用 GET /api/file?path= 的 404。成功 = 在；404 = 确认真不在；
// 断网 / 5xx / 要密码一律「问不到」，由 checkRecents 整批不标失效、不弹提示。
function recentProbe(path) {
  return readFile(path).then(
    () => null,
    (e) => ({ status: e && e.status, notFound: e && e.notFound, message: e && e.message })
  );
}

// 空状态出现的那一刻：先立即画完整空状态（首次无记录也不转圈、不像出错），
// 再后台并行各问一次；一分钟内同批不重复（checkRecents 自己判）。核对期间不显示
// 「核对中」，条目不闪不灰不挡；结果到了就地标「已失效」；问不到整批不标、不弹提示。
function showEmptyState() {
  state.readState = null;
  state.emptyActive = true;
  render();
  verifyRecentsOnEmpty();
}

async function verifyRecentsOnEmpty() {
  const snapshot = recentPaths.slice();
  try {
    const r = await checkRecents(snapshot, { probe: recentProbe });
    if (!r.ran || r.invalid === null) return; // 没发请求 / 整批问不到：保持不变，不弹提示
    recentInvalid = new Set(r.invalid);
    if (state.emptyActive) render(); // 仍停在空状态才就地重画
  } catch (e) { /* 核对失败一律不弹提示、不标失效 */ }
}

function renderEmptyState() {
  app.innerHTML = emptyStateHtml({ recents: recentPaths, invalid: [...recentInvalid] }) + renderToast();
}
function renderReadState() {
  const rs = state.readState;
  app.innerHTML = '<main class="editor-body">' +
    readingStateHtml(rs.kind, { path: rs.path }) + '</main>' + renderToast();
}

// 点已失效那条：重新问一次（标注只是上一次结论）。回来了正常打开并撤标注；
// 真不在 → 那句话 + 提示条「从列表里去掉」（不自动删，点了才删）；问不到不冒充「不在了」。
async function handleInvalidRecent(path) {
  const kind = await recheckOne(path, { probe: recentProbe });
  if (kind === 'exists') {
    recentInvalid.delete(path);
    if (state.emptyActive) render();
    location.hash = '#/edit/' + encodeURIComponent(path);
  } else if (kind === 'missing') {
    toast(GONE_MESSAGE, { label: REMOVE_LABEL, run: () => removeRecentFromStore(path) });
  } else {
    toast('连不上，暂时确认不了这篇在不在');
  }
}

// 独立的一段点击接线，不挤进上面那个 data-act 分发器（降低并行合并冲突）。
document.addEventListener('click', (e) => {
  const inv = e.target.closest && e.target.closest('[data-recent-invalid]');
  if (inv) {
    e.preventDefault(); // 不直接跳去打开，先重新问一次
    handleInvalidRecent(inv.dataset.recentPath);
    return;
  }
  const retry = e.target.closest && e.target.closest('[data-read-retry]');
  if (retry) { openFile(retry.dataset.readRetry); return; }
});

/* ---------- #68：正文只剩一条栏，所以「关掉这篇」得有一条退路 ------------------
   阅读态按原型撤掉了界面上的「‹ 返回」（那一格留给了编辑态的「退出编辑」）。
   从列表 / 搜索 / 最近打开点进来时，浏览器历史里本来就有上一页，系统返回照常回列表。
   但**直接拿分享链接打开、或者在某篇上刷新／重开标签页**时，历史里只有这一条：
   这时按系统返回会直接退出应用 / 浏览器，而界面上再没有别的「关掉」入口。

   做法是补一条占位历史（与侧栏滑出压占位同一思路）：把当前这条钉成「根」，
   再把这篇压上去。于是返回退到根（空状态），不再退到应用外面。
   只在**这个标签页第一次加载**时补——刷新时浏览器里的历史还在，补了反而会把
   「上一篇」挤到后面去。标记放 sessionStorage：同一标签页内共享、关掉即失效。 */
const HISTORY_BOOT_KEY = 'gitobsidianlite.historyBooted';

function ensureHistoryBehindNote() {
  let seen = false;
  try { seen = sessionStorage.getItem(HISTORY_BOOT_KEY) === '1'; } catch (_) { /* 隐私模式：当首次 */ }
  try { sessionStorage.setItem(HISTORY_BOOT_KEY, '1'); } catch (_) { /* 忽略 */ }
  if (seen) return;                                  // 刷新 / 站内跳转后的重载：历史本来就在
  const hash = location.hash.replace(/^#/, '');
  if (!hash.startsWith('/edit/')) return;            // 落根 / 旧目录链接不补
  try {
    history.replaceState(history.state, '', location.pathname + location.search + '#/');
    history.pushState({ noteEntry: true }, '', '#/edit/' + hash.slice(6));
  } catch (_) { /* 老环境忽略：退回原样，行为与改动前一致 */ }
}

ensureHistoryBehindNote();
resetFab();
navigate();
pendingChecks.replay(); // #60：冷启动也补发一次没送到的勾选

/* ---------- 一次性善后：本机那份正文副本随功能一起下架（#44 / ADR-0003） ---------- */
//
// 老设备上它还稳稳占着几 MB。**不是「不再读」，是「不再占地方」**：开一次应用就删掉。
// 这件事做成幂等的——库里没有那个数据库时 deleteDatabase 直接成功，所以每次启动做一遍
// 没有副作用。万一有另一个标签页还开着旧版、握着连接，按 IndexedDB 的规定删除会排在它
// 后面（这段时间不阻塞启动，我们也不等结果），那边一关就清干净。
// 偏好键（每台设备各记的那个开关与上限）一并去掉：功能没了，留着这一项只会让人以为能用。
function dropBodyStore() {
  try { indexedDB.deleteDatabase('gitobsidianlite'); } catch (e) { /* 没有 indexedDB 就算了 */ }
  try { localStorage.removeItem('searchPrefs.v1'); } catch (e) { /* 忽略 */ }
}
dropBodyStore();

/* ---------- #62 目录树接线（只加 import 与这一处，不重排 / 不改别人函数） ----------
   树只从本机那份全库名单（wikilinkIndex.notePaths）画，零新增取数请求。
   加载三态跟 ensureIndex 的同一份 promise 走；写后就地刷新由 #66 调 refreshTree()。 */
const treeCtl = initTree({
  getNotePaths: () => (wikilinkIndex ? wikilinkIndex.notePaths : null),
  reloadIndex: () => ensureIndex({ force: true }),
  getCurrentNote: () => (state.view === 'editor' ? state.path : ''),
});

// 冷启动 T-1/T-2、版本号变了全量重拉、断网 T-3：都挂在 ensureIndex 的那份
// promise 上。底部已预热过，同一份 promise 直接复用，不重复发请求。
function watchTreeIndex(p) {
  Promise.resolve(p).then(() => treeCtl.onReady(), () => treeCtl.onOffline());
}
watchTreeIndex(ensureIndex());

// 打开一篇 → 树里按「打开的那篇」定位（祖先展开 / 高亮 / 选中退回所在文件夹）。
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h.startsWith('/edit/')) selectPath(decodeURIComponent(h.slice(6)));
});
// 冷启动直接落在某篇（分享链接）：那次不经过 hashchange，补一次定位。
if (location.hash.startsWith('#/edit/')) selectPath(decodeURIComponent(location.hash.slice(7)));

// 侧栏每次出现（手机点开 / 宽屏常驻首帧）：一次新的拉开，重置滚动保护并定位。
// #69 起「☰」在宽屏兼作收起，所以只在点完真的看得见侧栏时才当一次「拉开」——
// layout.js 的点击监听先于这里（initLayout 在本文件靠前处调用），此时 hidden 已是新值。
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest || !t.closest('[data-shell="open"]')) return;
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.hidden) return; // 这一次是收起，不是拉开
  notifySidebarShown();
});
notifySidebarShown();

// 切回前台：recheckRepo() 自己比对 head 并在变化时 ensureIndex({force:true})，
// 这里不重做那套判断，只把结果接回树；notifySidebarShown 会在下一次拉开时
// 用最新名单重画（不改 recheckRepo 内部）。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') watchTreeIndex(ensureIndex());
});

/* ---------- #63 侧栏搜索与设置接线（只加 import 与这一处，不重排 / 不改别人函数） ----------
   放大镜 ↔ 输入框只切可见性、六行点/滑规则、搜索四态、结果就地替树；设置三块、
   黑白三档即时生效、指定目录核对。逻辑都在 sidebar-search.js / settings.js，
   main.js 只注入依赖并各调一次 init；与 #62 树接线、#64 空状态/阅读接线并存。 */
import { initSidebarSearch } from './sidebar-search.js';
import { initSettings, getNewNoteTarget, setNewNoteTarget } from './settings.js';
import { showSidebarView } from './layout.js';

initSidebarSearch({
  getNotePaths: () => (wikilinkIndex ? wikilinkIndex.notePaths : null),
  checkOnline: () => checkOnline(),
  ensureIndex: () => ensureIndex(),
  showView: (name) => showSidebarView(name),
  openPath: (path) => { location.hash = '#/edit/' + encodeURIComponent(path); },
});

initSettings({
  showView: (name) => showSidebarView(name),
  dirProbe: (dir) => listDir(dir),
});

/* ---------- #66 文件操作接线（只加 import、事件监听与树行入口，不重排 / 不改别人函数体） ----------
   入口：侧栏底部「新建」(ui:shell-action new) / 正文顶栏常驻「⋯」(more) /
   窄屏长按笔记行 / 宽屏悬停才显示行尾「⋯」。三者共用 state.ops 那张操作表，
   编辑 / 冲突态置灰仍可按的判定与锁提示沿用 #65 的 isLocked() + EDIT_COPY.fileOpsHint。
   打开新建弹窗那一刻的「指定目录在不在」核对由 openCreate() 派发 ui:new-note-target-check
   （逻辑与三态文案在 settings.js）；#63 的 ui:pick-target-dir / ui:target-fix-here 在这里接。 */

// 侧栏底部「新建」与正文顶栏常驻「⋯」：layout.js 派发 ui:shell-action，
// settings.js / sidebar-search.js 也各自监听同一事件，各管各的 action，互不干扰。
document.addEventListener('ui:shell-action', (e) => {
  const action = e && e.detail && e.detail.action;
  if (action === 'new') { openCreate(); return; }
  if (action === 'more') {
    // 正文顶栏的「⋯」是主入口：对「打开的那篇」出操作表。
    // 空状态 / 目录页没有打开的那篇时不装作有对象可操作。
    if (state.view === 'editor' && !state.readState && !state.emptyActive && state.path) {
      state.ops = { path: state.path };
      render();
    }
    return;
  }
});

// #63「指定目录」入口：设置面板里点目录行，打开目录选择器，选完写回 fixed 档。
document.addEventListener('ui:pick-target-dir', (e) => {
  const dir = (e && e.detail && e.detail.dir) || '';
  openPicker({ dir, onPick: 'settings' });
});
// #63「就在这里改这一次」：打开新建弹窗，目录块里当下就能改（不改设置、不再重复报目录不在了）。
document.addEventListener('ui:target-fix-here', () => { openCreate({ skipCheck: true }); });

// 树行入口：窄屏长按笔记行出操作表（按下就有反馈）、宽屏悬停才显示行尾「⋯」；
// 文件夹行不响应长按、没有改名 / 移动 / 删除；不做左滑。树行由 #62 渲染，
// 这里只在常驻容器上做事件委托，不改 tree.js、不给树行挂常驻「⋯」。
(function wireTreeRowOps() {
  const host = document.getElementById('tree-view');
  if (!host) return;
  const isWide = () => typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(min-width: ' + SIDEBAR_BREAKPOINT + 'px)').matches;
  const notePathOf = (row) => {
    const href = row && row.getAttribute ? (row.getAttribute('href') || '') : '';
    const prefix = '#/edit/';
    if (!href.startsWith(prefix)) return '';
    try { return decodeURIComponent(href.slice(prefix.length)); } catch (_) { return ''; }
  };
  const showOpsFor = (row) => {
    const path = notePathOf(row);
    if (path) { state.ops = { path }; render(); }
  };

  // 宽屏悬停才显示行尾「⋯」：hover 时就地插入一个带内联 SVG 的 span（不是按钮，
  // 合法放在 <a> 里），移出就摘掉——树行不挂常驻「⋯」。
  host.addEventListener('mouseover', (e) => {
    if (!isWide()) return;
    const row = e.target && e.target.closest ? e.target.closest('.tree-row.is-note') : null;
    if (!row || row.querySelector('.tree-row-more')) return;
    const more = document.createElement('span');
    more.className = 'tree-row-more';
    more.setAttribute('aria-label', '更多操作');
    more.innerHTML = icon('more', 20);
    row.appendChild(more);
  });
  host.addEventListener('mouseout', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.tree-row.is-note') : null;
    if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
    const more = row.querySelector('.tree-row-more');
    if (more) more.remove();
  });

  // 点行尾「⋯」：捕获阶段先于「打开这篇」的默认跳转，出操作表。
  // suppressClick 由长按触发置位，避免长按松手那一下顺手把笔记打开。
  let suppressClick = false;
  host.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const more = e.target && e.target.closest ? e.target.closest('.tree-row-more') : null;
    if (!more) return;
    e.preventDefault(); e.stopPropagation();
    const row = more.closest('.tree-row.is-note');
    if (row) showOpsFor(row);
  }, true);

  // 窄屏长按笔记行：按下立刻给反馈（.is-pressing），到点出操作表；文件夹行不响应。
  let timer = null;
  let pressing = null;
  function clearPress() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pressing) { pressing.classList.remove('is-pressing'); pressing = null; }
  }
  host.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    const row = e.target && e.target.closest ? e.target.closest('.tree-row.is-note') : null;
    if (!row || !shouldStartLongPress({ isNoteRow: true, wide: isWide() })) return;
    pressing = row;
    row.classList.add('is-pressing'); // 按下就有反馈
    timer = setTimeout(() => {
      const path = notePathOf(row);
      clearPress();
      suppressClick = true;
      if (path) { state.ops = { path }; render(); }
    }, LONG_PRESS_MS);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((type) =>
    host.addEventListener(type, clearPress, { passive: true }));
})();

/* ---------- #65 编辑态与冲突接线（只加 import、这一处接线与几个函数，不重排 / 不改别人函数体） ----------
   规则全在 editor-guard.js，可见视口几何与监听在 viewport.js；main.js 只注入
   状态与确认框、把 UI 意图接到既有函数上。不改 backToRead()（#60）与 allowToast
   的语义；pendingChecks.replay() 的落点（save / commitMerge / 取消编辑）三处都在。 */

/** 注入守卫：mode 取真实 state；草稿基准是「进入编辑那一刻」的 state.file.content；
    「放弃改动？」用原生 confirm（逐字文案由守卫给出），node 无 DOM 时安全退化。 */
configureEditorGuard({
  getMode: () => state.mode,
  getDirty: () => (state.file ? hasUnsavedChanges(state.draft, state.file.content) : false),
  confirm: (msg) => (typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? !!window.confirm(msg) : false),
});

/** 一次接线：键盘弹起时按可见视口摆编辑动作区（只写 --vv-inset，不碰侧栏横条）。 */
initViewport();

/**
 * 锁死侧栏的 UI 落位（由 render() 开头调用，幂等）：
 *   - 编辑 / 冲突态不给「☰」（判据 8：编辑态不给侧栏入口）；
 *   - 动作区容器只在正文三态出现，其余态收起。
 * 宽屏下侧栏照旧在（不隐藏 #sidebar），「点别的笔记被拦住并说明原因」由下面
 * 捕获阶段的拦截负责。
 *
 * #68：正文只有一条栏，所以两件事也落在这儿——顶栏中间那格写篇名、左上那格在
 * 编辑 / 冲突态换成「退出编辑 / 返回」。两者都在骨架层（#app 之外、节点常驻），
 * 每次 render 只改文字与 hidden，不增删节点，重画正文碰不到它们。
 */
function syncEditorChrome() {
  const openBtn = document.getElementById('btn-open');
  if (openBtn) openBtn.hidden = isLocked();
  // #68：左上那格与 ☰ 共用位置——编辑 / 冲突态换成「退出编辑 / 返回」。
  // 阅读态按原型**没有返回键**（关掉这篇由系统返回承担，防困住的占位历史见文件末尾）。
  const layerBack = document.getElementById('btn-layer-back');
  if (layerBack) {
    layerBack.hidden = !isLocked();
    layerBack.textContent = state.mode === 'conflict' ? '‹ 返回' : '‹ 退出编辑';
    layerBack.setAttribute('aria-label', state.mode === 'conflict' ? '返回编辑' : '退出编辑');
  }
  // #68：顶栏中间那格接上篇名。**去扩展名**，与树行、搜索结果、原型一致；
  // 全名（含 .md）留在 title 上——长名字被省略号截断时还能悬停看全。
  // 只在这篇真的打开了的时候写：读失败 / 加载中 / 空状态都不挂上一页的名字。
  const noteOpen = state.view === 'editor' && !state.readState && !state.emptyActive && !!state.path;
  const titleEl = document.getElementById('doc-title');
  if (titleEl) {
    const full = noteOpen ? state.path.split('/').pop() : '';
    titleEl.textContent = full.replace(/\.md$/i, '');
    titleEl.title = full;
  }
  // 评审修复第 5 条：「⋯」主入口（骨架 #btn-more）与旧菜单同一锁判定——
  // 编辑 / 冲突态置灰但仍能按（不 disable），点开后的三个动作与「先保存或取消，
  // 再改文件」锁提示由 renderOps() / [data-op] 按 isLocked() 处理，不另造一套判定。
  //
  // #70：没有「打开的那篇」时把它整个藏掉（空状态 / 阅读失败 / 目录页）。判据与上面
  // 那格篇名**同一个 noteOpen**——两边各写一套迟早会说两种话。用 hidden 属性（不是删
  // 节点：骨架只建一次），.icon-btn[hidden] 的 !important 负责盖掉作者样式的 display；
  // 藏起来的按钮既不在版面上、也进不了键盘序列。
  const moreBtn = document.getElementById('btn-more');
  if (moreBtn) {
    moreBtn.hidden = !noteOpen;
    if (moreBtn.classList) moreBtn.classList.toggle('is-disabled', isLocked());
  }
  const actions = document.getElementById('edit-actions');
  if (actions) actions.hidden = !(state.view === 'editor' && !state.readState && !state.emptyActive);
}

/** 退出编辑 / 点取消：有改动先问「放弃改动？」；确认才丢草稿回阅读态，取消留编辑态、草稿原样。 */
function exitEdit() {
  if (!guardExitEdit()) return;                       // 取消：留编辑态、草稿一字不差
  if (state.file) state.draft = state.file.content;  // 确认：丢草稿
  backToRead();                                      // #60：这一刻补发那篇没送到的勾选
  render();
}

/** C-4：冲突态按返回 → 退回编辑态、草稿原样、不加提示（每次只退一层）。 */
function conflictBackToEdit() {
  state.mode = 'edit';
  state.conflict = null;
  render();
}

/* #68：骨架顶栏左上那颗（编辑态「退出编辑」、冲突态「返回」）只接一次监听。
   它住在 #app 之外、节点常驻，重画正文不会换掉它；每次 render 重新绑会叠加，
   所以按当前 mode 分派，而不是在 renderEditor() 里绑。 */
const layerBackBtn = document.getElementById('btn-layer-back');
if (layerBackBtn) {
  layerBackBtn.addEventListener('click', () => {
    if (state.mode === 'conflict') { conflictBackToEdit(); return; }
    if (state.mode === 'edit') exitEdit();   // 有改动先问「放弃改动？」，同旧那颗
  });
}

/** 系统返回 / 界面返回（layout.js 派发 ui:back）：按真实 mode 每次退一层。
    评审修复第 1 条：四层落地指令在 navigation.js 的 backDirective()（可单测），
    这里按 main 的真实 state.mode 判，不读 layout 的 detail.decision（它自己的
    navState.mode 未必同步）。侧栏开着那一层由 layout 的 popstate 自己先收，
    派发到这里时侧栏已收起，故只传 sidebarOpen:false，让指令判剩下三层。 */
document.addEventListener('ui:back', () => {
  // 空状态 / 阅读失败态时 openedPath 传空，避免按系统返回也 replace 一次。
  const openedPath = (state.view === 'editor' && !state.emptyActive && !state.readState)
    ? state.path : '';
  const d = backDirective({ mode: state.mode, openedPath, sidebarOpen: false });
  if (d.decision === 'conflict-to-edit') { conflictBackToEdit(); return; }
  if (d.decision === 'exit-edit') { exitEdit(); return; }
  if (d.decision === 'close-note') { closeNote(d.href); return; }
  // 'none'（空状态 / 没打开笔记）：不再退，也不制造「按了没反应」的假象。
});

/**
 * 编辑 / 冲突态锁死侧栏：拦截所有「打开另一篇」的 hash 链接（树行、搜索结果、
 * 旧结果行都是 <a href="#/edit/...">），捕获阶段先于别人的监听器执行。
 * 有改动 → 问「放弃改动？」；确认才丢草稿并继续打开目标，取消留编辑态、草稿原样。
 * 没改动 → 仍拦住并说明原因（「先保存或取消，再看别的」），不悄悄切走。
 */
document.addEventListener('click', (e) => {
  if (!isLocked()) return;
  const t = e && e.target;
  const a = t && t.closest && t.closest('a[href^="#/edit/"]');
  if (!a) return;
  let target = '';
  try { target = decodeURIComponent(a.getAttribute('href').slice('#/edit/'.length)); } catch (_) { return; }
  if (target === state.path) return;   // 点的是当前这篇，不算换篇
  e.preventDefault();
  e.stopPropagation();                 // 也挡住 #63 openPath / 大分发器再改一次 hash
  if (hasUnsavedChanges(state.draft, state.file ? state.file.content : '')) {
    if (!guardExitEdit()) return;      // 取消：留编辑态、草稿原样、不导航
    if (state.file) state.draft = state.file.content;
    backToRead();
  } else {
    toast(EDIT_COPY.lockedHint);       // 没改动也拦住并说明原因
    return;
  }
  location.hash = a.getAttribute('href'); // 确认后才继续打开目标篇
}, true);
