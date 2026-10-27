// 核心 API 面的测试：**同一种失败，两家必须变成同一种回答**。
//
// 这一层测的不是「请求发得对不对」（那是 providers.test.mjs），而是**前端看到的那句话
// 与那个状态码**：冲突要带远端正文、撞名要带 exists 标记、路径没了要 404 + notFound、
// 删成功要 {deleted:true}。换供应商时这几句一个字都不该变——变了就是前端要跟着改，
// 而这条票的底线是「前端零改动」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from './core.js';

const ENV_GITEE = { REPO_PROVIDER: 'gitee', REPO_TOKEN: 'tok1', REPO_OWNER: 'o1', REPO_REPO: 'r1' };
const ENV_GITHUB = { ...ENV_GITEE, REPO_PROVIDER: 'github' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function stubFetch(t, routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: (init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    const hit = routes.find((r) => r.match(call));
    if (!hit) throw new Error(`桩没接住这个请求：${call.method} ${call.url}`);
    const reply = hit.reply(call);
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = original; });
}

const put = (body) => new Request('http://x/api/file', {
  method: 'PUT',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});
const del = (body) => new Request('http://x/api/file', {
  method: 'DELETE',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

/* ---------------- 冲突：最不能漏的一条 ---------------- */

for (const [name, env, conflictReply, readReply] of [
  ['Gitee（400 + 措辞）', ENV_GITEE, { status: 400, body: { message: 'Blob SHA does not match' } },
    { body: { path: 'a.md', sha: 'remote-sha', content: b64('远端正文') } }],
  ['GitHub（409）', ENV_GITHUB, { status: 409, body: { message: 'sha does not match' } },
    { body: { path: 'a.md', sha: 'remote-sha', content: b64('远端正文') } }],
]) {
  test(`写冲突 → 409 + conflict + 远端正文：${name}`, async (t) => {
    stubFetch(t, [
      { match: (c) => c.method === 'PUT', reply: () => conflictReply },
      { match: (c) => c.method === 'GET', reply: () => readReply },
    ]);
    const resp = await handleApi(put({ path: 'a.md', message: 'm', content: '本地正文', sha: 'old-sha' }), env);
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.conflict, true);
    assert.equal(body.remote.content, '远端正文', '冲突要给远端正文，否则前端没法做 diff 合并');
  });
}

/* ---------------- 撞名 ---------------- */

for (const [name, env, reply] of [
  ['Gitee（400 文件名已存在）', ENV_GITEE, { status: 400, body: { message: '文件名已存在' } }],
  ['GitHub（422 缺 sha）', ENV_GITHUB, { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } }],
]) {
  test(`新建撞名 → 409 + exists：${name}`, async (t) => {
    stubFetch(t, [{ match: () => true, reply: () => reply }]);
    const resp = await handleApi(put({ path: 'a.md', message: 'm', content: '正文' }), env);
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.exists, true);
    assert.equal(body.conflict, undefined, '撞名不是冲突——没有远端内容可合并');
  });
}

/* ---------------- 路径不存在 ---------------- */

test('读一个不存在的路径 → 404 + notFound（Gitee 的 200+[] 也得当不存在）', async (t) => {
  stubFetch(t, [{ match: () => true, reply: () => ({ body: [] }) }]);
  const resp = await handleApi(new Request('http://x/api/file?path=nope.md'), ENV_GITEE);
  assert.equal(resp.status, 404);
  assert.equal((await resp.json()).notFound, true);
});

test('读一个不存在的路径 → 404 + notFound（GitHub 的 404 同一个答案）', async (t) => {
  stubFetch(t, [{ match: () => true, reply: () => ({ status: 404, body: { message: 'Not Found' } }) }]);
  const resp = await handleApi(new Request('http://x/api/file?path=nope.md'), ENV_GITHUB);
  assert.equal(resp.status, 404);
  assert.equal((await resp.json()).notFound, true);
});

/* ---------------- 两种「别的形状」：空文件、目录 ---------------- */

// 这两条是从改造前的行为倒着钉的（判据 1「逐条一致」）。空文件曾被「没有内容」这个
// 判断误伤成 404；目录曾被一并说成「文件不存在」——两件不同的事，两句话。

for (const [name, env, emptyReply] of [
  ['Gitee', ENV_GITEE, { body: { path: 'e.md', sha: 's1', content: '' } }],
  ['GitHub', ENV_GITHUB, { body: { path: 'e.md', sha: 's1', content: '', size: 0 } }],
]) {
  test(`空文件是 200 + 空正文，不是「文件不存在」：${name}`, async (t) => {
    stubFetch(t, [{ match: () => true, reply: () => emptyReply }]);
    const resp = await handleApi(new Request('http://x/api/file?path=e.md'), env);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).content, '');
  });
}

for (const [name, env] of [['Gitee', ENV_GITEE], ['GitHub', ENV_GITHUB]]) {
  test(`路径是目录 → 400 并指路，不是 404：${name}`, async (t) => {
    stubFetch(t, [{ match: () => true, reply: () => ({ body: [{ type: 'dir', name: 'a', path: 'a' }] }) }]);
    const resp = await handleApi(new Request('http://x/api/file?path=a'), env);
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /目录/);
  });
}

/* ---------------- 删除 ---------------- */

for (const [name, env] of [['Gitee', ENV_GITEE], ['GitHub', ENV_GITHUB]]) {
  test(`删除成功 → {deleted:true}：${name}`, async (t) => {
    stubFetch(t, [{ match: (c) => c.method === 'DELETE', reply: () => ({ body: { content: null } }) }]);
    const resp = await handleApi(del({ path: 'a.md', sha: 's1', message: '删掉' }), env);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { path: 'a.md', deleted: true });
  });
}

/* ---------------- 批量取正文这条接口已经没有了（#44 / ADR-0003） ---------------- */

test('批量取正文：路由不存在，回 404 而不是被静默处理', async (t) => {
  stubFetch(t, []); // 一个上游请求都不该发出去
  const resp = await handleApi(
    new Request('http://x/api/blobs', {
      method: 'POST',
      body: JSON.stringify({ files: [{ path: 'a.md', sha: 's1' }] }),
    }),
    ENV_GITEE
  );
  assert.equal(resp.status, 404);
});
