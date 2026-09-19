import MarkdownIt from 'markdown-it';
import { listDir, listTree, listHead, readFile, writeFile, rawUrl } from './api.js';
import { installVaultImageRule, brokenImageHtml, runtimeFailureReason } from './vault-refs.js';
import {
  installWikilinkRule, buildWikilinkIndex, hydrateWikilinkIndex, serializeWikilinkIndex, lookupWikilink,
} from './wikilinks.js';
import './style.css';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// 双链与图片共用同一份索引（`#7` 建的，含非 `.md` 文件的 basename → 路径）：
// 双链拿它判「解不解得开」，图片拿它在相对解析失败后按文件名反查（`#8`）。
// 声明在两个插件之前，是因为渲染钩子会读它（此时还只是闭包，不取值的）。
let wikilinkIndex = null;

// 图片 / 附件：src 先相对当前笔记所在目录解析成 vault 内路径，解析不到再按文件名反查，
// 最后都走 raw 代理。
installVaultImageRule(md, { rawUrl, getIndex: () => wikilinkIndex });

installWikilinkRule(md, { getIndex: () => wikilinkIndex, rawUrl });

const app = document.getElementById('app');

// 解析出来的路径也可能在仓库里并不存在（后端 404，或回来的不是图片）。
// error 事件不冒泡，但在捕获阶段会经过祖先节点，所以监听器挂在 #app 上。
//
// 404 只说「这个地址上没有文件」，**不等于**「文件不存在」：裸文件名的图片引用（Obsidian
// 的默认写法）解析出来本就在别人家的目录里，只要全库文件名单到手就还能按文件名找回来
// （见 vault-refs.js 的 pickVaultImagePath）。名单没到手时我们判不了这件事，只能如实说
// 还没查完——名单到了 repaintWithIndex 会整篇重画一遍，这类占位会换成真图。
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
function ensureIndex() {
  if (wikilinkIndex) return Promise.resolve(wikilinkIndex);
  if (wikilinkIndexPromise) return wikilinkIndexPromise;
  wikilinkIndexPromise = (async () => {
    try { localStorage.removeItem(LEGACY_INDEX_CACHE_KEY); } catch (e) { /* 忽略 */ }
    // 1. 拿 HEAD sha，与缓存对比
    const cached = readCachedIndex();
    const head = await listHead();
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
  })().catch((e) => { wikilinkIndexPromise = null; throw e; });
  // 索引到位 → 把上一次渲染里的中性「不知道」换成真实判定。
  // 只在只读状态补：编辑中重渲染会丢光标与未提交的输入。
  wikilinkIndexPromise.then(repaintWithIndex, () => {});
  return wikilinkIndexPromise;
}

/**
 * 索引到位后补一次渲染。
 *
 * 整篇重画（不是只改双链）：图片引用的反查结果同样取决于索引，中性占位也要一起换掉。
 * 从插件一路看下来，改名的代价比留一个说谎的函数名小。
 *
 * 只在只读态补：编辑中重渲染会丢光标与未提交的输入。
 * 补渲染会整块替换 `#app`，所以要自己把滚动位置带过去——否则用户读着读着页面跳回顶部。
 */
function repaintWithIndex() {
  if (state.view !== 'editor' || state.mode !== 'read') return;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
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
  entries: [],
  file: null, // { path, sha, content }
  mode: 'read', // 'read' | 'edit' | 'conflict'
  draft: '',
  message: '',
  busy: false,
  conflict: null, // { local, remote, fragments, decisions, previewOpen, copyPrompt }
  activeFrag: null, // 当前点击的 diff 片段 id
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg) {
  state.message = msg;
  render();
  setTimeout(() => { if (state.message === msg) { state.message = ''; render(); } }, 2500);
}

function navigate() {
  const hash = location.hash.slice(1) || '';
  if (hash.startsWith('/edit/')) {
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
  state.busy = true; state.message = ''; render();
  try { state.entries = await listDir(path); state.path = path; }
  catch (e) { state.entries = []; toast(e.message); }
  state.busy = false; render();
}

async function openFile(path) {
  state.busy = true; state.message = ''; render();
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
    state.busy = false;
  } catch (e) {
    state.busy = false;
    toast(e.message);
    location.hash = '#/';
  }
  render();
}

async function save() {
  state.busy = true; state.message = ''; render();
  try {
    const r = await writeFile(state.file.path, state.draft, state.file.sha);
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
  state.busy = true; state.message = ''; render();
  try {
    const r = await writeFile(state.file.path, merged, state.conflict.remote.sha, '合并冲突');
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
  state.busy = true; state.message = ''; render();
  try {
    if (which === 'keepLocal') {
      await writeFile(base, c.local, c.remote.sha, '保留本地，远端存副本');
      await writeFile(stem + '.conflict.md', c.remote.content, undefined, '冲突副本：远端原内容');
      toast('已保留本地版本，远端存为 ' + stem + '.conflict.md');
    } else {
      await writeFile(stem + '.local.md', c.local, undefined, '冲突副本：本地改动');
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
  else renderList();
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

function renderList() {
  const sorted = [...state.entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const items = sorted.map((e) => {
    const icon = e.type === 'dir' ? '▸' : (e.name.endsWith('.md') ? '¶' : '·');
    if (e.type === 'dir') {
      return '<a class="row" href="#/dir/' + encodeURIComponent(e.path) + '"><span class="ic dir">' + icon + '</span><span class="nm">' + esc(e.name) + '</span></a>';
    }
    if (e.name.endsWith('.md')) {
      return '<a class="row" href="#/edit/' + encodeURIComponent(e.path) + '"><span class="ic md">' + icon + '</span><span class="nm">' + esc(e.name) + '</span></a>';
    }
    return '<div class="row dim"><span class="ic">' + icon + '</span><span class="nm">' + esc(e.name) + '</span></div>';
  }).join('');

  app.innerHTML =
    '<header class="bar"><span class="crumbs">' + crumbs(state.path) + '</span></header>' +
    '<main class="list">' +
    (state.busy ? '<div class="center">加载中…</div>' : (items || '<div class="center dim">（空目录）</div>')) +
    '</main>' +
    (state.message ? '<div class="toast">' + esc(state.message) + '</div>' : '');
}

function renderEditor() {
  const name = state.path.split('/').pop();

  if (state.mode === 'conflict') {
    app.innerHTML =
      '<header class="bar"><a class="back" href="#/">‹ 返回</a><span class="title">' + esc(name) + ' · 冲突合并</span></header>' +
      '<main class="editor-body">' + renderConflict() + '</main>' +
      '<footer class="foot"><button class="primary" id="preview-btn">预览改动处理</button></footer>' +
      (state.message ? '<div class="toast">' + esc(state.message) + '</div>' : '');
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

  app.innerHTML =
    '<header class="bar"><a class="back" href="#/">‹ 返回</a><span class="title">' + esc(name) + '</span></header>' +
    '<main class="editor-body">' + body + '</main>' +
    '<footer class="foot">' + actions + '</footer>' +
    (state.message ? '<div class="toast">' + esc(state.message) + '</div>' : '');

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
  const dbtn = e.target.closest('[data-d]');
  if (dbtn) { decide(state.activeFrag, dbtn.dataset.d); return; }
  const frag = e.target.closest('[data-fid]');
  if (frag) {
    const fid = +frag.dataset.fid;
    state.activeFrag = (state.activeFrag === fid) ? null : fid;
    render();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'closePreview') { state.conflict.previewOpen = false; state.conflict.copyPrompt = false; render(); }
    else if (a === 'commitMerge') commitMerge();
    else if (a === 'openCopy') { state.conflict.copyPrompt = true; render(); }
    return;
  }
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

window.addEventListener('hashchange', navigate);
navigate();
