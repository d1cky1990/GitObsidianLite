// GitHub 实现（REST API 2022-11-28）。和 gitee.js 导出**同一组动作**，
// `core.js` 只认那组动作，不问实现是哪家。
//
// 两家的差异不在这里逐条列举——它们全部吸收在下面的函数里，对外只交
// providers/base.js 那四个词。GitHub 侧要记住的只有三条：
//   · 鉴权走 **Bearer 头**（不是查询串），且**必须带 User-Agent**（缺了直接 403）；
//   · 新建与更新是**同一个 `PUT`**，靠带不带 `sha` 区分；撞名回 `422`；
//   · 删除的参数在 **body**，成功回一个新 commit。

import { KIND, base64ToUtf8, conflict, exists, notFound, upstream, utf8ToBase64 } from './base.js';

export const BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** GitHub 的错误体是 `{message, errors:[{code, field}]}`；`message` 里常带换行 */
function messageOf(body) {
  if (typeof body === 'string') return /^\s*</.test(body) ? '' : body.slice(0, 200);
  if (!body || typeof body !== 'object') return '';
  if (body.message) return String(body.message).replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}

// 「新建撞上已有文件」在 GitHub 上的样子：不带 sha 去写一个已存在的路径，回 `422`，
// 措辞是 `Invalid request. "sha" wasn't supplied.`（注意 **sha 带引号**，照抄实测措辞时
// 别把它当装饰去掉）；有些老接口路径回 `already_exists`。
const EXISTS_RE = /already exists|already_exists|"?sha"?\s*(?:wasn't|is not|was not)\s+supplied/i;

/**
 * 把一次失败的响应翻成四个词之一。
 *
 * **`409` 是冲突，这条最不能漏**：漏判成普通失败，冲突合并界面永远不会出现，
 * 用户会以为改动丢了。`422` 要按措辞再分一次——它既可能是撞名，也可能只是路径不合法。
 * @param {number} status
 * @param {unknown} body
 */
export function githubError(status, body) {
  const message = messageOf(body) || `GitHub 回了 ${status}`;
  const codes = (body && Array.isArray(body.errors) ? body.errors : [])
    .map((e) => (e && (e.code || e.message)) || '')
    .join(' ');
  if (status === 409) return conflict('远端已被改动，本地版本对不上');
  if (status === 422 && EXISTS_RE.test(`${message} ${codes}`)) return exists('这个名字已经有了');
  if (status === 404) return notFound(message);
  return upstream(status, body, message);
}

// 附件 / 图片回来时的 Content-Type：**实测（2026-10-24）GitHub 连 PNG 都回
// `application/vnd.github.raw`**，把这个头原样交给浏览器，`<img>` 会当场裂开——
// 而失败的样子是「图片打不开」，一个字都不会提到 Content-Type。所以按扩展名补一次。
// 不在表里的给 octet-stream（下载得下来，只是浏览器不内联渲染）。
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json',
};

/** 按路径后缀猜一个 Content-Type，只在上游给的是「原始字节」那个笼统类型时用 */
export function mimeForPath(path) {
  const m = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && MIME_BY_EXT[m[1]]) || 'application/octet-stream';
}

/**
 * @param {{REPO_TOKEN:string, REPO_OWNER:string, REPO_REPO:string}} env
 */
export function createGithub(env) {
  const owner = env.REPO_OWNER;
  const repo = env.REPO_REPO;
  const repoPath = `/repos/${owner}/${repo}`;

  const headers = {
    Authorization: `Bearer ${env.REPO_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    // GitHub 强制要求带 User-Agent，缺了回 403，而报错里不会说「缺 UA」
    'User-Agent': 'obsidian-mobile-web',
  };

  const request = async (path, opts = {}) => {
    const resp = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!resp.ok) throw githubError(resp.status, data);
    return data;
  };

  /** 根目录与子目录的路径拼法不同：`/contents` 与 `/contents/a/b` */
  const contentsPath = (path) => `${repoPath}/contents${path ? `/${path}` : ''}`;

  return {
    name: 'github',

    async head() {
      const info = await request(repoPath);
      const branch = info.default_branch || 'main';
      const b = await request(`${repoPath}/branches/${branch}`);
      return { branch, sha: (b.commit && b.commit.sha) || '' };
    },

    /**
     * 列一层目录。**404 归一成空数组**——Gitee 对不存在的路径回 `200 + []`，
     * 前端是按「空目录」读的；这里若把 404 抛上去，同一种状态在两家会变成两种行为。
     */
    async listDir(path = '') {
      try {
        return await request(contentsPath(path));
      } catch (e) {
        if (e && e.kind === KIND.NOT_FOUND) return [];
        throw e;
      }
    },

    /**
     * 整棵树。GitHub 的 trees 端点认 tree sha（不认 commit sha），所以先取 commit 详情；
     * 取不到就退回用 commit sha 试一次——**不因为「拿不到 tree 详情」就让整棵树失败**。
     */
    async tree(commitSha) {
      let treeSha = commitSha;
      try {
        const c = await request(`${repoPath}/git/commits/${commitSha}`);
        if (c && c.tree && c.tree.sha) treeSha = c.tree.sha;
      } catch {
        // 降级
      }
      const data = await request(`${repoPath}/git/trees/${treeSha}?recursive=1`);
      return data.tree || [];
    },

    /**
     * 读一篇。三种回答与 Gitee 完全一致（`core.js` 只认这三种）：
     * `{path, sha, content}`（空文件 content 是空串）/ `{path, directory:true}` / `null`。
     *
     * 另外 GitHub 对 **1 MB 以上**的文件不回正文（`encoding: "none"`、`content` 是空串，
     * 但 `size` 非零）。那种情况改走 raw——**别把它当成一篇空笔记**。
     */
    async readFile(path) {
      let data;
      try {
        data = await request(contentsPath(path));
      } catch (e) {
        if (e && e.kind === KIND.NOT_FOUND) return null;
        throw e;
      }
      if (!data) return null;
      if (Array.isArray(data)) return { path, directory: true };

      let content = typeof data.content === 'string' ? data.content : '';
      if (!content && data.size) {
        const resp = await fetch(`${BASE}${contentsPath(path)}`, {
          headers: { ...headers, Accept: 'application/vnd.github.raw' },
        });
        if (!resp.ok) throw githubError(resp.status, await resp.text());
        content = utf8ToBase64(await resp.text());
      }
      return { path: data.path || path, sha: data.sha, content: base64ToUtf8(content) };
    },

    /** 新建与更新同一个端点，**按带不带 sha 选路**——这一步在这里就分完了。 */
    async writeFile(path, { message, content, sha }) {
      const payload = { message, content: utf8ToBase64(content) };
      if (sha) payload.sha = sha;
      const data = await request(contentsPath(path), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { sha: (data && data.content && data.content.sha) || null };
    },

    /** 删除的参数在 body，不像 Gitee 放在 query。 */
    async deleteFile(path, { sha, message }) {
      await request(contentsPath(path), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sha }),
      });
    },

    /** 附件 / 图片：让 GitHub 直接回原始字节（Accept raw），别走 base64 那一套。 */
    async raw(path) {
      const resp = await fetch(`${BASE}${contentsPath(path)}`, {
        headers: { ...headers, Accept: 'application/vnd.github.raw' },
      });
      const upstream = resp.headers.get('content-type') || '';
      // 上游回的「原始字节」类型对浏览器没有意义（图片也是这个），按扩展名补
      const contentType = /^application\/vnd\.github\.raw/i.test(upstream) ? mimeForPath(path) : upstream;
      return { status: resp.status, contentType, body: resp.body };
    },
  };
}
