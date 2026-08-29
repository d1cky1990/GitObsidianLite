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
    super(typeof body === 'string' ? body : (body && body.message) || 'Gitee 请求失败');
    this.status = status;
    this.body = body;
  }
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
    const data = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/contents/${p}`);
    if (Array.isArray(data)) return json({ error: '路径是目录，请用 /api/tree' }, 400);
    return json({ path: data.path, sha: data.sha, content: base64ToUtf8(data.content) });
  }

  // 写文件（新建 / 更新）
  if (path === '/api/file' && request.method === 'PUT') {
    const body = await request.json();
    const { path: p, message, content, sha } = body;
    if (!p || message == null || content == null) {
      return json({ error: '缺少 path / message / content' }, 400);
    }
    const payload = { message, content: utf8ToBase64(content) };
    if (sha) payload.sha = sha;
    try {
      const data = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/contents/${p}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return json({ path: data.content ? data.content.path : p, sha: data.content ? data.content.sha : data.sha });
    } catch (e) {
      if (e instanceof GiteeError) {
        // sha 不匹配 → 冲突
        const conflict = e.status === 400 || e.status === 422;
        if (conflict) {
          // 拉取远端最新内容，供前端做 diff 合并
          try {
            const latest = await gitee(env, `/repos/${env.GITEE_OWNER}/${env.GITEE_REPO}/contents/${p}`);
            if (!Array.isArray(latest) && latest.content) {
              return json({
                error: e.message,
                conflict: true,
                remote: { path: latest.path, sha: latest.sha, content: base64ToUtf8(latest.content) },
              }, 409);
            }
          } catch (_) { /* 忽略，走通用冲突返回 */ }
        }
        return json({ error: e.message, conflict }, conflict ? 409 : e.status || 500);
      }
      throw e;
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
