Status: resolved
Type: grilling

## Question

MVP 阶段是"单用户自用"还是"直接支持多用户（开源给他人用）"？这决定鉴权架构。

- 单用户自用：token 作为服务端环境变量/部署配置，最简单。
- 多用户：需要 Gitee OAuth 流程，每个用户登录自己的 gitee 账号，后端按用户隔离 token 与缓存。

约束：用户已表达"未来想开源 + 做 app 发布"，故需决定 MVP 边界，以及如何预留可迁移性（避免返工）。

## Answer

MVP 采用单用户 self-hosted：token 作为服务端部署配置（环境变量 / KV），无登录界面。鉴权层抽象为可插拔模块，v2 再加 Gitee OAuth（用于公共实例 / app 发布）。「开源」按 self-hosted 理解（他人 clone 后填自己的 token 部署）；app 发布为未来愿景，仅留记录、不在本 effort 范围。
