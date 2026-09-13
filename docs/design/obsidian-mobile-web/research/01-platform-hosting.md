# 调研：免费托管平台选型（票 01）

> ⚠️ **历史快照**（2026-08-29）。结论**已被取代**：EdgeOne Pages 因「绑域名需 ICP 备案」在本项目走不通（无自有域名），最终采用 **Deno Deploy**，见 `../spec.md` §9。原貌保留，用于记录当时的评估依据。

## 结论

**首选：腾讯 EdgeOne Pages（含 EdgeOne Functions）**

唯一能同时满足「大陆免梯子直连 + 服务端高速访问 gitee.com」的一体化方案。前端静态资源与 Edge Functions 后端同平台托管，免费版永久免费（每月 300 万次 Edge Functions 请求、不限安全加速流量/请求数、1GB KV 存令牌）。选「中国大陆可用区」后，服务端直连 gitee.com（大陆节点）延迟最低、最稳。

**硬约束：绑自定义域名需 ICP 备案** —— 大陆直连这条路绕不开备案。

## 备选

- 备选 1（不想备案）：Cloudflare Workers + Pages。免备案免实名，免费额度（10 万请求/天）够用；但 workers.dev/pages.dev 默认域名在大陆被墙/DNS 污染，必须自备域名；Worker 位于海外节点，访问 gitee.com 慢且不稳定；前端大陆直连不稳定。
- 备选 2（挂梯子）：Vercel/Netlify。默认域名大陆被 DNS 污染，需梯子 + 自定义域名；海外服务端访问 gitee 同样慢。

## 关键限制

- Gitee Pages 已下线（2025 官方确认），不能用于前端托管。
- 大陆节点直连（EdgeOne 大陆区 / SCF 绑域名）必须 ICP 备案；EdgeOne「全球区(不含大陆)」免备案但大陆直连返回 401。
- EdgeOne 国际版仅邮箱+GitHub 注册；国内版/SCF 需腾讯云账号实名。
- SCF 前 3 个月 100 万次/月，之后仍有长期免费额度，但配置比 EdgeOne 繁琐。

## 来源

- EdgeOne Pages 免费版定价：https://test-pages.edgeone.ai/zh/pricing
- EdgeOne Pages 备案规则：https://edgeone.ai/zh/document/160427672892563456
- Cloudflare 免费额度/workers.dev 被墙：https://jimmysong.io/zh/book/hugo-handbook/development-tools/cloudflare-free-tier/
- Gitee Pages 下线：https://gitee.com/oschina/git-osc/issues/ICDQSN
- Vercel 大陆访问现状：https://pbihub.cn/docs/vibe-vibe-basic/637
