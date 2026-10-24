// 适配层两家共用的那一层：**错误词汇 + UTF-8↔base64**。
//
// 两家平台把同一件事回报成不同的状态码与措辞（Gitee 的写冲突是 `400` + 措辞，
// GitHub 是 `409`；Gitee 撞名是 `400 "文件名已存在"`，GitHub 是 `422`）。这些差异
// 在各自的 provider 里吸收掉，只往下交四个词——`core.js` 认的就是这四个词，
// 不认识任何一家的号码。**认错一个，冲突就会被说成「参数不对」**：一件要用户去合并，
// 一件是本端的 bug，两句话对用户的意义完全相反（见 #17 §2 那张表）。

/** 适配层对外的错误词汇。就这四个，别再加同义词——同义词之间必然漂移。 */
export const KIND = {
  /** 远端被改过（写的时候 sha 对不上）：要用户去合并 */
  CONFLICT: 'conflict',
  /** 新建撞上已有文件：不是冲突（没有远端正文可合并），也不该说成失败 */
  EXISTS: 'exists',
  /** 路径上没有东西 */
  NOT_FOUND: 'notFound',
  /** 其余一切：原样带着状态码与措辞往上交，由 core 决定怎么说 */
  UPSTREAM: 'upstream',
};

export class RepoError extends Error {
  /**
   * @param {'conflict'|'exists'|'notFound'|'upstream'} kind
   * @param {string} message 给人看的一句话；说不清时留空，由 core 兜底
   * @param {{status?: number, body?: unknown}} [extra] 上游原样留下的状态码与错误体
   */
  constructor(kind, message, { status = 0, body = null } = {}) {
    super(message || '仓库平台请求失败');
    this.name = 'RepoError';
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

export const conflict = (message) => new RepoError(KIND.CONFLICT, message);
export const exists = (message) => new RepoError(KIND.EXISTS, message);
export const notFound = (message) => new RepoError(KIND.NOT_FOUND, message);
export const upstream = (status, body, message) =>
  new RepoError(KIND.UPSTREAM, message, { status, body });

/** UTF-8 字符串 → base64 */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64 → UTF-8 字符串。**先删空白**：两家都会把长内容按行折断，不删解出来会崩。 */
export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
