# 技术方案：Obsidian 移动端轻量同步 Web 应用

> 由 wayfinder 决策地图产出（同目录 `map.md`）。四张决策票已全部解决，本文档是构建的直接输入。
>
> **时效**：2026-08-29 定稿，2026-09-13 校正。校正内容——部署平台由 EdgeOne Pages 改为 Deno Deploy（MVP 已上线）、补齐实现期新增的访问密码鉴权、字符级 diff 由「计划引入 diff-match-patch」改为「已自实现」；§8 的双链措辞按实现校正、§10 的待办清单改为指向 tracker。同目录的 `issues/` 与 `research/` 是**历史快照**，保留原貌不动，其中平台选型的结论已被本文件取代。

## 1. 目标与边界

**目标**：一个手机浏览器访问的轻量 Web 应用，通过 Gitee API 按需拉取 / 编辑单个笔记并提交，替代手机端 obsidian-git 的整库拉取（整库拉取在手机 git 上会卡死）。

**场景**：手机低频查看 / 编辑少数文件；PC 高频改动仓库。手机改动低频、PC 改动高频。

**范围**：
- 单仓库、单用户（self-hosted）。
- 编辑能力：textarea + 实时预览。
- Obsidian 支持：双链 `[[...]]`、YAML frontmatter、基础 GFM、图片内联渲染。

**非目标**（v2 / 后续）：反向链接面板、标签图、嵌入 `![[...]]`、callout、任务勾选、多仓库切换、分支选择、app 打包发布（PWA/原生）。

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vite + 原生 JS（无框架） | 页面简单（列表 + 编辑器），框架是多余重量；Vite 负责构建与未来打包 PWA |
| Markdown 渲染 | markdown-it（+ tables 插件） | 轻量、GFM、易扩展 wikilink 插件 |
| 字符级 diff | 自实现字符级 LCS（`web/src/main.js`） | 只需「高亮 + 逐个采纳」这一档粒度，引入 diff-match-patch 是多一个依赖；实测够用 |
| 后端 | 平台无关核心 + 薄适配器 | `server/src/core.js` 是唯一实现（藏 token、解 CORS、UTF-8 编解码）；`server/src/index.js`（Cloudflare Workers，本地开发）与 `deploy/main.ts`（Deno Deploy，生产）各自只做 10~60 行适配 |
| 后端运行时 | Deno Deploy | 见 §9；大陆免梯子直连实测通过 |
| 后端存储 | **无** | 不存任何状态；机密全走环境变量（见 §7），不引入 KV |
| 前端缓存 | localStorage（文件树 + 最近文件） | 按需缓存；IndexedDB 未采用，v1 不需要 |

## 3. 整体架构

```
手机浏览器（SPA）
      │ HTTPS（+ X-Auth 头，见 §7）
      ▼
server/src/core.js —— 平台无关 API 核心（唯一实现）
      ▲ 共用
      ├── deploy/main.ts          Deno Deploy 生产入口（静态 + API 同源，零外部依赖）
      └── server/src/index.js     Cloudflare Workers，仅本地开发
      │ 代理 + 藏 token + 解 CORS + UTF-8 编解码
      ▼
Gitee OpenAPI v5（gitee.com/api/v5）
```

- 前端**只与自己的后端通信，不直连 Gitee**——Gitee 响应不返回 CORS 头，且 token 绝不能进浏览器。
- 后端持有 `GITEE_TOKEN` / `GITEE_OWNER` / `GITEE_REPO`（全部环境变量，见 §7），对前端暴露最小化 API。
- owner / repo 固定在后端配置，前端请求不携带，避免越权。
- **静态资源与 API 同源**（同一进程伺服），因此不存在跨域请求与跨站 cookie 问题。

## 4. 后端 API（对前端暴露）

> 设计意图如下；**权威描述是 `server/src/core.js`**——约 230 行，路由全部集中在一处，改动以它为准。

| 方法 | 路径 | 功能 | 对应的 Gitee API |
|---|---|---|---|
| GET | `/api/head` | 仓库默认分支 HEAD sha | `GET /repos/{o}/{r}/branches/{default}` |
| GET | `/api/tree?path=` | 列某目录下内容（懒加载） | `GET /repos/{o}/{r}/contents/{path}` |
| GET | `/api/tree/recursive` | 整棵树（path→blob sha） | `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` |
| GET | `/api/file?path=` | 读文件（base64→utf8） | `GET /repos/{o}/{r}/contents/{path}` |
| PUT | `/api/file` | 更新文件（message+sha+content） | `PUT /repos/{o}/{r}/contents/{path}` |
| GET | `/api/raw?path=` | 图片 / 附件 raw（代理转发） | `GET /repos/{o}/{r}/raw/{path}` |

- 更新文件请求体：`{ path, message, content, sha }`；后端校验后转 base64 调 Gitee。
- 冲突信号：Gitee `PUT contents` 在 sha 不匹配时返回错误 → 后端转成明确的「409 冲突」给前端，并附上最新 sha 与远端内容。

## 5. 数据 / 缓存模型

- **文件树缓存**：localStorage 存 `path → blob sha` 映射 + 目录结构；按目录懒加载，手机不打开的目录不拉取。
- **打开 app 检测改动**：`GET /api/head` 拿 HEAD sha → 与上次缓存对比 → 变了则 `GET /api/tree/recursive` 拿整棵树 → 与本地 path→sha 映射 diff → 只拉变化文件。
- **切编辑 double check**：对当前文件 `GET /api/file` 拿最新 sha 与本地缓存对比；变了 → 自动拉最新 + toast「远端已更新，已自动加载最新内容」。
- **写回**：编辑提交 `PUT /api/file`（带 sha）；成功后更新本地缓存 sha。

## 6. 页面与交互流程

三个页面：文件列表页、编辑器页、设置页。

### 编辑器页（票 04 定稿）

- 阅读模式为默认态；点「编辑」切编辑。
- 切编辑时 double check 远端改动，有变化自动拉最新（toast）。
- 提交 → `PUT /api/file`（带 sha）。
- 提交冲突（后端 409）→ 进入冲突合并界面：
  - **整体左右两栏**：左 = 本地完整文本（本地改动橙色高亮）、右 = 远端完整文本（远端改动蓝色高亮）。
  - 字符级 diff 精确高亮差异；点击高亮 → 气泡「采纳 / 不采纳」（可取消重选）。
  - 合并结果 = 公共部分 + 采纳的改动（按 diff 顺序）。
  - 底部「预览改动处理」浮窗（从下向上覆盖 2/3）；有未处理差异时「提交合并」禁用 + 提示「处理完所有 diff 才能提交合并」。
  - 「另存副本」二选一：保留本地版本、远端存为副本 / 保留远端版本、本地存为副本。

## 7. 鉴权

两层，职责不同。

**① Gitee 令牌（机器身份）**：`GITEE_TOKEN` / `GITEE_OWNER` / `GITEE_REPO` 全部为后端环境变量，**永不进浏览器**；owner 与 repo 固定在后端，前端请求不携带（见 §3）。

**② 访问密码（人的身份；可选，实现期新增）**——设了 `APP_PASSWORD` 才启用：

- 前端输一次密码 → 存 localStorage → 之后每个请求带 `X-Auth` 头做明文比对。
- 首次经 header 通过后，后端种一个 `auth` cookie（值为密码的 SHA-256）。**这个 cookie 存在的唯一理由是 `<img src=/api/raw?path=...>` 这类请求带不了自定义头**——没有它，笔记里的图片在鉴权开启后会全部裂图。
- **不设该变量则完全不鉴权**，靠「地址不公开 + 免费层无人枚举」兜底。这是 self-hosted 单用户的自觉取舍，代价要说清楚：**地址一旦泄漏即等同无保护**。

**v2 预留**：鉴权层抽象为可插拔模块（接口 `getToken()`）；加 Gitee OAuth 时只替换该层，不返工。§7① 与 ② 的边界即这层抽象的落点。

## 8. Obsidian 支持（MVP）

- **双链 `[[...]]`**：markdown-it 自定义插件，解析为可点击链接。显示别名 `[[目标|别名]]` 与 `[[目标#标题]]` 的解析**已实现**；跳转按 vault 内文件名（basename）匹配，**frontmatter 声明的别名尚未支持**——见 #5。（本节原先写「别名留后续」，措辞含混到分不清指哪一种，已按实现校正。）
- **YAML frontmatter**：解析并在阅读态顶部展示（不参与编辑冲突的 diff）。
- **基础 GFM**：表格、代码块、列表、引用（markdown-it 默认能力）。
- **图片**：`![](path)` 渲染时 src 指向 `/api/raw?path=`（经后端代理，token 不进 URL）。**path 按 Obsidian 的读法解析**：以 `/` 开头的算 vault 根相对，其余相对**当前笔记所在目录**，支持 `./` 与 `../`；`https?://` 与已指向 `/api/` 的原样放过。越出仓库根或指向不存在的文件就是**失败**，且失败要看得见（渲染期能判定的输出占位，运行期的 404 就地替换成提示）——不静默退化成根相对，因为那会让一条写错的引用伪装成「能打开但不是你要的那个文件」，比报错难查得多。解析逻辑抽在 `web/src/vault-refs.js`（纯函数、可单测）。
- **引用解析仍未覆盖的**：只写 basename、文件在别处的图片引用（如 `![](x.png)` 而文件在 `assets/`）——需要按 vault 内文件名反查，属另一套索引，见 #5。

## 9. 部署

**操作步骤见 [README](../../../README.md) 的「部署上线」一节**——刻意不在本档案里复述，避免两处副本漂移（见 [ADR-0002](../../adr/0002-memory-is-not-the-knowledge-base.md)）。

设计层面的三条约束，它们才是选型时的实际判据：

1. **运行时必须能直连 gitee.com**。Gitee 不返回 CORS 头、token 不能进浏览器，所以必须有服务端——纯静态托管（GitHub Pages、Vercel/Netlify 静态）在架构上就不可行。
2. **大陆可达性是硬约束**。评估过的候选与结论：
   - 腾讯 EdgeOne Pages —— ❌ 否决。默认域名在大陆 401，稳定直连需绑已备案域名，而本项目没有自有域名。
   - Cloudflare Workers / Vercel / Netlify —— ⚠️ 大陆不可直连，仅作兜底。
   - **Deno Deploy —— ✅ 采用**。1M 请求/月的免费层对本场景绰绰有余；代价是注册账号需梯子一次，之后的部署与访问均直连（已实测）。
3. **静态资源与 API 同源**。同一进程同时伺服 `web/dist` 与 `/api/*`，省掉 CORS 与跨站 cookie 的全部麻烦——这正是 `deploy/main.ts` 存在的理由。

> 本节只记录**为什么**。注册流程与免费层限额属平台政策，会变，以官方文档为准。

## 10. 遗留 / 待定

本节的职能只剩「指向」——待办的权威位置是 issue tracker。在这里复述清单，就是造第二份会漂移的副本（见 [ADR-0002](../../adr/0002-memory-is-not-the-knowledge-base.md)）。

- ~~部署平台选型~~ —— **已定并上线**（Deno Deploy，见 §9）。
- 冲突长文本滚动 / 对照的真机体验 —— #3。
- 双链 frontmatter 别名（`aliases`）—— #5。（同票的相对图片路径已实现，见 §8。）
- 后端鉴权层的 `getToken()` 抽象边界（v2 OAuth 预留）—— #6，触发条件是 v2 立项。

> 2026-09-13 校正：前两条原先只写在本节、从未进 tracker，与 AGENTS.md「未完成的工作住 issue tracker」的规则冲突。已开票，本节改为指针。
