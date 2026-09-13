# Map: Obsidian 移动端轻量同步 Web 应用

> ⚠️ **历史快照**：本地图连同 `issues/`、`research/`、`prototypes/` 是 2026-08-29 那一轮 wayfinder 的产物，**保留原貌**。其中**票 01 的平台选型已被取代**（最终为 Deno Deploy）。当前有效的方案以 [`spec.md`](spec.md) 为准。

## Destination

产出一份可落地的技术方案/规格，作为构建的输入：技术栈选型、整体架构、Gitee API 使用边界、数据/缓存模型、页面与交互流程、鉴权方案、部署步骤。方案须覆盖三项前瞻约束——大陆优先可达、面向开源/多用户、未来可打包为 app。

## Notes

- Domain：Obsidian vault 的移动端同步。用 Gitee API 按需拉取/回写单个文件，替代手机端 obsidian-git 的整库拉取（整库拉取在手机 git 上会卡死）。
- 既定偏好（grilling 已拍板）：
  - 编辑器：原生 textarea + 实时预览切换（轻量、移动端稳）。
  - MVP Obsidian 范围：双链 [[...]]、YAML frontmatter、基础 GFM、图片渲染。
  - 仓库范围：单仓库（可配置）+ 图片内联渲染。
  - 访问：大陆直连优先；挂梯子可接受，但须评估"平台(服务端)→gitee.com"连通性。
  - 鉴权：尽量安全（token 放服务端，不进浏览器）。
  - 改动节奏：手机改动低频、PC 改动高频。
  - 冲突原则：冲突时不放弃任何一边（读写模式切换 + 提交时保底冲突处理）。
- 本 effort 需咨询的 skills：grilling、domain-modeling、research（调研票用）、prototype（原型票用）。

## Decisions so far

- [01-platform-hosting](issues/01-platform-hosting.md) — 部署平台首选腾讯 EdgeOne Pages（大陆直连 + 服务端访问 gitee 快），绑域名需 ICP 备案；不备案走 Cloudflare，挂梯子走 Vercel/Netlify。
- [02-single-vs-multi-user-auth](issues/02-single-vs-multi-user-auth.md) — MVP 单用户 self-hosted，token 作服务端配置；鉴权层可插拔，OAuth/多租户留 v2；app 发布为未来愿景。
- [03-remote-change-detection](issues/03-remote-change-detection.md) — 远端改动用 branches HEAD sha + git/trees recursive diff 二阶段检测；Gitee 无 CORS 头，必须后端代理。
- [04-conflict-ux](issues/04-conflict-ux.md) — 冲突整体左右两栏 + 字符级高亮 + 气泡裁决；切编辑自动拉最新（toast）；另存副本二选一兜底。

## Not yet specified

（四张票已全部解决，路已清楚。以下 fog 已由票 01/03 结论覆盖，转入技术方案 spec.md 直接落实，不再单独开决策票：页面/交互流程、双链解析、图片 raw 经后端代理、文件树懒加载粒度。）

## Out of scope

- v2 Obsidian 能力：反向链接面板、标签图、嵌入 ![[...]]、callout、任务勾选。
- 多仓库切换、分支选择。
- app 打包发布（PWA/原生）—— 未来愿景，本 map 仅留记录 + 预留架构可迁移性，落地属后续 effort。
- 桌面端同步改造（桌面仍沿用 obsidian-git）。
