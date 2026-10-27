// Obsidian 移动端同步 · 核心 API 逻辑（平台无关）
// 由唯一的入口 server/src/index.js（Cloudflare Workers）调用；本文件不认识任何平台 API。
//
// 它也不认识任何一家仓库平台：**写冲突在哪家回 400、在哪家回 409，谁的鉴权走查询串、
// 谁的路径不存在回空数组，一条都不在这里**。这些全在 `providers/` 里吸收掉，本文件只认
// 那组动作与四个错误词（见 `providers/index.js` 的契约）。要加一家供应商，别改这个文件。
//
// 它对浏览器暴露的那一面（藏 token、解 CORS、UTF-8 编解码、可选的访问密码）一个字没变——
// 换供应商不该换前端。

import { createProvider, KIND, RepoError, PROVIDER_NAMES } from './providers/index.js';
import { LEGACY_ENV, REQUIRED_ENV } from './env-names.js';

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

/* ---------- 配置 ---------- */

/**
 * 校验配置。**错要说得清是哪一项、该改成什么**——这一层报「未配置」等于什么都没说。
 * @param {Record<string, string>} env
 */
function requireEnv(env) {
  // 旧名字还在用：逐条点名「旧名 → 新名」，别让人自己去猜三个名字的对应关系
  const legacyInUse = Object.entries(LEGACY_ENV).filter(([oldName, newName]) => env[oldName] && !env[newName]);
  if (legacyInUse.length) {
    const lines = legacyInUse.map(([oldName, newName]) => `  ${oldName} → ${newName}`).join('\n');
    throw new Error(
      `配置用的是旧变量名，已经不再认（换成不认厂商的中性名了）。逐条改成：\n${lines}\n`
      + '另外加一项 REPO_PROVIDER：连 Gitee 填 gitee，连 GitHub 填 github。'
    );
  }

  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length) {
    // 供应商缺了要把可选值一起说出来——只说「未配置」的话，人得去翻文档才知道能填什么
    const choices = missing.includes('REPO_PROVIDER') ? `（REPO_PROVIDER 只能是 ${PROVIDER_NAMES.join(' 或 ')}）` : '';
    throw new Error(`未配置 ${missing.join(' / ')}${choices}（本地放 .dev.vars，线上配环境变量）`);
  }

  // 给了值但不是那两家之一：说出可选值，别让人对着一个拼错的名字继续查网络
  if (!PROVIDER_NAMES.includes(env.REPO_PROVIDER)) {
    throw new Error(
      `REPO_PROVIDER 只能是 ${PROVIDER_NAMES.join(' 或 ')}，现在是「${env.REPO_PROVIDER}」`
    );
  }
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

/* ---------- 写失败的去向 ---------- */

/**
 * 四个错误词 → 一种回答。**映射只有这一处**：写、删、兜底都走它，各操作只在措辞上
 * 覆盖（`overrides`），别各自再写一遍状态码——三份映射必然会说出三种不同的话。
 */
function repoFailure(e, overrides = {}) {
  const message = overrides[e.kind] || e.message;
  if (e.kind === KIND.CONFLICT) return json({ error: message, conflict: true }, 409);
  if (e.kind === KIND.EXISTS) return json({ error: message, exists: true }, 409);
  if (e.kind === KIND.NOT_FOUND) return json({ error: message, notFound: true }, 404);
  return json({ error: message }, e.status || 500);
}

/**
 * 写失败的去向。冲突要额外办一件事：**把远端正文一并带回去**，让前端做 diff 合并；
 * 其余三种与别的操作没有区别，交给上面那一处映射。
 */
async function writeFailure(e, repo, p) {
  if (e.kind !== KIND.CONFLICT) return repoFailure(e, { notFound: '文件不在这个路径上' });

  const out = { error: '远端已被改动，本地版本对不上', conflict: true };
  try {
    const remote = await repo.readFile(p);
    if (remote && !remote.directory) out.remote = remote;
  } catch (_) { /* 拉不到远端正文也照样报冲突——别把冲突降级成失败 */ }
  return json(out, 409);
}

/* ---------- 路由 ---------- */

async function routeApi(request, env, url) {
  requireEnv(env);
  const repo = createProvider(env);
  const path = url.pathname;
  const q = url.searchParams;

  // 仓库 HEAD（默认分支 + 最新 commit sha）
  if (path === '/api/head' && request.method === 'GET') {
    return json(await repo.head());
  }

  // 列目录 / 文件列表（懒加载）
  if (path === '/api/tree' && request.method === 'GET') {
    return json(await repo.listDir(q.get('path') || ''));
  }

  // 整棵树（path → blob sha），用于增量检测
  if (path === '/api/tree/recursive' && request.method === 'GET') {
    const head = await repo.head();
    return json({ head: head.sha, tree: await repo.tree(head.sha) });
  }

  // 读文件
  if (path === '/api/file' && request.method === 'GET') {
    const f = await repo.readFile(q.get('path') || '');
    // 「路径上没有东西」在两家是不同的长相，已在适配层归一成 null；
    // 「这里是个目录」是另一件事，不能一起说成 404——调用方要的是文件
    if (!f) return json({ error: '文件不存在', notFound: true }, 404);
    if (f.directory) return json({ error: '路径是目录，请用 /api/tree' }, 400);
    return json(f);
  }

  // 写文件（带 sha 是更新，不带 sha 是新建）
  if (path === '/api/file' && request.method === 'PUT') {
    const body = await request.json();
    const { path: p, message, content, sha } = body;
    if (!p || message == null || content == null) {
      return json({ error: '缺少 path / message / content' }, 400);
    }
    try {
      const saved = await repo.writeFile(p, { message, content, sha });
      return json({ path: p, sha: saved.sha });
    } catch (e) {
      if (!(e instanceof RepoError)) throw e;
      return writeFailure(e, repo, p);
    }
  }

  // 删文件
  if (path === '/api/file' && request.method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const { path: p, sha, message } = body;
    if (!p || !sha || !message) return json({ error: '缺少 path / sha / message' }, 400);
    try {
      await repo.deleteFile(p, { sha, message });
      // 成功回执两家长得不一样（一方回 null，一方回一个新 commit），前端只看这一句
      return json({ path: p, deleted: true });
    } catch (e) {
      if (!(e instanceof RepoError)) throw e;
      // 措辞按操作换：删除时「被改过」要提醒先看一眼，「不在了」要说得像刚刚发生
      return repoFailure(e, {
        conflict: '这篇在别处被改过，删之前得先看一眼',
        notFound: '文件不在了（可能刚被别处删掉）',
      });
    }
  }

  // 图片 / 附件 raw（代理转发）
  if (path === '/api/raw' && request.method === 'GET') {
    const r = await repo.raw(q.get('path') || '');
    const headers = { ...CORS };
    if (r.contentType) headers['Content-Type'] = r.contentType;
    headers['Cache-Control'] = 'public, max-age=3600';
    return new Response(r.body, { status: r.status, headers });
  }

  return json({ error: 'not found' }, 404);
}

/**
 * 统一 API 入口。
 * @param {Request} request
 * @param {{REPO_PROVIDER:'gitee'|'github', REPO_TOKEN:string, REPO_OWNER:string, REPO_REPO:string, APP_PASSWORD?:string}} env
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
    if (e instanceof RepoError) {
      resp = repoFailure(e);
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
