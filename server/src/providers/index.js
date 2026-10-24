// 适配层的门：按 `REPO_PROVIDER` 挑一家，返回**同一组动作**。
//
// 这里是 `core.js` 唯一该 import 的适配层文件——它不认识 `providers/gitee.js`、
// 也不认识 `providers/github.js`，因此也就不会长出「这家这样、那家那样」的分支。
// 新增一家供应商 = 加一个文件 + 往下面这张表里加一行，core 一个字不动。

import { createGitee } from './gitee.js';
import { createGithub } from './github.js';
import { PROVIDER_NAMES } from '../env-names.js';

export { PROVIDER_NAMES };

const FACTORIES = {
  gitee: createGitee,
  github: createGithub,
};

/**
 * 适配层对 core 暴露的动作（两家必须齐全，缺一个就是运行时的事故）：
 *
 *   head()                        → {branch, sha}
 *   listDir(path)                 → 目录条目数组（原样给前端）
 *   tree(commitSha)               → 树节点数组（path / type / sha）
 *   readFile(path)                → {path, sha, content} | {path, directory:true} | null
 *                                   ← 三种回答，别混：空文件是第一种（content 为空串）
 *   writeFile(path, {message, content, sha}) → {sha}              ← 带 sha 改、不带 sha 建
 *   deleteFile(path, {sha, message})         → 无返回
 *   blob(sha)                     → {sha, content}
 *   raw(path)                     → {status, contentType, body}   ← CORS 与缓存头由 core 加
 *
 * 失败一律抛 `RepoError`，`kind` 是 base.js 那四个词之一。
 *
 * @param {{REPO_PROVIDER:string, REPO_TOKEN:string, REPO_OWNER:string, REPO_REPO:string}} env
 */
export function createProvider(env) {
  const factory = FACTORIES[env.REPO_PROVIDER];
  if (!factory) {
    // core 在调到这里之前已经校验过取值；能走到这行说明两处的名单不同步了
    throw new Error(`不认识的 REPO_PROVIDER：${env.REPO_PROVIDER}（可选 ${PROVIDER_NAMES.join(' / ')}）`);
  }
  return factory(env);
}

export { KIND, RepoError } from './base.js';
