// Workers 入口的分工测试（#40）：**`/api/*` 进 worker，其余交给静态资源**。
//
// 这一层没有别的可测——真正的「谁先谁后」是平台的（静态资源命中就直接回，
// worker 根本不跑），只能靠 `wrangler dev` 实跑一遍。这里锁住的是我们自己那一半：
// 入口别把 `/api` 漏给静态资源，也别把首页当成 API。漏了的后果很难看——
// 接口会变成一张 404 页面，而错误信息里一个字都不会提到路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from './index.js';

// 假的静态资源绑定：只认得 `/` 和 `/assets/app.js`，其余 404——与 wrangler.toml 里
// `not_found_handling = "none"` 的行为一致（没有对应文件就如实 404，不给兜底页）。
function fakeAssets() {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      seen.push(pathname);
      if (pathname === '/') {
        return new Response('<!doctype html><title>index</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (pathname === '/assets/app.js') {
        return new Response('console.log(1)', {
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
      return new Response(null, { status: 404 });
    },
  };
}

// 缺凭据的 env：API 走到 requireEnv 就停，不会真的打上游——测路由不必联网。
// 有假凭据的 env 用来测「路径本身存在、但谁都没匹配上」的那种 404（`/api`）。
const ENV_FAKE_CREDS = { GITEE_TOKEN: 't', GITEE_OWNER: 'o', GITEE_REPO: 'r' };

test('/api/* 进 worker，不碰静态资源', async () => {
  const assets = fakeAssets();
  const resp = await worker.fetch(new Request('http://x/api/head'), { ASSETS: assets });
  assert.equal(resp.status, 500);                       // 缺凭据 → core 的「未配置」错误
  const body = await resp.json();
  assert.match(body.error, /未配置 GITEE_TOKEN/);
  assert.deepEqual(assets.seen, []);                    // 一次都没问过静态资源
});

test('/api 自身也进 worker（不然它会被静态资源回一句空 404）', async () => {
  const assets = fakeAssets();
  const resp = await worker.fetch(new Request('http://x/api'), {
    ...ENV_FAKE_CREDS,
    ASSETS: assets,
  });
  assert.equal(resp.status, 404);
  assert.deepEqual(await resp.json(), { error: 'not found' });   // JSON，不是空 body
  assert.deepEqual(assets.seen, []);
});

test('CORS 预检由 core 接住（OPTIONS 不该落到静态资源）', async () => {
  const assets = fakeAssets();
  const resp = await worker.fetch(
    new Request('http://x/api/file', { method: 'OPTIONS' }),
    { ...ENV_FAKE_CREDS, ASSETS: assets }
  );
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(assets.seen, []);
});

test('首页交给静态资源（hash 路由，只需要 index.html）', async () => {
  const assets = fakeAssets();
  const resp = await worker.fetch(new Request('http://x/'), { ASSETS: assets });
  assert.equal(resp.status, 200);
  assert.match(await resp.text(), /<title>index<\/title>/);
  assert.deepEqual(assets.seen, ['/']);
});

test('静态产物照常伺服', async () => {
  const assets = fakeAssets();
  const resp = await worker.fetch(new Request('http://x/assets/app.js'), { ASSETS: assets });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Content-Type'), 'application/javascript');
});

test('不存在的路径如实 404，不给兜底页', async () => {
  const assets = fakeAssets();
  const resp = await worker.fetch(new Request('http://x/nope'), { ASSETS: assets });
  assert.equal(resp.status, 404);
  assert.equal(await resp.text(), '');
});

test('没配静态资源绑定时不炸（旧配置下宁可明确 404）', async () => {
  const resp = await worker.fetch(new Request('http://x/'), {});
  assert.equal(resp.status, 404);
  assert.equal(await resp.text(), 'Not Found');
});

// 这条守的是「分界」的另一半，而且**必须看真产物**：静态资源是靠路径匹配抢先的，
// 一旦 `web/dist` 里出现 `api`（例如有人往 `web/public/` 放了张叫 api 的图，Vite 会
// 原样复制进 dist），整个 `/api/*` 就会变成静态 404——接口全灭，而报错里一个字都不会
// 提到路由。假绑定测不出这件事，只有读一遍真目录才行。
test('构建产物里没有 api 这个路径（有的话接口会被静态资源抢先）', (t) => {
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (!existsSync(dist)) return t.skip('还没有 web/dist（先 cd web && npm run build）');
  // auto-trailing-slash 下 `/api` 会找 `api`、`api.html`、`api/index.html` 三种
  const hits = readdirSync(dist).filter((n) => /^api(\.html)?$/i.test(n));
  assert.deepEqual(hits, [], `web/dist 里出现了 ${hits.join('、')}，会把 /api/* 挡在门外`);
});
