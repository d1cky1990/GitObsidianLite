import MarkdownIt from 'markdown-it';
import {
  listDir, listTree, listHead, readFile, writeFile, createFile, deleteFile, rawUrl, fetchBlobs,
} from './api.js';
import { installVaultImageRule, brokenImageHtml, runtimeFailureReason } from './vault-refs.js';
import {
  installWikilinkRule, buildWikilinkIndex, hydrateWikilinkIndex, serializeWikilinkIndex, lookupWikilink,
} from './wikilinks.js';
import {
  dirOf, baseOf, joinPath, normalizeNewName, hasName, renameTarget, moveTarget, stemOf, commitMessage,
} from './file-names.js';
import { installTaskRule, toggleTaskInContent, isTaskDoneLine } from './tasks.js';
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
// 搜索（#16 定稿 → #33）：入口常驻列表页顶部，默认只搜标题与路径——那靠的是上面
// 那份全库名单，零新增请求。正文搜索背后是本地那份正文副本，规则定在 #32。
import { searchTitles, searchBodies, normalizeQuery } from './search.js';
import { createNoteStore } from './note-store.js';
import { createBodySync } from './note-sync.js';
import './style.css';

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
    knownHead = head.sha;
    if (cached && cached.head === head.sha) {
      wikilinkIndex = hydrateWikilinkIndex(cached.index);
      // HEAD 没变：本地正文副本也不用动（本地却没齐的话，同步自己会去拉清单）
      syncBodies({ consider: true, reused: true }).catch(() => {});
      return wikilinkIndex;
    }
    // 2. HEAD 变了（或没有缓存），拉全量重建
    const data = await listTree();
    const index = buildWikilinkIndex(data.tree);
    writeCachedIndex(head.sha, index);
    wikilinkIndex = index;
    // 这棵树顺手留给正文同步用——它要的是同一份清单里的每文件 sha，别拉第二遍
    freshTree = { head: data.head, tree: data.tree, at: Date.now() };
    syncBodies({ consider: true, reused: false }).catch(() => {});
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

/* ---------- 搜索、设置、本地正文副本（#33） ---------- */
//
// 三样东西的边界要说清——它们长得像，生命周期却完全不同：
//   - **全库名单**（上面那份 localStorage 索引）：路径清单，双链判定 / 图片反查 / 标题搜索共用，一直都在；
//   - **本地正文副本**（本区块）：只在「搜正文」开着时存在，一篇一条；关掉即删，全库名单一根汗毛不动；
//   - **本次会话打开的正文**（`state.file`）：打开一篇取一篇，冲突判定靠它带的那个版本身份。
// 最危险的一步是把副本当成正文来源——那会让「远端已更新」的判定过期（#32 §1 已定：不这么做）。

const PREFS_KEY = 'searchPrefs.v1';
const DEFAULT_CAP_MB = 20;

function readPrefs() {
  try {
    const d = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const capMB = Number(d && d.capMB);
    return { body: !!(d && d.body), capMB: capMB > 0 ? capMB : DEFAULT_CAP_MB };
  } catch (e) {
    return { body: false, capMB: DEFAULT_CAP_MB };
  }
}

// 开关与上限是**每台设备各自记**的（#32 §6），所以住 localStorage，不进那份正文库
let prefs = readPrefs();

function writePrefs(next) {
  prefs = next;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (e) { /* 可能超配额，忽略 */ }
}

const noteStore = createNoteStore();

// 全库正文的一次性内存副本（搜的时候逐篇扫）。同步一写完就置空——它和库里那份必须
// 一起变，留着旧的就是「搜到的东西点开已经变了」。
let bodyRecords = null;

let lastSyncRender = 0;
const bodySync = createBodySync({
  store: noteStore,
  loadTree: () => loadTreeForSync(),
  fetchBlobs: (files) => fetchBlobs(files),
  getCapBytes: () => prefs.capMB * 1024 * 1024,
  onProgress: () => {
    // 进度是逐篇报的（全库 857 篇就是 857 次），只有设置页有会变的东西，且压到 400ms 一次。
    // 进度本身的唯一出处是 bodySync.state，这里不另存一份。
    if (state.view === 'settings' && Date.now() - lastSyncRender > 400) {
      lastSyncRender = Date.now();
      render();
    }
  },
});

// 刚拉过的整棵树，给同步复用一次。打开应用时索引那次拉取（3~5 秒）与同步要的是同一棵树，
// 不借这一次，同一分钟内就会拉两遍。
let freshTree = null;
let knownHead = '';

async function loadTreeForSync() {
  const t = freshTree;
  freshTree = null;
  if (t && Date.now() - t.at < 60000) return { head: t.head, tree: t.tree };
  return listTree();
}

/** 远端一共几篇笔记——「共 Y 篇」与「备没备齐」都用它 */
function remoteNoteCount() {
  return wikilinkIndex ? wikilinkIndex.notePaths.length : 0;
}

/** 本地副本齐了没有。还没拿到名单时一律算没齐——不许先装成能用 */
function bodyReadyNow() {
  const total = remoteNoteCount();
  return prefs.body && total > 0 && state.bodyCount >= total;
}

async function refreshBodyStats() {
  try {
    const i = await noteStore.index();
    state.bodyCount = i.count;
    state.bodyBytes = i.bytes;
  } catch (e) {
    state.bodyCount = 0;
    state.bodyBytes = 0;
  }
}

/** 后台同步不该打断正在写的人：编辑中重画会动光标（与 repaintWithIndex 同一条规矩） */
function renderIfIdle() {
  if (state.view === 'editor') return;
  render();
}

/**
 * 跑一趟正文同步。`consider` 是顺风车：HEAD 没变、本地又齐了，就什么都不做（连清单都不拉）。
 * 收尾统一在这里——刷篇数、丢掉那份内存副本、必要时重画（结果页的「未就绪」得能自己变成结果）。
 */
async function syncBodies({ consider = false, reused = false } = {}) {
  if (!prefs.body) return;
  let ran;
  if (consider) ran = await bodySync.consider({ reused, noteCount: remoteNoteCount() });
  else { await bodySync.sync(); ran = true; }
  if (!ran) return;
  bodyRecords = null;
  await refreshBodyStats();
  // 用户正停在结果页：本地那份要重读一遍，否则「正文」那一组会拿一份空的去算，
  // 把「刚备好」显示成「正文里没有命中」
  if (state.view === 'list' && normalizeQuery(state.query) && bodyReadyNow()) await loadBodyRecords();
  renderIfIdle();
  const s = bodySync.state;
  if (state.view === 'editor') return; // 别往正在写的人屏幕上弹东西
  if (s.status === 'done' && s.total > 0) {
    toast(state.query.trim() ? '本地正文已备好，正文里也能搜了' : '本地正文已备好');
  } else if (s.status === 'capped') {
    toast('到了容量上限，本地正文先备到这里');
  } else if (s.status === 'blocked') {
    toast('上游不让接着取了，本地正文先备到这里');
  }
}

/* ---------- 在线 / 离线：搜索整体要求在线 ---------- */

// #32 §7 定的：连那次很轻的版本身份请求都问不到，就当断网，**整个搜索不给用**——
// 宁可保守，也不展示可能过时的结果。断网**不删**本地正文，它只是暂时不可用。
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

/** 一次算清「该出哪几组、各出什么」，渲染只读它 */
function searchState() {
  const q = normalizeQuery(state.query);
  if (!q) return null;
  const ready = bodyReadyNow();
  return {
    q,
    indexReady: !!wikilinkIndex,
    titles: wikilinkIndex ? searchTitles(wikilinkIndex.notePaths, q) : [],
    bodyReady: ready,
    bodyLoaded: ready && !!bodyRecords,
    bodies: ready && bodyRecords ? searchBodies(bodyRecords, q) : [],
  };
}

function resultRow(r) {
  return '<a class="res" href="#/edit/' + encodeURIComponent(r.path) + '"' +
    ' data-hit="' + esc(r.path) + '" data-hitq="' + esc(normalizeQuery(state.query)) + '">' +
    '<span class="res-title"><span class="ic md">¶</span><span class="nm">' + esc(r.name) + '</span>' +
    (r.dir ? '<span class="res-dir">' + esc(r.dir) + '</span>' : '') + '</span>' +
    (r.snippet
      ? '<span class="res-snip">' + esc(r.snippet.before) + '<mark>' + esc(r.snippet.match) + '</mark>' +
        esc(r.snippet.after) + '</span>'
      : '') +
    '</a>';
}

function renderResults() {
  const s = searchState();
  if (!s) return '';
  // 断网 / 还没问清网络：**不出结果**，也不说「没找到」——那会把一次网络故障说成没有这篇笔记
  if (state.online === null) return '<div class="res-status dim">正在确认网络…</div>';
  if (state.online === false) return '<div class="res-status dim">连不上服务端，搜索暂时用不了。恢复联网后再试。</div>';

  let html = '<div class="res-group">' +
    '<div class="res-head">标题 / 路径<span class="res-n">' + s.titles.length + '</span></div>';
  html += s.titles.length
    ? s.titles.map(resultRow).join('')
    : '<div class="res-empty dim">' + (s.indexReady ? '标题和路径里都没有' : '文件名单还在加载…') + '</div>';
  html += '</div>';

  // 开关没开就**不出现正文那一栏**：一栏永远写着「去设置里打开」只是白占屏幕。
  // 想开的人会在设置里看到那个开关（那里才是它的说明该待的地方）。
  if (!prefs.body) return html;

  html += '<div class="res-group"><div class="res-head">正文' +
    (s.bodyReady && s.bodyLoaded ? '<span class="res-n">' + s.bodies.length + '</span>' : '') + '</div>';
  if (!s.bodyReady) {
    // 未就绪时**整组不出结果**，只留一句说明（#32 §5 定的，比 #33 票面那句更严）
    html += '<div class="res-note dim">' + bodyNotReadyText() + '</div>';
  } else if (!s.bodyLoaded) {
    html += '<div class="res-note dim">正在读本地正文…</div>';
  } else {
    html += s.bodies.length
      ? s.bodies.map(resultRow).join('')
      : '<div class="res-empty dim">正文里没有命中</div>';
  }
  html += '</div>';
  return html;
}

function bodyNotReadyText() {
  const s = bodySync.state;
  const total = remoteNoteCount();
  if (s.status === 'blocked') {
    return '已备 ' + state.bodyCount + ' / 共 ' + total + ' 篇，上游不让接着取了（' + s.error +
      '）。已经到手的那部分留着，下次打开接着备。备好前只搜标题。';
  }
  if (s.status === 'error') return '本地正文没备起来：' + s.error + '。备好前只搜标题。';
  if (s.status === 'capped') {
    return '已备 ' + state.bodyCount + ' / 共 ' + total + ' 篇，到了容量上限就停了（去设置里把上限放大）。备好前只搜标题。';
  }
  return '本地正文正在备（已 ' + state.bodyCount + ' / 共 ' + total + ' 篇），备好前只搜标题。';
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
    '<input id="q" class="search-input" type="text" placeholder="搜索笔记"' +
    ' autocapitalize="off" autocomplete="off" spellcheck="false">' +
    '<button class="search-clear" id="q-clear" data-act="clearQuery" aria-label="清空搜索">×</button>' +
    '<button class="gear" data-act="openSettings">设置</button>' +
    '</div>' +
    '<span class="crumbs" id="list-crumbs"></span>' +
    '</header>' +
    '<main class="list" id="list-main"></main>' +
    '<button class="fab" id="fab-new" data-act="newFile">＋ 新建笔记</button>' +
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
 * 词变了：先把「正在确认网络」画出来，再那次很轻的请求。**每打一个字都重画**——
 * 结果是从手上的数据算出来的，不发请求（正文搜索扫的也是本地副本）。
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
    if (ok && bodyReadyNow()) await loadBodyRecords();
    if (seq !== searchSeq) return;
    render();
  })();
}

async function loadBodyRecords() {
  if (bodyRecords) return;
  try { bodyRecords = await noteStore.allNotes(); } catch (e) { bodyRecords = []; }
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

/* ---------- 设置页 ---------- */

function settingsBackHref() {
  return '#/dir/' + encodeURIComponent(state.settingsFrom);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function syncLine() {
  const s = bodySync.state;
  const total = remoteNoteCount();
  if (!prefs.body) return '搜正文没打开，本机没存任何正文。';
  if (s.status === 'running') return '正在备：已备 ' + s.done + ' / 共 ' + s.total + ' 篇…';
  if (s.status === 'capped') return '到了容量上限，先备到这里。放大上限后下次打开会接着备。';
  if (s.status === 'blocked') {
    return '备到 ' + state.bodyCount + ' / 共 ' + total + ' 篇时上游不让接着取了（' + s.error +
      '）。到手的留着，下次打开会接着备。';
  }
  if (s.status === 'error') return '没能备起来：' + s.error;
  if (total && state.bodyCount >= total) return '已备好 ' + state.bodyCount + ' 篇。';
  return '已备 ' + state.bodyCount + ' / 共 ' + total + ' 篇。' +
    (s.failed ? ' 有 ' + s.failed + ' 篇没取到，下次打开会自动再试。' : '');
}

function renderSettings() {
  const capBytes = prefs.capMB * 1024 * 1024;
  const over = state.bodyBytes > capBytes;
  app.innerHTML =
    '<header class="bar"><a class="back" href="' + settingsBackHref() + '">‹ 返回</a>' +
    '<span class="title">设置</span></header>' +
    '<main class="editor-body settings">' +
    '<div class="set-block">' +
    '<label class="set-row"><span class="set-name">搜正文</span>' +
    '<input type="checkbox" id="set-body"' + (prefs.body ? ' checked' : '') + '></label>' +
    '<div class="set-hint">打开后，本机会在后台把全库笔记的正文存一份（只给搜索用），' +
    '之后按每篇的版本身份增量补。每台设备各自记；关掉立刻删干净，全库名单不受影响。</div>' +
    '</div>' +
    '<div class="set-block">' +
    '<label class="set-row"><span class="set-name">容量上限</span>' +
    '<input id="set-cap" class="set-num" type="number" min="1" step="1" value="' + prefs.capMB + '">' +
    '<span class="set-unit">MB</span></label>' +
    '<div class="set-hint">已用 ' + mb(state.bodyBytes) + ' MB / 上限 ' + prefs.capMB + ' MB' +
    (over ? '（已超出，本地正文不再新增）' : '') + '</div>' +
    '<div class="set-hint">上限只拦新增，不会为了腾地方删已有的。要清空请按下面那个按钮。</div>' +
    '</div>' +
    '<div class="set-block">' +
    '<div class="set-hint">' + esc(syncLine()) + '</div>' +
    '<button class="wide danger" data-act="clearBodies">清空本地正文</button>' +
    '</div>' +
    '</main>' +
    renderOverlays() + renderToast();

  wireDialog();
  const cb = document.getElementById('set-body');
  if (cb) cb.addEventListener('change', onToggleBody);
  const cap = document.getElementById('set-cap');
  if (cap) cap.addEventListener('change', onCapChange);
}

async function onToggleBody() {
  const on = !prefs.body;
  writePrefs({ ...prefs, body: on });
  if (!on) {
    bodyRecords = null;
    state.busy = true; render();
    try { await noteStore.clear(); } catch (e) { toast('没能清干净：' + e.message); }
    await refreshBodyStats();
    state.busy = false; render();
    toast('已关掉搜正文，本机那份正文删干净了');
    return;
  }
  render();
  toast('开始在后台备正文');
  await syncBodies();
}

function onCapChange(e) {
  const n = Math.max(1, Math.round(Number(e.target.value) || 0));
  writePrefs({ ...prefs, capMB: n });
  render();
}

function askClearBodies() {
  state.dialog = {
    type: 'confirm', action: 'clearBodies',
    title: '清空本地正文？',
    body: '清掉的是本机这份正文副本（只给搜索用）。<b>仓库里的笔记一个字都不动</b>，' +
      '开关也还开着——下次打开会重新备一遍。',
    okLabel: '清空', danger: true,
  };
  render();
}

async function doClearBodies() {
  closeOverlays();
  bodyRecords = null;
  state.busy = true; render();
  try {
    await noteStore.clear();
    await refreshBodyStats();
    toast('本地正文已清空');
  } catch (e) {
    toast('没清掉：' + e.message);
  }
  state.busy = false; render();
}

function openSettings() {
  state.settingsFrom = state.view === 'editor' ? dirOf(state.path) : state.path;
  if (location.hash === '#/settings') { state.view = 'settings'; render(); }
  else location.hash = '#/settings';
  refreshBodyStats().then(() => { if (state.view === 'settings') render(); });
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
  view: 'list', // 'list' | 'editor' | 'settings'
  path: '', // 当前目录（list）或文件路径（editor）
  entries: [],
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

  // ---- 搜索与设置（#33） ----
  query: '', // 搜索框里的词（空 = 正常翻目录）
  online: null, // null = 还没问过；true / false = 那次很轻的版本身份请求的结果
  settingsFrom: '', // 进设置页之前所在的目录，「返回」回到那里
  bodyCount: 0, // 本地正文副本已有几篇
  bodyBytes: 0, // 已用多少字节（上限那一行要它）
  pendingHit: null, // { path, query } —— 刚点的搜索结果，打开后要滚到命中那一段
  hitMark: null, // 已经滚过去的那处，补渲染时要把它画回来
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 提示条可以带一个动作（目前只有删除后的「撤销」）。带动作的多留一会儿——一句 2.5 秒
// 就没了的提示，配上要去找的按钮，等于没给。
let toastTimer = null;
function toast(msg, action = null) {
  state.message = msg;
  state.toastAction = action;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.message !== msg) return; // 期间又被别的提示顶掉了，别把新的收走
    state.message = ''; state.toastAction = null; render();
  }, action ? 8000 : 2500);
}

function navigate() {
  const hash = location.hash.slice(1) || '';
  if (hash === '/settings') {
    state.view = 'settings';
    render();
  } else if (hash.startsWith('/edit/')) {
    openFile(decodeURIComponent(hash.slice(6)));
  } else if (hash.startsWith('/dir/')) {
    state.view = 'list';
    loadDir(decodeURIComponent(hash.slice(5)));
  } else {
    state.view = 'list';
    loadDir('');
  }
}

async function loadDir(path) {
  // 进新目录时把浮层收掉（操作表/弹窗是针对上一屏的东西），但**不清 message**：
  // 删除后的「撤销」就挂在提示条上，翻页把它收走等于把撤销入口也收走了。
  closeOverlays();
  state.busy = true; render();
  try { state.entries = await listDir(path); state.path = path; }
  catch (e) { state.entries = []; toast(e.message); }
  state.busy = false; resetFab(); render();
}

async function openFile(path) {
  closeOverlays();
  // 换了一篇就把上一处搜索命中丢掉；同一条路径则是刚从结果里点进来的，留着给下面用
  if (!state.pendingHit || state.pendingHit.path !== path) {
    state.pendingHit = null;
    state.hitMark = null;
  }
  state.busy = true; render();
  try {
    // 双链要在**渲染期**就判得出解不解得开，但索引本身（一次全树拉取，实测 3~5 秒）
    // 不能拦在这次打开的路上——那会把打开一篇笔记从 1 秒拖成 4 秒。所以：预热，不 await。
    // 索引还没到就先按中性「不知道」渲染，到了由 ensureIndex 补一次 render 换掉。
    // 索引拿不到不算打开失败：正文照读。
    ensureIndex().catch(() => {});
    const file = await readFile(path);
    state.view = 'editor';
    state.file = file; state.path = path;
    state.mode = 'read'; state.draft = file.content;
    // 新建完直接进来的那一次：跳过阅读态，落笔就写（空笔记停在阅读态没有意义）
    if (state.openInEdit === path) { state.mode = 'edit'; state.openInEdit = null; }
    state.busy = false;
  } catch (e) {
    state.busy = false;
    toast(e.message);
    location.hash = '#/';
  }
  render();
  if (state.pendingHit) applyPendingHit();
}

/** 打开某目录（走 hash 路由，好让返回键能用）。 */
function gotoDir(dir) {
  const target = '#/dir/' + encodeURIComponent(dir);
  if (location.hash === target) loadDir(dir);
  else location.hash = target; // hashchange → navigate → loadDir
}

async function save() {
  state.busy = true; render();
  try {
    const r = await writeFile(state.file.path, state.draft, state.file.sha, commitMessage.edit(state.file.path));
    state.file.sha = r.sha; state.file.content = state.draft;
    state.mode = 'read';
    toast('已保存');
  } catch (e) {
    if (e.conflict && e.remote) enterConflict(e.remote);
    else toast(e.conflict ? '保存冲突：远端已被改动' : e.message);
  }
  state.busy = false; render();
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
  if (!isAllResolved(state.conflict)) { toast('还有差异未处理'); return; }
  const merged = computeMerged(state.conflict);
  state.busy = true; render();
  try {
    const r = await writeFile(state.file.path, merged, state.conflict.remote.sha, commitMessage.merge(state.file.path));
    state.file.sha = r.sha; state.file.content = merged;
    state.mode = 'read'; state.conflict = null;
    toast('合并已保存');
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
  if (state.view === 'editor') renderEditor();
  else if (state.view === 'settings') renderSettings();
  else renderList();
}

// 「返回」回到这篇笔记**所在的目录**，不是回到根。从深目录点进来，再退回根，
// 等于每看一篇都要重新走一遍路径。
function backHref() {
  return '#/dir/' + encodeURIComponent(dirOf(state.path));
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
    const icon = e.type === 'dir' ? '▸' : (e.name.endsWith('.md') ? '¶' : '·');
    // 目录行不给「⋯」：目录的改名 / 移动 / 删除都要逐个文件重写（Gitee 没有目录级动作）,
    // 本版不做。放一个只会说「不支持」的按钮，比没有按钮更烦人。
    const more = e.type === 'dir'
      ? ''
      : '<button class="row-more" data-more="' + esc(e.path) + '" aria-label="更多操作">⋯</button>';
    if (e.type === 'dir') {
      return '<div class="row"><a class="row-main" href="#/dir/' + encodeURIComponent(e.path) + '"><span class="ic dir">' + icon + '</span><span class="nm">' + esc(e.name) + '</span></a></div>';
    }
    if (e.name.endsWith('.md')) {
      return '<div class="row"><a class="row-main" href="#/edit/' + encodeURIComponent(e.path) + '"><span class="ic md">' + icon + '</span><span class="nm">' + esc(e.name) + '</span></a>' + more + '</div>';
    }
    return '<div class="row dim"><span class="row-main"><span class="ic">' + icon + '</span><span class="nm">' + esc(e.name) + '</span></span>' + more + '</div>';
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

/* ---------- 文件操作的浮层：操作表 / 弹窗 / 目录选择器 ---------- */

function renderOverlays() {
  return renderOps() + renderPicker() + renderDialog();
}

/** 「⋯」点开的那张表。三个动作，笔记页与目录页同一套。 */
function renderOps() {
  if (!state.ops) return '';
  // 编辑态：三个动作置灰。做的不是「自动先保存再执行」——保存一旦撞上远端改动，
  // 用户会被扔进冲突合并界面，本来只想改个名字的人得先处理冲突（#11 已定不做）。
  const editing = state.view === 'editor' && state.mode === 'edit';
  const cls = editing ? ' is-disabled' : '';
  return '<div class="sheet-mask" data-act="closeOps"></div>' +
    '<div class="sheet auto">' +
    '<div class="sheet-head">' + esc(baseOf(state.ops.path)) + '</div>' +
    '<div class="ops">' +
    '<button class="op' + cls + '" data-op="rename">重命名</button>' +
    '<button class="op' + cls + '" data-op="move">移动</button>' +
    '<button class="op danger' + cls + '" data-op="delete">删除</button>' +
    '</div>' +
    (editing ? '<div class="op-hint">编辑中，先保存或取消</div>' : '') +
    '<div class="sheet-foot"><div class="sheet-row">' +
    '<button data-act="closeOps">取消</button></div></div>' +
    '</div>';
}

/** 弹窗：填名字（新建 / 重命名）与两次确认（删除 / 移动）共用一套壳。 */
function renderDialog() {
  const d = state.dialog;
  if (!d) return '';
  let inner;
  if (d.type === 'prompt') {
    inner = '<div class="modal-title">' + esc(d.title) + '</div>' +
      '<div class="modal-hint">' + esc(d.hint) + '</div>' +
      '<input id="dlg-input" class="dlg-input" type="text" value="' + esc(d.value) + '"' +
      ' autocapitalize="off" autocomplete="off" spellcheck="false">' +
      (d.warn ? '<div class="modal-warn">' + d.warn + '</div>' : '') +
      '<div class="modal-err">' + esc(d.error || '') + '</div>' +
      '<div class="modal-btns"><button data-act="closeDialog">取消</button>' +
      '<button class="primary" data-act="submitDialog">' + esc(d.okLabel) + '</button></div>';
  } else {
    inner = '<div class="modal-title">' + esc(d.title) + '</div>' +
      '<div class="modal-body">' + d.body + '</div>' +
      '<div class="modal-btns"><button data-act="closeDialog">取消</button>' +
      '<button class="' + (d.danger ? 'danger' : 'primary') + '" data-act="confirmDialog">' +
      esc(d.okLabel) + '</button></div>';
  }
  return '<div class="modal-mask" data-act="closeDialog"></div><div class="modal">' + inner + '</div>';
}

function renderPicker() {
  const p = state.picker;
  if (!p) return '';
  const dirs = (p.entries || []).filter((e) => e.type === 'dir');
  let rows = '';
  if (p.dir) {
    rows += '<button class="row pick-row" data-enter="' + esc(dirOf(p.dir)) + '">' +
      '<span class="ic dir">↑</span><span class="nm">上一级</span></button>';
  }
  rows += dirs.map((d) =>
    '<button class="row pick-row" data-enter="' + esc(d.path) + '">' +
    '<span class="ic dir">▸</span><span class="nm">' + esc(d.name) + '</span></button>').join('');
  if (!dirs.length && !p.busy) rows += '<div class="center dim">（没有子目录）</div>';

  return '<div class="sheet-mask" data-act="closeDialog"></div>' +
    '<div class="sheet">' +
    '<div class="sheet-head">移动到…</div>' +
    // 这里的路径是**纯文字**，不是面包屑链接：选择器里点一下就退出选择器（改的是页面
    // 的 hash），那是陷阱。要走上去有上面的「上一级」。
    '<div class="pick-crumbs">' + (p.dir ? esc(p.dir.split('/').join(' / ')) : '根目录') + '</div>' +
    '<div class="sheet-body pick-body">' + (p.busy ? '<div class="center">加载中…</div>' : rows) + '</div>' +
    '<div class="sheet-foot">' +
    '<div class="pick-target">放这里：<b>' + esc(p.dir || '根目录') + '</b></div>' +
    (p.error ? '<div class="modal-err">' + esc(p.error) + '</div>' : '') +
    '<div class="sheet-row"><button data-act="closeDialog">取消</button>' +
    // 目录还在读的时候这个键不能答应——那时候判不了重名。但它也不该是个死键：
    // 灰着，点一下会说清为什么（见 pickerMoveHere）
    '<button class="primary' + (p.busy ? ' is-disabled' : '') + '" data-act="moveHere">就放这里</button>' +
    '</div></div></div>';
}

/** 弹窗里的输入框：值存回 state（重渲染不丢），回车等于「确定」。 */
function wireDialog() {
  const d = state.dialog;
  if (!d || d.type !== 'prompt') return;
  const inp = document.getElementById('dlg-input');
  if (!inp) return;
  inp.addEventListener('input', () => { d.value = inp.value; if (d.error) { d.error = ''; } });
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitDialog(); });
  inp.focus();
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

function openCreate() {
  state.ops = null;
  state.dialog = {
    type: 'prompt', action: 'create',
    title: '新建笔记',
    hint: '放在 ' + (state.path || '根目录') + '。只填名字，路径由当前目录决定。',
    value: '', error: '', okLabel: '新建',
  };
  render();
}

function openRename(path) {
  state.ops = null;
  state.dialog = {
    type: 'prompt', action: 'rename', subject: path,
    title: '重命名',
    hint: '只改名字，还放在 ' + (dirOf(path) || '根目录') + '。',
    warn: '别的笔记里指向「' + esc(baseOf(path)) + '」的链接会断——' +
      '本端只认得文件名，读不到别的笔记的正文，改不了那些链接，也报不出断了几条。',
    value: stemOf(path), error: '', okLabel: '改名',
  };
  render();
}

function openDelete(path) {
  state.ops = null;
  state.dialog = {
    type: 'confirm', action: 'delete', subject: path,
    title: '删除「' + baseOf(path) + '」？',
    body: '删掉就没了，不进回收站，也别处没有副本。' +
      '删完屏幕下方会给一次<b>撤销</b>，那一下能把原内容照原样放回去。',
    okLabel: '删除', danger: true,
  };
  render();
}

/** 弹窗的「确定」。填名字的两个动作先过一遍本地规则，省一次注定失败的写。 */
async function submitDialog() {
  const d = state.dialog;
  if (!d || d.type !== 'prompt') return;
  const n = normalizeNewName(d.value);
  if (!n.ok) { d.error = n.error; render(); return; }
  if (d.action === 'create') await doCreate(state.path, n.name);
  else await doRename(d.subject, n.name);
}

async function confirmDialog() {
  const d = state.dialog;
  if (!d || d.type !== 'confirm') return;
  if (d.action === 'delete') await doDelete(d.subject);
  else if (d.action === 'move') await doMove(d.subject, d.to);
  else if (d.action === 'clearBodies') await doClearBodies();
}

/* ---------- 新建 ---------- */

async function doCreate(dir, name) {
  const path = joinPath(dir, name);
  closeOverlays();
  state.busy = true; render();
  try {
    // Gitee 不收空内容（`400 content is empty`），一篇空笔记得至少写一个换行
    await createFile(path, '\n', commitMessage.create(path));
  } catch (e) {
    state.busy = false;
    toast(e.exists ? '这个名字已经有了' : '没建成：' + e.message);
    render();
    return;
  }
  state.busy = false;
  // 新建完直接进这篇、并且直接进编辑态：空笔记停在阅读态没有意义，
  // 不然还得「点一下行 → 点编辑」两下才开始写。
  state.openInEdit = path;
  location.hash = '#/edit/' + encodeURIComponent(path);
  toast('已新建 ' + name);
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
  // 删的正是当前打开的那篇 → 回到它所在的目录
  if (state.view === 'editor') gotoDir(state.undo.dir);
  else await loadDir(state.path);
  toast('已删除 ' + baseOf(path), { label: '撤销', run: undoDelete });
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
    toast('已恢复 ' + baseOf(u.path));
    if (state.view === 'list') await loadDir(state.path);
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
  closeOverlays();
  if (next === oldPath) { toast('名字没变'); render(); return; }
  state.busy = true; render();
  try {
    // 先确认新名字没被占。这一步是读，失败了不会留下半成品
    const entries = await listDir(dir);
    if (hasName(entries, newName, { except: oldPath })) {
      state.busy = false;
      openRename(oldPath);
      state.dialog.error = '这个名字已经有了';
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
 * 改名的执行体。两步，顺序不能反。
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
    if (state.view === 'list') await loadDir(state.path);
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
    if (state.view === 'list') await loadDir(state.path);
    render();
    return;
  }

  state.busy = false;
  if (state.view === 'editor') location.hash = '#/edit/' + encodeURIComponent(to);
  else gotoDir(dirOf(to));
  toast(verb === 'rename' ? '已改名为 ' + baseOf(to) : '已移到 ' + (dirOf(to) || '根目录'));
}

/* ---------- 移动用的目录选择器 ---------- */

function openPicker(path) {
  state.ops = null;
  state.picker = { path, dir: '', entries: [], busy: true, error: '' };
  render();
  loadPickerDir('');
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

/** 「就放这里」——先本地判一次同名，再弹确认。 */
function pickerMoveHere() {
  const p = state.picker;
  if (!p) return;
  // 还没读完就不能答应：这一步要拿目标目录的清单判重名，清单没到手时判不了。
  // 但也不能装作没听见——点一下就静悄悄什么都不发生，比报错更让人迷惑
  if (p.busy) { p.error = '这个目录还没读完，稍等一下'; render(); return; }
  const from = p.path;
  const to = moveTarget(from, p.dir);
  if (to === from) { p.error = '它已经在这个目录里了'; render(); return; }
  if (hasName(p.entries, baseOf(from))) { p.error = '这个目录里已经有同名的了'; render(); return; }
  // 确认文案与重命名**不同**：断的不是同一批链接
  state.dialog = {
    type: 'confirm', action: 'move', subject: from, to,
    title: '移到 ' + (p.dir || '根目录') + '？',
    body: '名字还是 <b>' + esc(baseOf(from)) + '</b>。' +
      '别的笔记里<b>用完整路径写</b>的链接会断，<b>只写名字</b>的那种没事——' +
      '本端不会替你改链接，也报不出断了几条。',
    okLabel: '移动',
  };
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

/* ---------- 待办勾选框（#13/#27/#28） ---------- */
//
// 点一个存一个（#13 定稿）：点下立即在页面上勾上（乐观），排队逐个提交，每次都带
// sha 核对。失败 → 这一勾退回原样、提示，**排在其后的全部停住**——正文基准已经
// 不确定，继续提交等于把没见过的内容往仓库里写。
// 远端被改过（sha 核对不过）不自动进冲突合并界面：从勾选框掉进合并界面会把人打蒙。
//
// 每条排队项都揣着**点下去之前的那份正文**（`prev`）。失败时按它整份还原，而不是
// 「再切一次」——#28 起切换会顺带增删 `✅` 日期，再切一次回不到原样（原来那个日期
// 已经被今天顶掉了）。整份还原还有个好处：排在后面的那几个乐观勾会跟着一起消失，
// 界面上不留「看着勾上了、其实没存上」的假勾。
const taskQueue = [];
let taskSaving = false;

/** 点了某个方框：先乐观切换这一行，再排队保存。 */
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
  taskQueue.push({ prev, done });
  pumpTaskQueue();
}

async function pumpTaskQueue() {
  if (taskSaving) return;
  taskSaving = true;
  try {
    while (taskQueue.length) {
      // 离开阅读态（进编辑 / 冲突 / 返回目录）就别再写了：界面上没人等着它，
      // 而且编辑态以 state.draft 为准，后台改 content 会把两边搅乱
      if (state.view !== 'editor' || state.mode !== 'read') { taskQueue.length = 0; return; }
      const job = taskQueue[0];
      try {
        const r = await writeFile(
          state.file.path,
          state.file.content,
          state.file.sha,
          commitMessage.check(state.file.path, job.done),
        );
        state.file.sha = r.sha;
        taskQueue.shift(); // 存成了才出队——失败时它还得留着还原用
        toast('已保存');
      } catch (e) {
        state.file.content = job.prev;
        taskQueue.length = 0;
        toast(e.conflict
          ? '这篇在别处被改过，没存上。重新打开这篇再勾'
          : '没存上：' + e.message);
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
        return;
      }
    }
  } finally {
    taskSaving = false;
  }
}

function renderEditor() {
  const name = state.path.split('/').pop();

  if (state.mode === 'conflict') {
    app.innerHTML =
      '<header class="bar"><a class="back" href="' + backHref() + '">‹ 返回</a><span class="title">' + esc(name) + ' · 冲突合并</span></header>' +
      '<main class="editor-body">' + renderConflict() + '</main>' +
      '<footer class="foot"><button class="primary" id="preview-btn">预览改动处理</button></footer>' +
      renderToast();
    const pb = document.getElementById('preview-btn');
    if (pb) pb.addEventListener('click', () => { state.conflict.previewOpen = !state.conflict.previewOpen; state.conflict.copyPrompt = false; render(); });
    if (state.activeFrag != null) requestAnimationFrame(positionBubble);
    return;
  }

  const body = state.mode === 'read'
    ? '<article class="md">' + md.render(state.file.content, { notePath: state.path }) + '</article>'
    : '<textarea class="editor" id="editor">' + esc(state.draft) + '</textarea>';

  const actions = state.mode === 'read'
    ? '<button class="primary" id="edit-btn">编辑</button>'
    : '<button id="cancel-btn">取消</button><button class="primary" id="save-btn">保存</button>';

  // 笔记页右上角也有「⋯」，内容与目录页相同。编辑态下按钮**不 disable**——
  // disable 掉就点不动，那句「先保存或取消」也就没人看得见；置灰交给样式，提示交给点一下。
  const more = '<button class="row-more' + (state.mode === 'edit' ? ' is-disabled' : '') +
    '" data-more="' + esc(state.path) + '" aria-label="更多操作">⋯</button>';

  app.innerHTML =
    '<header class="bar"><a class="back" href="' + backHref() + '">‹ 返回</a><span class="title">' + esc(name) + '</span>' + more + '</header>' +
    '<main class="editor-body">' + body + '</main>' +
    '<footer class="foot">' + actions + '</footer>' +
    renderOverlays() +
    renderToast();

  const ta = document.getElementById('editor');
  if (ta) {
    ta.value = state.draft;
    ta.addEventListener('input', () => { state.draft = ta.value; });
  }
  const eb = document.getElementById('edit-btn');
  if (eb) eb.addEventListener('click', () => { state.mode = 'edit'; render(); });
  const cb = document.getElementById('cancel-btn');
  if (cb) cb.addEventListener('click', () => { state.draft = state.file.content; state.mode = 'read'; render(); });
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
      // ---- #26 文件操作 ----
      case 'newFile': openCreate(); break;
      case 'closeOps': state.ops = null; render(); break;
      case 'closeDialog': state.dialog = null; render(); break;
      case 'submitDialog': submitDialog(); break;
      case 'confirmDialog': confirmDialog(); break;
      case 'moveHere': pickerMoveHere(); break;
      // ---- 搜索与设置（#33） ----
      case 'openSettings': openSettings(); break;
      case 'clearQuery': state.query = ''; onQueryChanged(); break;
      case 'clearBodies': askClearBodies(); break;
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
    // 编辑态：三个动作置灰，点哪个都只说这一句。不自动先保存再执行
    if (state.view === 'editor' && state.mode === 'edit') { toast('先保存或取消，再改文件'); return; }
    const subject = state.ops ? state.ops.path : state.path;
    const op = opBtn.dataset.op;
    if (op === 'rename') openRename(subject);
    else if (op === 'move') openPicker(subject);
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
  if (head.sha === knownHead) {
    syncBodies({ consider: true, reused: true }).catch(() => {});
    return;
  }
  knownHead = head.sha;
  ensureIndex({ force: true }).catch(() => {}); // 清单变了要重建，它会顺带踢一次正文同步
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheckRepo();
});

window.addEventListener('hashchange', navigate);
resetFab();
navigate();
// 本地已经存着正文的话，篇数得先亮出来（「共 Y 篇」要等名单，那一半随索引到位补上）
if (prefs.body) refreshBodyStats().then(renderIfIdle);
