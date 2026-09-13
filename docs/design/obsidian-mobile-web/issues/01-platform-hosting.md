Status: resolved
Type: research

> ⚠️ **历史快照**（2026-08-29 提出并解决）。本票的平台结论**已被取代**——最终采用 **Deno Deploy**，见 `../spec.md` §9。原貌保留，用于记录当时的判断依据。

## Question

哪个免费托管平台，既能在大陆免梯子直连，又能承载一个轻量 serverless 后端来代理 Gitee API？

候选与要点：

- Cloudflare Workers / Pages：自定义域名在大陆的可达性如何？workers.dev / pages.dev 默认域名是否被墙？
- 腾讯云函数 SCF / EdgeOne Pages：免费额度、是否需要域名备案、能否跑 serverless 代理？
- Gitee Pages：纯静态托管能力（无后端），能否作为纯前端托管（后端另寻他处）？
- Vercel / Netlify：.vercel.app / netlify.app 默认域名大陆可达性现状（作为"挂梯子"备选）。

同时确认：上述平台的服务端（serverless 函数）访问 gitee.com API 的连通性是否顺畅。

## Answer

首选腾讯 EdgeOne Pages（含 EdgeOne Functions）—— 大陆免梯子直连 + 服务端高速访问 gitee.com 的一体化方案，免费版额度充足。硬约束：绑自定义域名需 ICP 备案。备选：不备案走 Cloudflare Workers（自备域名、海外节点访问 gitee 慢）；挂梯子走 Vercel/Netlify。Gitee Pages 已下线。

详见 research/01-platform-hosting.md
