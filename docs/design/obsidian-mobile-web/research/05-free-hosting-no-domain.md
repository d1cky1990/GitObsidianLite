# 调研：免费托管方案·无自有域名版（票 05）

> 前置：票 01 的首选 EdgeOne Pages 依赖「绑备案自定义域名」。本票假设**不买域名、只用平台默认域名**，与票 01 冲突处以本票为准。检索日期 2026-08-29，均核对官方一手来源。
>
> ⚠️ **结果标注**（2026-09-13 补）：本票的两个首选里，**实际采用的是 B —— Deno Deploy**，已上线并实测大陆直连。选 B 而非 A（CloudBase）的理由：迁移量最小（Deno 原生支持 `fetch`/`Response`/`Request`，入口改 `Deno.serve()` 即可，无需套一层 Node http server），且没有 A 那两条保留条件（免费环境每 6 个月手动续期、默认域名官方定位「仅开发测试」）。

## 结论（分层）

**A（免费 + 大陆直连）首选：腾讯云 CloudBase 免费体验环境**

- 每账号 1 个免费环境，3000 资源点/月（1000 点 ≈ ¥1），静态托管 + 云函数 + HTTP 网关共享额度；静态托管容量另享 1GB 免费。本项目用量估算 < 300 点/月（调用 0.0133 元/万次、计算 0.00011 元/GBs、流量 0.21-0.8 元/GB），余量约 10 倍。
- 前端走静态托管默认域名 `{envId}-{appid}.tcloudbaseapp.com`，API 走 HTTP 网关 `{envId}.app.tcloudbase.com`，腾讯云国内 CDN，大陆免梯子直连。
- 云函数「HTTP 函数」= 标准 web server 监听 9000 端口 + scf_bootstrap；现有 180 行逻辑套一层 Node http server 适配即可，token 放函数环境变量。迁移量：小-中。
- 保留：默认域名官方定位「仅开发测试」（限频、浏览器直访可能出现安全提示中间页）；环境每 6 个月手动续期；免费环境不能绑自定义域名/备案；需腾讯云个人实名（无需充值）。

**B（免费 + 大陆可用但有保留）首选：Deno Deploy**

- Free 层永久免费：1M 请求/月、20GiB egress、10h CPU、1GiB KV，无需绑卡。
- deno.dev 默认域名大陆基本可直连：2024-2025 年多个社区项目（groq-proxy、deno-api-proxy）专门用它做「国内免梯子 API 反代」，旁证积极；2026 年当前状态需实测。
- 迁移量：最小。Deno 原生支持 fetch/Response/Request/btoa/atob + ES module，仅改入口为 `Deno.serve()`；前端静态文件同平台托管，单部署同时服务 SPA + API。
- 保留：海外节点访问 gitee.com 延迟 200ms+；Deploy Classic 已于 2026-07-20 停服，须用新平台；大陆连通性无官方保证。

**C（免费 + 大陆被墙 fallback）首选：Cloudflare Workers + Pages**

- Workers Free 10 万请求/天，Pages 静态托管不限带宽，永久免费。
- workers.dev / pages.dev 在大陆遭 DNS 污染/阻断（2022 年起持续至今，2026-08 社区实测仍如此），必须梯子。
- 迁移量：最小。Workers 即 Request/Response 风格 V8 isolate，180 行几乎原样可跑；token 放环境变量。海外节点访问 gitee.com 慢。
- 同层替代：Vercel Hobby（100GB 流量 + 1M 函数调用/月，禁商用）、Netlify Free（300 credits/月 ≈ 15GB 带宽，2025-09 起信用制且 2026-04 变相缩水一倍），默认域名同样被墙。

## 关键发现

1. **EdgeOne Pages 默认域名在大陆一律不可用作稳定入口**（官方域名管理文档）：加速区域含大陆 → 项目/部署域名仅是 3 小时有效预览链接（超时 401）；加速区域不含大陆 → 大陆访问直接 401。无备案域名则出局——**推翻票 01 的首选结论**。
2. 国内大厂 serverless 的「每月免费额度」大多已消失：仅华为云 FunctionGraph 保留（100 万次 + 40 万 GB-s/月，长期）；阿里云 FC 3.0 试用仅 3 个月（15 万 CU/月）；腾讯云 SCF 第 4 个月起自动扣基础套餐 ¥9.9/月；百度 CFC 2023 年起仅新客 3 个月。
3. 社区流传的「Zeabur 每月 $5 免费额度」已过时：2026-08 官方定价页 Free 计划只剩控制台 + 管理自有服务器，无云端计算额度。Koyeb、Northflank、Fly.io 免费层亦已消失（官方定价页确认）。
4. CloudBase 免费环境是当前唯一「免费 + 默认域名大陆直连 + 静态/API 一体」的国产组合，但其默认域名被官方明确「仅限开发测试」且 2025-10 起引入域名有效期验证（可一键续期），能否当日常入口需实测。
5. 国产函数计算默认域名普遍有「网页渲染管控」风险：阿里云官方文档明确主域名返回在浏览器按附件下载、fcapp.run「仅测试开发用」；华为云 HTTP 触发依赖 APIG（是否免费未核实）。

## 候选对比表

| 平台 | 免费层（官方数字） | 默认域名 | 大陆直连 | 运行时（Web API 兼容） | 迁移量 | 主要风险 |
|---|---|---|---|---|---|---|
| 腾讯 CloudBase 免费环境 | 3000 资源点/月；静态托管 1GB 免费 | *.tcloudbaseapp.com / *.app.tcloudbase.com | 可（官方：仅测试用途） | Node 16/18，HTTP 函数需自建 9000 端口 server | 小-中 | 默认域名限频/中间页（需实测）；环境 6 个月手动续 |
| 华为云 FunctionGraph | 100 万次 + 40 万 GB-s/月（长期） | APIG 分配子域名 | 可（APIG 费用未核实） | Node.js，event 风格 handler，非 Web API | 中 | HTTP 触发依赖 APIG，收费与否未核实；需实名 |
| 阿里云 FC 3.0 | 试用 15 万 CU/月 ×3 个月；之后按量（本项目约 ¥0.01-0.1/月） | *.fcapp.run | 可（HTML 有强制下载风险，需实测） | Node.js 事件/Web 函数 | 中 | 无永久免费层；需账户余额 |
| Deno Deploy | 1M 请求/月、20GiB egress、10h CPU | *.deno.dev | 基本可（2024-25 旁证，需实测） | Deno，原生 Web API | 小 | 大陆连通无保证；Classic 停服迁移 |
| Cloudflare Workers/Pages | Workers 10 万请求/天；Pages 静态不限带宽 | *.workers.dev / *.pages.dev | 否（DNS 污染，2026-08 实测） | V8 isolate，原生 Web API | 小 | 被墙；海外节点访问 gitee 慢 |
| Render | Web 服务 750h/月、512MB、100GB 带宽 | *.onrender.com | 可但慢（TTFB 400ms+，2025-11 实测） | Node.js 容器 | 小-中 | 15 分钟休眠，冷启动 30-60s |
| Vercel Hobby | 100GB 流量、1M 函数调用/月 | *.vercel.app | 否（DNS 污染） | Node/Edge | 小 | 禁商用；被墙 |
| Netlify Free | 300 credits/月 ≈ 15GB 带宽 | *.netlify.app | 否 | Node/Edge | 小 | 信用制持续缩水；被墙 |
| EdgeOne Pages | 3M 边缘函数请求/月、不限加速流量、1GB KV | 项目域名（*.edgeone.app 系） | **否**（401 政策） | 边缘 JS，原生 Web API | 小 | 默认域名大陆 401；含大陆区仅 3h 预览链接 |

## 淘汰清单

- Gitee Pages：2024-05 已停止服务（官方 issue 确认「不可抗原因下线」），且纯静态藏不了 token。
- 腾讯云 SCF：第 4 个月起无免费额度，系统自动扣基础套餐 ¥9.9/月。
- 百度智能云 CFC：2023-03 起取消每月免费额度，新客 0 元包仅 3 个月。
- 火山引擎 veFaaS：仅新客一次性试用资源包，无每月免费额度（其「边缘函数」免费试用版 5 万次调用/天或可一战，但默认域名与大陆访问性未核实，且付费需企业认证）。
- Zeabur：Free 计划已无云端计算额度，仅能管理自有服务器；zeabur.app 直连性已无意义。
- Koyeb：免费层只剩 Postgres 5h/月，无免费计算；Northflank：无免费层（最低 $2.70/月）；Fly.io：2024-10 起新账户无免费层且需绑卡。
- Serv00：免费 FreeBSD 主机（3GB/512MB）可跑 Node，但需 90 天登录保活、波兰机房大陆延迟高、非 serverless。
- Oracle Cloud Free Tier：Always Free 真实存在（4 ARM OCPU/24GB/10TB 出流量），但需信用卡验证、无平台默认域名（仅裸 IP）、注册砍号率高。

## 需实测清单

1. CloudBase 免费环境默认域名：手机浏览器直开 SPA 是否/何时弹安全提示中间页；API 网关限频阈值。
2. Deno Deploy：*.deno.dev 在 2026 年大陆移动网络（含晚高峰）直连可用性。
3. 阿里云 FC：*.fcapp.run 返回 HTML 是否被强制下载（官方仅明确旧主域名 aliyuncs.com 会）。
4. 华为云 FunctionGraph：HTTP 触发走 APIG 共享版是否免费（官方最佳实践均配按需付费的专享网关）。
5. CloudBase 免费环境资源点实际消耗速率（理论 <300 点/月，上线后观察一两周）。

## 来源

- EdgeOne Pages 域名 401 政策：https://pages.edgeone.ai/zh/document/domain-overview
- EdgeOne Pages 免费额度：https://test-pages.edgeone.ai/zh/pricing 、https://pages.edgeone.ai/document/limits-and-quotas
- EdgeOne 国内站同样政策（社区实测）：https://www.zyglq.cn/posts/qcloud-eo-pages-cn.html
- CloudBase 免费体验环境（3000 点/月、续期规则）：https://cloud.tencent.com/document/product/1301/122385 、https://www.cloudbase.net/pricing
- CloudBase 资源点计价：https://cloud.tencent.com/document/buy-guide/876/127357
- CloudBase 默认域名限制与 2025-10 有效期策略：https://cloud.tencent.com/document/product/876/130728 、https://cloud.tencent.com/announce/detail/2150
- CloudBase HTTP 函数（9000 端口 web server）：https://docs.cloudbase.net/cli-v1/functions/deploy.html 、https://docs.cloudbase.net/service/access-cloud-function
- 阿里云 FC 3.0 试用额度（3 个月）：https://www.alibabacloud.com/help/zh/functioncompute/fc/product-overview/trial-quota-1
- FC 计费变更（2024-08-27 起试用 15 万 CU ×3 月）：https://help.aliyun.com/en/functioncompute/product-changes-changes-of-billable-items-resource-plans-and-trial-quota-of-function-compute
- FC fcapp.run 域名与主域名强制下载：https://developer.aliyun.com/ask/580235 、https://blog.csdn.net/alisystemsoftware/article/details/124598939
- 华为云 FunctionGraph 免费额度（更新 2025-09-25）：https://support.huaweicloud.com/intl/zh-cn/price-functiongraph/functiongraph_00_0012.html
- 华为云 HTTP 函数 + APIG 专享网关按需计费：https://support.huaweicloud.com/intl/en-us/bestpractice-functiongraph/functiongraph_05_1216.html
- Deno Deploy 定价：https://deno.com/deploy/pricing
- deno.dev 大陆直连旁证（2025-01/02 项目）：https://github.com/tech-flyflypig/deno-api-proxy
- Cloudflare 免费层与 workers.dev/pages.dev 被墙（2026-08 实测）：https://cloud.tencent.com/developer/article/2724477 、https://draftz.felixnie.com/Digital-Garden/Accessing-from-Mainland-China
- Zeabur 定价（Free 无计算额度）：https://zeabur.com/pricing 、https://zeabur.com/docs/en-US/pricing/free-plan
- Koyeb 定价（无免费计算）：https://www.koyeb.com/pricing ；Northflank 定价：https://northflank.com/pricing
- Fly.io 免费层取消（2024-10）：https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/
- Render 免费层与大陆延迟实测（2025-11）：https://blog.hotdry.top/posts/2025/11/14/render-vs-aliyun-esa-deployment-comparison
- 腾讯云 SCF 计费（第 4 月起基础套餐扣费）：https://cloud.tencent.com/document/product/583/17299
- 百度 CFC 取消免费额度：https://cloud.baidu.com/news/news_b4515189-a5eb-49cb-93e2-530f2e100e9b
- 火山引擎 veFaaS 商用公告、边缘函数免费试用：https://www.volcengine.cn/docs/6662/161420 、https://volcengine.com/docs/6649/174165
- Gitee Pages 下线：https://gitee.com/oschina/git-osc/issues/IB8V7L
- Serv00：https://www.serv00.com/ ；Oracle Always Free：https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm
