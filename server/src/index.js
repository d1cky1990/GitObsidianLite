// Cloudflare Workers 入口（本地开发：wrangler dev，读取 .dev.vars）
// 业务逻辑全部在 core.js，与 Deno Deploy 入口（deploy/main.ts）共用。
import { handleApi } from './core.js';

export default {
  async fetch(request, env) {
    return handleApi(request, env);
  },
};
