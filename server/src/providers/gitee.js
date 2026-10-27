// Gitee 实现（API v5）。**这里的每一条判断都长在 Gitee 的脾气上**，别搬到别处：
// `core.js` 只认 providers/base.js 里那四个词，不认识 `400`、也不认识「文件名已存在」。
//
// 五处脾气（2026-09-21 在真仓库实测，逐条对应用户能看见的区别）：
//   1. 写冲突是 `400` + "Blob SHA does not match"，不是 409；
//   2. 新建与更新是两个端点（`POST` 无 sha / `PUT` 必带 sha）；
//   3. 撞名是 `400 "文件名已存在"`；
//   4. 不存在的路径回 `200 + []`（拿状态码判存在性会全判错）；
//   5. 删除的参数在 **query**，成功回 `200` 但 `content` 是 null。
//
// 还有两条不在这五处里、但同样只能靠实测知道：**空内容建不出来**（`400 content is empty`，
// 由调用方保证至少写一个换行）、**往不存在的目录里建文件不用先建目录**。

import { base64ToUtf8, conflict, exists, notFound, upstream, utf8ToBase64 } from './base.js';

export const BASE = 'https://gitee.com/api/v5';

// Gitee 的错误体有两种形态：`{"message":"..."}` 与 `{"messages":["...","..."]}`
function messageOf(body) {
  if (typeof body === 'string') return /^\s*</.test(body) ? '' : body.slice(0, 200);
  if (!body || typeof body !== 'object') return '';
  if (body.message) return String(body.message).slice(0, 200);
  if (Array.isArray(body.messages)) return body.messages.join('；').slice(0, 200);
  return '';
}

// 写操作的 400 被三种情况共用：**缺 sha**、**内容为空**、**sha 对不上**（实测）。
// 状态码分不开它们，只能看措辞——认错一个，「远端被改过」就会被说成「参数不对」。
const SHA_MISMATCH_RE = /mismatch|does not match/i;
const NAME_TAKEN_RE = /已存在|already exists/i;

/**
 * 把一次失败的响应翻成四个词之一。
 * @param {number} status
 * @param {unknown} body
 * @returns {import('./base.js').RepoError}
 */
export function giteeError(status, body) {
  const message = messageOf(body) || `Gitee 回了 ${status}`;
  if ((status === 400 || status === 409 || status === 422) && SHA_MISMATCH_RE.test(message)) {
    return conflict('远端已被改动，本地版本对不上');
  }
  if (status === 400 && NAME_TAKEN_RE.test(message)) return exists('这个名字已经有了');
  if (status === 404) return notFound(message);
  return upstream(status, body, message);
}

/**
 * @param {{REPO_TOKEN:string, REPO_OWNER:string, REPO_REPO:string}} env
 */
export function createGitee(env) {
  const owner = env.REPO_OWNER;
  const repo = env.REPO_REPO;
  const repoPath = `/repos/${owner}/${repo}`;

  const request = async (path, opts = {}) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE}${path}${sep}access_token=${env.REPO_TOKEN}`;
    const resp = await fetch(url, opts);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!resp.ok) throw giteeError(resp.status, data);
    return data;
  };

  return {
    name: 'gitee',

    /** 默认分支 + 最新 commit sha */
    async head() {
      const info = await request(repoPath);
      const branch = info.default_branch || 'master';
      const b = await request(`${repoPath}/branches/${branch}`);
      return { branch, sha: (b.commit && b.commit.sha) || '' };
    },

    /** 列一层目录。**原样交给前端**：Gitee 的形状就是前端一直在看的那个。 */
    async listDir(path = '') {
      return request(`${repoPath}/contents/${path}`);
    },

    /** 整棵树（path → blob sha）。Gitee 没有 tree 详情时用 commit sha 兜底。 */
    async tree(commitSha) {
      let treeSha = commitSha;
      try {
        const c = await request(`${repoPath}/commits/${commitSha}`);
        if (c.commit && c.commit.tree && c.commit.tree.sha) treeSha = c.commit.tree.sha;
      } catch {
        // 降级：直接用 commit sha。这里不该因为「拿不到 tree 详情」就整棵树失败
      }
      const data = await request(`${repoPath}/git/trees/${treeSha}?recursive=1`);
      return data.tree || [];
    },

    /**
     * 读一篇。三种回答，**别把后两种混成一种**：
     *   · `{path, sha, content}` —— 读到了（**空文件也是这个，content 是空串**）
     *   · `{path, directory:true}` —— 这个路径是个目录
     *   · `null` —— 这里什么都没有
     *
     * 「目录」与「不存在」在 Gitee 上都是 `200 + 数组`：空数组是没有，非空数组是目录。
     * 拿状态码判存在性会全判错（2026-09-21 实测）。
     */
    async readFile(path) {
      const data = await request(`${repoPath}/contents/${path}`);
      if (Array.isArray(data)) return data.length ? { path, directory: true } : null;
      if (!data || typeof data.content !== 'string') return null;
      return { path: data.path, sha: data.sha, content: base64ToUtf8(data.content) };
    },

    /** 带 `sha` 是改（PUT），不带是建（POST）——这条差异留在这里，浏览器不必知道。 */
    async writeFile(path, { message, content, sha }) {
      const payload = { message, content: utf8ToBase64(content) };
      if (sha) payload.sha = sha;
      const data = await request(`${repoPath}/contents/${path}`, {
        method: sha ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { sha: (data && data.content && data.content.sha) || null };
    },

    /** 删除的参数在 query；成功回 200，但 `content` 是 null——别去取它的 sha。 */
    async deleteFile(path, { sha, message }) {
      const qs = `?sha=${encodeURIComponent(sha)}&message=${encodeURIComponent(message)}`;
      await request(`${repoPath}/contents/${path}${qs}`, { method: 'DELETE' });
    },

    /** 图片 / 附件。返回原样的流入，由 core 加 CORS 与缓存头。 */
    async raw(path) {
      const resp = await fetch(`${BASE}${repoPath}/raw/${path}?access_token=${env.REPO_TOKEN}`);
      return {
        status: resp.status,
        contentType: resp.headers.get('content-type') || '',
        body: resp.body,
      };
    },
  };
}
