// Obsidian 移动端同步 · 核心 API 逻辑（平台无关）
// 被 server/src/index.js（Cloudflare Workers）与 deploy/main.ts（Deno Deploy）共用。
// 代理 Gitee API v5，藏 token、解 CORS、做 UTF-8 编解码；可选简单密码鉴权（APP_PASSWORD）。

const BASE = 'https://gitee.com/api/v5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });
}

class GiteeError extends Error {
  constructor(status, body) {
    super(messageOf(body) || 'Gitee 请求失败');
    this.status = status;
    this.body = body;
  }
}

// Gitee 的错误体有两种形态：`{"message":"..."}` 与 `{"messages":["...","..."]}`
function messageOf(body) {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return '';
  if (body.message) return body.message;
  if (Array.isArray(body.messages)) return body.messages.join('；');
  return '';
}

// 写操作的 400 被三种情况共用：**缺 sha**、**内容为空**、**sha 对不上**（2026-09-21 实测）。
// 状态码分不开它们，只能看措辞——认错一个，「远端被改过」就会被说成「参数不对」，
// 而这两件事对用户的意义完全相反：一件要他合并，一件是本端的 bug。
const SHA_MISMATCH_RE = /mismatch|does not match/i;
const NAME_TAKEN_RE = /已存在|already exists/i;

function isShaMismatch(status, body) {
  return (status === 400 || status === 409 || status === 422) && SHA_MISMATCH_RE.test(messageOf(body));
}

function isNameTaken(status, body) {
  return status === 400 && NAME_TAKEN_RE.test(messageOf(body));
}

async function gitee(env, path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}access_token=${env.GITEE_TOKEN}`;
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) throw new GiteeError(resp.status, data);
  return data;
}

// UTF-8 字符串 → base64
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// base64 → UTF-8 字符串
function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function requireEnv(env) {
  const { GITEE_TOKEN, GITEE_OWNER, GITEE_REPO } = env;
  if (!GITEE_TOKEN || !GITEE_OWNER || !GITEE_REPO) {
    throw new Error('未配置 GITEE_TOKEN / GITEE_OWNER / GITEE_REPO（本地放 .dev.vars，线上配环境变量）');
  }
}

async function getHead(env) {
  const repo = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}`);
  const branch = repo.default_branch || 'master';
  const b = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/branches/${branch}`);
  return { branch, sha: b.commit && b.commit.sha };
}

async function getTreeSha(env, commitSha) {
  // 尝试从 commit 详情拿 tree sha（Gitee 无 tree 详情时用 commit sha 兜底）
  try {
    const c = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/commits/${commitSha}`);
    if (c.commit && c.commit.tree && c.commit.tree.sha) return c.commit.tree.sha;
  } catch (e) {
    // 降级：直接返回 commit sha
  }
  return commitSha;
}

/* ---------- 可选访问密码（APP_PASSWORD 配置后启用） ---------- */

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(header, name) {
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// 鉴权：X-Auth header 明文比对，或 auth cookie（存密码的 SHA-256，供 <img src=/api/raw> 复用）
async function checkAuth(request, env) {
  const pw = env.APP_PASSWORD;
  if (!pw) return { ok: true };
  const header = request.headers.get('X-Auth');
  if (header === pw) return { ok: true, viaHeader: true };
  const cookie = getCookie(request.headers.get('Cookie') || '', 'auth');
  if (cookie && cookie === (await sha256hex(pw))) return { ok: true };
  return { ok: false };
}

/* ---------- 内容读写：Gitee 把「新建」和「更新」拆成了两个端点 ---------- */

function contentsPath(env, p) {
  return `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/contents/${p}`;
}

/**
 * 读远端文件。**读不到时返回 null，不抛错**——因为 Gitee 对不存在的路径回的是
 * `200 + []`（文件和目录都如此，2026-09-21 实测），拿状态码判存在性会全判错。
 */
async function readRemote(env, p) {
  const data = await gitee(env, contentsPath(env, p));
  if (Array.isArray(data) || !data.content) return null;
  return { path: data.path, sha: data.sha, content: base64ToUtf8(data.content) };
}

/**
 * 写内容。**带 `sha` 是改，不带是建**——这层差异留在服务端。
 *
 * 浏览器不该知道 Gitee 的脾气：`sha` 在那里不是可选项（缺了直接
 * `400 {"messages":["sha is missing","sha is empty"]}`，官方规约也把它标成 required），
 * 新建走的是另一个端点 `POST /contents/{path}`（无 sha，成功 201）。
 *
 * 另：往还不存在的目录里建文件**不需要先建目录**，Gitee 会顺着路径把目录带出来
 * （实测 201，随后 GET 该目录就列得到）。git 里本来也没有「目录」这个东西。
 *
 * 还有一条：**空内容建不出来**（`400 {"messages":["content is empty"]}`），
 * 建一篇空笔记得至少写一个换行。这条由调用方保证（见 web 端的新建）。
 */
async function writeContent(env, p, { message, content, sha }) {
  const payload = { message, content: utf8ToBase64(content) };
  if (sha) payload.sha = sha;
  return gitee(env, contentsPath(env, p), {
    method: sha ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * 写失败的三种去向。它们不能混成一句话：
 * - **sha 对不上** → 远端变了，把远端正文一并带回去，让前端做 diff 合并
 * - **名字已存在** → 新建撞名。它不是冲突（没有远端内容可合并），也不该说成失败
 * - **其余** → 原样透传状态码与措辞
 */
async function writeFailure(e, env, p) {
  if (isShaMismatch(e.status, e.body)) {
    const out = { error: '远端已被改动，本地版本对不上', conflict: true };
    try {
      const remote = await readRemote(env, p);
      if (remote) out.remote = remote;
    } catch (_) { /* 拉不到远端正文也照样报冲突——别把冲突降级成失败 */ }
    return json(out, 409);
  }
  if (isNameTaken(e.status, e.body)) {
    return json({ error: '这个名字已经有了', exists: true }, 409);
  }
  return json({ error: messageOf(e.body) || e.message }, e.status || 500);
}

/* ---------- 路由 ---------- */

async function routeApi(request, env, url) {
  requireEnv(env);
  const path = url.pathname;
  const q = url.searchParams;

  // 仓库 HEAD（默认分支 + 最新 commit sha）
  if (path === '/api/head' && request.method === 'GET') {
    return json(await getHead(env));
  }

  // 列目录 / 文件列表（懒加载）
  if (path === '/api/tree' && request.method === 'GET') {
    const p = q.get('path') || '';
    const data = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/contents/${p}`);
    return json(data);
  }

  // 整棵树（path → blob sha），用于增量检测
  if (path === '/api/tree/recursive' && request.method === 'GET') {
    const head = await getHead(env);
    const treeSha = await getTreeSha(env, head.sha);
    const data = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/git/trees/${treeSha}?recursive=1`);
    return json({ head: head.sha, tree: data.tree || [] });
  }

  // 读文件
  if (path === '/api/file' && request.method === 'GET') {
    const p = q.get('path') || '';
    const data = await gitee(env, contentsPath(env, p));
    // 空数组 = 这个路径上没有东西。它也可能是个空目录，但调用方要的是文件
    if (Array.isArray(data)) {
      if (!data.length) return json({ error: '文件不存在', notFound: true }, 404);
      return json({ error: '路径是目录，请用 /api/tree' }, 400);
    }
    return json({ path: data.path, sha: data.sha, content: base64ToUtf8(data.content) });
  }

  // 写文件（带 sha 是更新，不带 sha 是新建）
  if (path === '/api/file' && request.method === 'PUT') {
    const body = await request.json();
    const { path: p, message, content, sha } = body;
    if (!p || message == null || content == null) {
      return json({ error: '缺少 path / message / content' }, 400);
    }
    try {
      const data = await writeContent(env, p, { message, content, sha });
      return json({ path: p, sha: (data.content && data.content.sha) || null });
    } catch (e) {
      if (!(e instanceof GiteeError)) throw e;
      return writeFailure(e, env, p);
    }
  }

  // 删文件
  if (path === '/api/file' && request.method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const { path: p, sha, message } = body;
    if (!p || !sha || !message) return json({ error: '缺少 path / sha / message' }, 400);
    // Gitee 的 DELETE 把 sha / message 放在 **query**（规约如此），不像 PUT 走 body
    const qs = `?sha=${encodeURIComponent(sha)}&message=${encodeURIComponent(message)}`;
    try {
      await gitee(env, contentsPath(env, p) + qs, { method: 'DELETE' });
      // 成功回 200，但 body 里的 `content` 是 **null**（实测）——别去取 content.sha
      return json({ path: p, deleted: true });
    } catch (e) {
      if (!(e instanceof GiteeError)) throw e;
      if (isShaMismatch(e.status, e.body)) {
        return json({ error: '这篇在别处被改过，删之前得先看一眼', conflict: true }, 409);
      }
      if (e.status === 404) {
        return json({ error: '文件不在了（可能刚被别处删掉）', notFound: true }, 404);
      }
      return json({ error: messageOf(e.body) || e.message }, e.status || 500);
    }
  }

  // 图片 / 附件 raw（代理转发）
  if (path === '/api/raw' && request.method === 'GET') {
    const p = q.get('path') || '';
    const resp = await fetch(
      `${BASE}/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/raw/${p}?access_token=${env.GITEE_TOKEN}`
    );
    const headers = { ...CORS };
    const ct = resp.headers.get('content-type');
    if (ct) headers['Content-Type'] = ct;
    headers['Cache-Control'] = 'public, max-age=3600';
    return new Response(resp.body, { status: resp.status, headers });
  }

  return json({ error: 'not found' }, 404);
}

/**
 * 统一 API 入口。
 * @param {Request} request
 * @param {{GITEE_TOKEN:string, GITEE_OWNER:string, GITEE_REPO:string, APP_PASSWORD?:string}} env
 * @returns {Promise<Response>}
 */
export async function handleApi(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const auth = await checkAuth(request, env);
  if (!auth.ok) return json({ error: '访问密码错误', auth: true }, 401);

  let resp;
  try {
    resp = await routeApi(request, env, new URL(request.url));
  } catch (e) {
    if (e instanceof GiteeError) {
      resp = json({ error: e.message }, e.status || 500);
    } else {
      resp = json({ error: e.message || '内部错误' }, 500);
    }
  }

  // header 鉴权成功 → 种 cookie（哈希值），让 <img src=/api/raw> 这类带不了 header 的请求也能过
  if (auth.viaHeader && env.APP_PASSWORD) {
    const headers = new Headers(resp.headers);
    headers.append(
      'Set-Cookie',
      `auth=${await sha256hex(env.APP_PASSWORD)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
    );
    return new Response(resp.body, { status: resp.status, headers });
  }
  return resp;
}
