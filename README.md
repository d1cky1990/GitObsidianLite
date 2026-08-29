# Obsidian 移动端轻量同步 Web 应用

手机浏览器访问的轻量应用，通过 Gitee API 按需拉取 / 编辑笔记并提交，替代手机端 obsidian-git 的整库拉取。

## 目录

- `server/src/core.js` — 平台无关 API 核心（藏 token、解 CORS，代理 Gitee API v5），Workers 与 Deno 共用
- `server/src/index.js` — Cloudflare Workers 薄适配器（本地开发用）
- `deploy/main.ts` — Deno Deploy 入口（静态伺服 + API 代理，零外部依赖）
- `web/` — 前端（Vite + 原生 JS + markdown-it）
- `deno.json` — Deno Deploy 部署配置（org/app/entrypoint/上传白名单）

## 本地运行

前置：Node 22。

1. 配置后端凭据：复制 `server/.dev.vars.example` 为 `server/.dev.vars`，填入 Gitee 私人令牌、owner、仓库名。
2. 起后端：`cd server && npm install && npm run dev`（默认 `http://localhost:8787`）。
3. 起前端：`cd web && npm install && npm run dev`（默认 `http://localhost:5173`，`/api` 已代理到后端）。

浏览器打开 `http://localhost:5173` 即可。

## 部署上线（Deno Deploy）

- 架构：`server/src/core.js`（平台无关 API 核心）被 `server/src/index.js`（本地 wrangler）与 `deploy/main.ts`（Deno 入口，静态 + API 一体）共用。
- 配置：`deno.json` 的 `deploy` 块指定 org/app/entrypoint 与上传白名单；密钥放 `server/.dev.vars`（`.gitignore` 已排除，绝不上传）。
- 步骤：
  1. 装 Deno；`console.deno.com` 注册（新账号创建需梯子一次），生成访问令牌。
  2. 填 `server/.dev.vars`：`GITEE_TOKEN` / `GITEE_OWNER` / `GITEE_REPO`（+ 可选 `APP_PASSWORD`）。
  3. 把 `deno.json` 里的 `org` 改成你自己的组织，然后 `deno run -A jsr:@deno/deploy create --org <你的org> --app <app名> --source local --region global --do-not-use-detected-build-config --runtime-mode dynamic --entrypoint deploy/main.ts`（`--do-not-use-detected-build-config` 很关键，否则会误用 Vite 探测覆盖入口）。
  4. `deno run -A jsr:@deno/deploy env add GITEE_TOKEN <值> --org <org> --app <app>`（其余变量同理）。
  5. 重部署：`deno check deploy/main.ts` → `cd web && npm run build` → `deno run -A jsr:@deno/deploy --prod`（令牌经 `DENO_DEPLOY_TOKEN` 环境变量）。
- 访问保护：服务端 `APP_PASSWORD` 环境变量，前端输一次存 localStorage、请求头携带。

## 后端 API

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/head` | 默认分支 + 最新 commit sha |
| GET | `/api/tree?path=` | 列目录 / 文件 |
| GET | `/api/tree/recursive` | 整棵树（path→blob sha） |
| GET | `/api/file?path=` | 读文件（utf8） |
| PUT | `/api/file` | 写文件（body: path/message/content/sha） |
| GET | `/api/raw?path=` | 图片 / 附件 raw |
