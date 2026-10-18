// Cloudflare Workers 入口：**一个端口同时伺服前端与 API**（#40）。
// 业务逻辑全部在 core.js，与 Deno Deploy 入口（deploy/main.ts）共用。
//
// 这里只负责分工：`/api` 与 `/api/*` 进 core，其余交给静态资源绑定 `env.ASSETS`
// （`web/dist`）。**请求谁先谁后、以及为什么必须守着「dist 里不能有 api 路径」，
// 写在 `wrangler.toml` 的 [assets] 注释里**——同一件事只留一处，这里不抄第二遍。
import { handleApi } from './core.js';

function isApi(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (isApi(pathname)) return handleApi(request, env);
    // 没命中静态资源的请求也会落到这里。绑不上资源时宁可明确 404，也不要假装有个页面
    if (!env.ASSETS) return new Response('Not Found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
