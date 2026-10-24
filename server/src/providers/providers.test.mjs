// 适配层的测试：**两家的请求长什么样、失败怎么归一**。
//
// 为什么值得这么测：这张票最容易出的错不是「请求发不出去」，而是**把一家的脾气
// 套到另一家身上**——比如把 GitHub 的 `409` 漏判成普通失败（冲突合并界面永远不会出现，
// 用户以为改动丢了），或者把 `422` 一律当撞名。这些事都不联网也能测：把 fetch 换成桩，
// 断言的正是「发出去的 URL / 方法 / body」与「回来的状态码变成哪个词」。
//
// 不测：真平台的真实响应。那只有拿真令牌真仓库跑一遍才算（见票面判据 3 的「实际响应为证」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitee } from './gitee.js';
import { createGithub } from './github.js';
import { createProvider, KIND } from './index.js';
import { RepoError } from './base.js';

/** 一个能记下所有请求的 fetch 桩。`routes` 里没接住的请求直接炸——静默回默认值会掩盖路径拼错 */
function stubFetch(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: (init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const hit = routes.find((r) => r.match(call));
    if (!hit) throw new Error(`桩没接住这个请求：${call.method} ${call.url}`);
    const reply = hit.reply(call);
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'Content-Type': reply.contentType || 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const ENV = {
  REPO_PROVIDER: 'gitee',
  REPO_TOKEN: 'tok1',
  REPO_OWNER: 'owner1',
  REPO_REPO: 'notes1',
};

/* ---------------- Gitee ---------------- */

test('Gitee：鉴权走查询串，读 HEAD 先问默认分支再问它', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.url.includes('/repos/owner1/notes1?'), reply: () => ({ body: { default_branch: 'master' } }) },
    { match: (c) => c.url.includes('/branches/master'), reply: () => ({ body: { commit: { sha: 'sha-head' } } }) },
  ]);
  const head = await createGitee(ENV).head();
  assert.deepEqual(head, { branch: 'master', sha: 'sha-head' });
  assert.ok(calls.every((c) => c.url.includes('access_token=tok1')), '令牌必须跟着请求走（Gitee 的形态）');
  assert.equal(calls[0].headers.Authorization, undefined, '不要给 Gitee 塞 GitHub 那套头');
});

test('Gitee：带 sha 是改（PUT），不带是建（POST）', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.url.includes('/contents/a.md'), reply: () => ({ body: { content: { sha: 'new-sha' } } }) },
  ]);
  const repo = createGitee(ENV);
  await repo.writeFile('a.md', { message: 'm', content: 'x', sha: 'old-sha' });
  await repo.writeFile('a.md', { message: 'm', content: 'x' });

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.sha, 'old-sha');
  assert.equal(calls[1].method, 'POST', '不带 sha 的新建走另一个端点');
  assert.equal('sha' in calls[1].body, false);
});

test('Gitee：写冲突（400 + 措辞）归一成 conflict，撞名归一成 exists', async (t) => {
  stubFetch(t, [
    {
      match: (c) => c.body && c.body.sha === 'old-sha',
      reply: () => ({ status: 400, body: { message: 'Blob SHA does not match' } }),
    },
    {
      match: (c) => c.method === 'POST',
      reply: () => ({ status: 400, body: { message: '文件名已存在' } }),
    },
  ]);
  const repo = createGitee(ENV);
  await assert.rejects(
    () => repo.writeFile('a.md', { message: 'm', content: 'x', sha: 'old-sha' }),
    (e) => e instanceof RepoError && e.kind === KIND.CONFLICT
  );
  await assert.rejects(
    () => repo.writeFile('a.md', { message: 'm', content: 'x' }),
    (e) => e instanceof RepoError && e.kind === KIND.EXISTS
  );
});

test('Gitee：不存在的路径是 200 + []，读文件要当「没有」而不是抛错', async (t) => {
  stubFetch(t, [{ match: (c) => c.url.includes('/contents/'), reply: () => ({ body: [] }) }]);
  assert.equal(await createGitee(ENV).readFile('nope.md'), null);
});

test('Gitee：删除参数在 query，成功只看得到「删掉了」', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.method === 'DELETE', reply: () => ({ body: { content: null } }) },
  ]);
  await createGitee(ENV).deleteFile('a b.md', { sha: 's1', message: '删掉 a b' });
  assert.equal(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /sha=s1/);
  assert.match(calls[0].url, /message=%E5%88%A0%E6%8E%89%20a%20b/);
});

test('Gitee：blob 的 base64 带换行也能解出原文', async (t) => {
  const b64 = Buffer.from('中文内容', 'utf8').toString('base64');
  const broken = b64.slice(0, 4) + '\n' + b64.slice(4);
  stubFetch(t, [
    { match: (c) => c.url.includes('/git/blobs/'), reply: () => ({ body: { sha: 'b1', encoding: 'base64', content: broken } }) },
  ]);
  const r = await createGitee(ENV).blob('b1');
  assert.equal(r.content, '中文内容');
});

/* ---------------- GitHub ---------------- */

test('GitHub：鉴权走 Bearer 头，URL 里不许出现令牌', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.url.endsWith('/repos/owner1/notes1'), reply: () => ({ body: { default_branch: 'main' } }) },
    { match: (c) => c.url.includes('/branches/main'), reply: () => ({ body: { commit: { sha: 'gh-head' } } }) },
  ]);
  const head = await createGithub(ENV).head();
  assert.deepEqual(head, { branch: 'main', sha: 'gh-head' });
  assert.equal(calls[0].headers.Authorization, 'Bearer tok1');
  assert.equal(/tok1/.test(calls[0].url), false, '令牌不能进 URL——它会进日志与浏览器历史');
  assert.ok(calls[0].headers['User-Agent'], 'GitHub 缺 UA 直接 403');
});

test('GitHub：新建与更新同一个端点，按带不带 sha 选路', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.url.includes('/contents/a.md'), reply: () => ({ body: { content: { sha: 'new-sha' } } }) },
  ]);
  const repo = createGithub(ENV);
  await repo.writeFile('a.md', { message: 'm', content: 'x', sha: 'old-sha' });
  await repo.writeFile('a.md', { message: 'm', content: 'x' });

  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'PUT']);
  assert.equal(calls[0].body.sha, 'old-sha');
  assert.equal('sha' in calls[1].body, false);
});

test('GitHub：409 是冲突（不能漏判成普通失败），422 撞名才归一成 exists', async (t) => {
  stubFetch(t, [
    {
      match: (c) => c.body && c.body.sha === 'old-sha',
      reply: () => ({ status: 409, body: { message: 'sha does not match' } }),
    },
    {
      match: (c) => c.body && !c.body.sha,
      reply: () => ({
        status: 422,
        body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.', errors: [{ resource: 'Content', code: 'invalid' }] },
      }),
    },
  ]);
  const repo = createGithub(ENV);
  await assert.rejects(
    () => repo.writeFile('a.md', { message: 'm', content: 'x', sha: 'old-sha' }),
    (e) => e.kind === KIND.CONFLICT
  );
  await assert.rejects(
    () => repo.writeFile('a.md', { message: 'm', content: 'x' }),
    (e) => e.kind === KIND.EXISTS
  );
});

test('GitHub：422 但不是撞名（路径不合法）不能被说成「名字已经有了」', async (t) => {
  stubMockInvalidPath(t);
  await assert.rejects(
    () => createGithub(ENV).writeFile('bad//path', { message: 'm', content: 'x' }),
    (e) => e.kind === KIND.UPSTREAM && e.status === 422
  );
});

function stubMockInvalidPath(t) {
  stubFetch(t, [
    {
      match: (c) => c.url.includes('/contents/'),
      reply: () => ({ status: 422, body: { message: 'Invalid request.', errors: [{ resource: 'Content', code: 'invalid' }] } }),
    },
  ]);
}

test('GitHub：路径不存在读文件回 null；列目录回空数组（与 Gitee 的 200+[] 对齐）', async (t) => {
  stubFetch(t, [{ match: (c) => c.url.includes('/contents/'), reply: () => ({ status: 404, body: { message: 'Not Found' } }) }]);
  const repo = createGithub(ENV);
  assert.equal(await repo.readFile('nope.md'), null);
  assert.deepEqual(await repo.listDir('nope'), []);
});

test('GitHub：删除参数在 body（不在 query）', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.method === 'DELETE', reply: () => ({ body: { commit: { sha: 'c1' } } }) },
  ]);
  await createGithub(ENV).deleteFile('a.md', { sha: 's1', message: '删掉' });
  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(calls[0].body, { message: '删掉', sha: 's1' });
  assert.equal(calls[0].url.includes('?'), false, 'GitHub 的参数在 body');
});

test('GitHub：整棵树先拿 commit 的 tree sha，再按它拉递归树', async (t) => {
  const calls = stubFetch(t, [
    { match: (c) => c.url.includes('/git/commits/'), reply: () => ({ body: { tree: { sha: 'tree-1' } } }) },
    {
      match: (c) => c.url.includes('/git/trees/'),
      reply: () => ({ body: { tree: [{ path: 'a.md', type: 'blob', sha: 's1' }] } }),
    },
  ]);
  const tree = await createGithub(ENV).tree('commit-1');
  assert.equal(tree.length, 1);
  assert.match(calls[1].url, /\/git\/trees\/tree-1\?recursive=1/);
});

test('GitHub：附件走 raw 那个 Accept，并把笼统的 Content-Type 按后缀补回来', async (t) => {
  // 实测（2026-10-24）：GitHub 连 PNG 都回 `application/vnd.github.raw`，
  // 原样交给浏览器，图片就打不开——而报错里一个字都不会提到 Content-Type
  stubFetch(t, [
    {
      match: (c) => c.url.includes('/contents/img/a.png'),
      reply: () => ({ status: 200, body: 'PNGDATA', contentType: 'application/vnd.github.raw; charset=utf-8' }),
    },
  ]);
  const r = await createGithub(ENV).raw('img/a.png');
  assert.equal(r.contentType, 'image/png');
  assert.equal(await new Response(r.body).text(), 'PNGDATA');
});

test('GitHub：上游已经给了具体类型时不乱改（只补笼统的那一种）', async (t) => {
  stubFetch(t, [
    { match: (c) => c.url.includes('/contents/a.pdf'), reply: () => ({ status: 200, body: 'PDF', contentType: 'application/pdf' }) },
  ]);
  assert.equal((await createGithub(ENV).raw('a.pdf')).contentType, 'application/pdf');
});

/* ---------------- 选择哪一家 ---------------- */

test('createProvider：按 REPO_PROVIDER 挑，两家的动作齐全', () => {
  const actions = ['head', 'listDir', 'tree', 'readFile', 'writeFile', 'deleteFile', 'blob', 'raw'];
  for (const name of ['gitee', 'github']) {
    const repo = createProvider({ ...ENV, REPO_PROVIDER: name });
    assert.equal(repo.name, name);
    for (const a of actions) assert.equal(typeof repo[a], 'function', `${name} 缺动作 ${a}`);
  }
});
