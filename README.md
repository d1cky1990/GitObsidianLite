# Obsidian 移动端轻量同步 Web 应用

手机浏览器访问的轻量应用，通过 Gitee API 按需拉取 / 编辑笔记并提交，替代手机端 obsidian-git 的整库拉取。

## 目录

- `server/src/core.js` — 平台无关 API 核心（藏 token、解 CORS，代理 Gitee API v5），Workers 与 Deno 共用
- `server/src/index.js` — Cloudflare Workers 薄适配器（本地开发用）
- `deploy/main.ts` — Deno Deploy 入口（静态伺服 + API 代理，零外部依赖）
- `web/` — 前端（Vite + 原生 JS + markdown-it）
- `deno.json` — Deno Deploy 部署配置（org/app/entrypoint/上传白名单）
- `scripts/` — 仓库工具：提交前凭据检查、hook 安装
- `.githooks/pre-commit` — 上面那个检查的挂载点（见「提交前凭据检查」）

## 本地运行

前置：Node 22。想跑第 4 步的线上形态，还需要 [Deno](https://docs.deno.com/runtime/getting_started/installation/)（Windows 用 `irm https://deno.land/install.ps1 | iex`）——注意官方安装脚本**不会**替你把 `~/.deno/bin` 加进 PATH，装完要自己加，然后**重开终端**。

1. 配置后端凭据：复制 `server/.dev.vars.example` 为 `server/.dev.vars`，填入 Gitee 私人令牌、owner、仓库名。
2. 起后端：`cd server && npm install && npm run dev`（默认 `http://localhost:8787`）。
3. 起前端：`cd web && npm install && npm run dev`（默认 `http://localhost:5173`，`/api` 已代理到后端）。
4. 想验证**线上形态**（前后端同进程伺服）时，改用 Deno 直接跑全栈：先 `cd web && npm run build`，再
   `PORT=8230 deno run --allow-net --allow-read --allow-env --env-file=server/.dev.vars deploy/main.ts`。

浏览器打开 `http://localhost:5173`（或第 4 步的 `http://localhost:8230`）即可。

> Windows 上 8000 附近可能落在 Hyper-V 的保留端口段里，起不来就用 `netsh int ipv4 show excludedportrange protocol=tcp` 查一下，换一个端口。

## 测试

```sh
cd web && npm test                     # 前端：双链 / 引用解析等纯函数
node --test "scripts/**/*.test.mjs"    # 仓库工具：凭据检查的规则
```

两边都是 `node --test`，没有额外测试框架。前端里能单测的只有不碰 DOM 的部分，所以渲染与判定被刻意抽成纯函数（`web/src/wikilinks.js`、`web/src/vault-refs.js`）——想给某个行为加回归测试，先看它是不是还在纯函数里。

单测盯的是纯函数；**一张票交付前还要在真语料上跑一遍**：从归档解出全库路径清单与每篇正文，`import` 被测模块**本身**整体渲染一遍，用改完的真实代码路径数结果。不要另写一份复刻被测逻辑的复算脚本——两边会一起错，而且错得看不出来。

这条吃过两次亏，两次都是「拿另一把尺子量」：`#7` 数出的「173 条目标非 `.md`」里只有 40 条真有文件；`#8` 数出的「107 条解析不到」里有 6 条落在 markdown-it 根本不渲染的缩进代码块里。**尺子必须和被测的东西在同一层**——文本层的正则数与渲染层真产出的 `<img>` 是两个数。

### 只存在于屏幕上的那些行为，怎么验

渲染与交互抽不进纯函数（那部分是 DOM），所以它们**没有单测可依赖**，只能真跑一遍：起本地全栈（「本地运行」第 4 步），用真浏览器打它，远端用真仓库。光看代码不算验过——`#26` 的两条判据（「点「⋯」不会顺带打开笔记」「向下滚收起、向上滚出现」）都只能靠真点击和真滚动测出来，而且真点了一次就抓到一处「按下去什么都不发生」的死键。

- 浏览器不用装驱动：headless Chrome 加 `--remote-debugging-port`，用 Node 自带的 `WebSocket` 直连 CDP 就够了。
- **点之前用 `document.elementFromPoint` 复核坐标上真是它**。少了这一步，一个被浮层盖住的按钮会让测试点到别的东西上去，报出来的失败指向别处。
- 测完**必须清干净**：写操作是真的写到仓库里的，`finally` 里删掉测试文件，然后再回远端确认一遍。测试本身留下的 commit 删不掉（git 历史），所以临时目录要取一眼能认出来的名字。
- 量尺寸/等渲染之前先等**新的一屏**出来：只换 hash 的导航不会重新加载页面，上一屏还留在 DOM 里，量到的是上一屏的尺寸。

## 提交前凭据检查

`scripts/check-secrets.mjs` 在 `git commit` 时扫一遍暂存内容，把误提交拦在本地。理由是**删文件 ≠ 删内容**：凭据一旦进了提交，要清干净得重写 git 历史；要是已经 push 过，还得当它已泄漏、轮换掉。

装一次：

```sh
node scripts/install-hooks.mjs
```

`core.hooksPath` 是**本地**配置、存在 `.git/config` 里、不进版本库——所以 hook 文件可以跟进仓库，但「指向它」这个动作必须每人各做一次，clone 完不装就等于没有。装没装别靠猜：

```sh
node scripts/check-secrets.mjs --status   # 未启用时退出码为 1
```

也支持手工跑：不带参数检查暂存内容（与 hook 同一入口），`--all` 检查所有可能被提交的文件（含未跟踪、不含被忽略的）。

**误报怎么办**——这层能否成立只看一件事：会不会被人主动 `--no-verify` 掉。一个误报频繁的 hook 等于没装，而且更糟：它会让人以为有防护。所以规则只拦「看起来像真值」的，文档里光出现 `GITEE_TOKEN` 这类字样不算。

- 误报：该行任意位置加 `secret-scan:allow`，或把占位值改成一眼假的（`your-token`、`你的令牌`）
- 真泄漏：从改动里拿掉，改放 `server/.dev.vars`（已被 `server/.gitignore` 排除）
- 确实要绕过：`git commit --no-verify` ← 绕过的正是这一层，别当成没事

规则分三层（本机真值指纹 / 赋值形态 / 敏感词紧邻的高熵串），每层为什么这么定写在脚本头部注释里。改规则后跑一遍测试：

```sh
node --test "scripts/**/*.test.mjs"
```

## 部署上线（Deno Deploy）

- 架构：`server/src/core.js`（平台无关 API 核心）被 `server/src/index.js`（本地 wrangler）与 `deploy/main.ts`（Deno 入口，静态 + API 一体）共用。
- 配置：`deno.json` 的 `deploy` 块指定 org/app/entrypoint 与上传白名单。
- 两类凭据，落点不同，别搞混：
  - **应用凭据**（`GITEE_TOKEN` / `GITEE_OWNER` / `GITEE_REPO` / 可选 `APP_PASSWORD`）——本地开发放 `server/.dev.vars`（`.gitignore` 已排除，不上传）；线上放**部署平台的环境变量**。
  - **部署令牌**（`DENO_DEPLOY_TOKEN`）——只用于从本机推代码，**不属于应用**，不要放进 `server/.dev.vars`（那个文件会被整份读进应用进程环境变量，见「本地运行」第 4 步的 `--env-file`）。放**本机环境变量**即可。
- 步骤：
  1. 装 Deno；`console.deno.com` 注册（新账号创建需梯子一次）。
  2. 在 <https://console.deno.com/account/tokens> 生成访问令牌，设为本机环境变量 `DENO_DEPLOY_TOKEN`（cmd：`setx DENO_DEPLOY_TOKEN "..."`，用 cmd 而非 PowerShell——PowerShell 会把命令记进历史文件，令牌跟着落盘）。
  3. 填 `server/.dev.vars`：`GITEE_TOKEN` / `GITEE_OWNER` / `GITEE_REPO`（+ 可选 `APP_PASSWORD`）。
  4. 把 `deno.json` 里的 `org` 改成你自己的组织，然后 `deno run -A jsr:@deno/deploy create --org <你的org> --app <app名> --source local --region global --do-not-use-detected-build-config --runtime-mode dynamic --entrypoint deploy/main.ts`（`--do-not-use-detected-build-config` 很关键，否则会误用 Vite 探测覆盖入口）。
  5. 推环境变量：`deno run -A jsr:@deno/deploy env add GITEE_TOKEN <值> --secret --org <org> --app <app>`（其余同理，`GITEE_OWNER` / `GITEE_REPO` 不是机密、不加 `--secret`）。**注意别用 `env load server/.dev.vars`**——它会把文件里的变量全部灌上去，若里面还留着部署令牌就一并交出去了。
  6. 重部署：`deno check deploy/main.ts` → `cd web && npm install && npm run build` → `deno run -A jsr:@deno/deploy --prod`。
- 访问保护：服务端 `APP_PASSWORD` 环境变量，前端输一次存 localStorage、请求头携带。

### 已知坑

- **CLI 必须用 `deno run -A jsr:@deno/deploy`**，不要用内置的 `deno deploy` wrapper——它有 `--help` / `--prod` 重复注入的 bug。
- **`deno deploy` 的交互式登录在 Windows 上不工作**：会报 `Unable to interact with keychain. The authentication will not be stored...`——注意后半句，**授权结果不会被保存**，即使浏览器登录成功也留不下凭据。即钥匙串方案不可用，`DENO_DEPLOY_TOKEN` 是唯一的持久化方式。（`deno deploy logout` 同理，无凭据可清。）
- **别用子域名探测判断 app 是否还存在**：Deno 对 `*.deno.net` 做**通配 DNS 解析**，一个确定不存在的 app 子域同样能解析、并返回 `404 DEPLOYMENT_NOT_FOUND`。没有阴性对照就会误判。看控制台或 `deno deploy apps` 更可靠。
- **`--do-not-use-detected-build-config` 不能省**。否则 create 会做框架自动探测，认出 `web/` 的 Vite 并覆盖你传的 `--entrypoint`，构建报 "No runtime entrypoint provided"。
- **`deno.json` 的 `deploy` 块必须含 `org` 字段**，否则 create 报 "missing field org"。
- **云端构建跑严格 `deno check`**，而本地 `deno run` 会放过隐式 any。**部署前先 `deno check deploy/main.ts`**。
- **构建失败看日志**：`console.deno.com/api/v2/revisions/{id}/build_logs`（注意路径是 `/api/v2/` 不是 `/v2/`，需 Bearer 令牌 + `X-Deno-Org` 头）。
- **环境变量默认不会被标成 secret**（用 `env add` 时要显式加 `--secret`，用 `env list` 可复核 `isSecret`）。已实测**两个机密不会出现在构建日志里**，但别据此省略 `--secret`——`env list` 会把非 secret 的值明文回传。
- **新账号注册会被区域限制**（`403 SIGNUP_UNAVAILABLE`），需要梯子一次；之后的 API、部署、运行时域名在大陆均可直连（已实测）。
- **上传白名单在 `deno.json` 的 `include`**：`web/dist` 虽被 `.gitignore` 排除，但仍靠这个白名单带上，删它会导致线上静态资源缺失。

## 后端 API

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/head` | 默认分支 + 最新 commit sha |
| GET | `/api/tree?path=` | 列目录 / 文件 |
| GET | `/api/tree/recursive` | 整棵树（path→blob sha） |
| GET | `/api/file?path=` | 读文件（utf8） |
| PUT | `/api/file` | 写文件（body: path/message/content/sha）。**带 sha 是改，不带是建** |
| DELETE | `/api/file` | 删文件（body: path/sha/message） |
| GET | `/api/raw?path=` | 图片 / 附件 raw |

`server/src/core.js` 是这一面的唯一出处；改接口先看它。

### Gitee 写操作的脾气（2026-09-21 在真仓库实测，别再靠猜）

这几条都是状态码看不出来、只能实测得来的。踩过一次就会以「功能死活不对」的样子出现，所以留在这里：

- **新建与更新是两个端点。** `PUT contents` 的 `sha` 是必填（缺了回 `400 {"messages":["sha is missing","sha is empty"]}`），**新建走 `POST contents`**（无 sha，成功 201）。服务端按「body 里有没有 sha」自己选路，浏览器不必知道。
- **`400` 被三种情况共用**：缺 sha / 内容为空 / sha 对不上。**不能只看状态码**，要按措辞判——认错一个，「远端被改过」会被说成「参数不对」，而一件要用户去合并、一件是本端 bug。
- **写冲突是 `400`，不是 409**：`{"message":"Blob SHA does not match"}`，且远端内容不会被覆盖。本服务端识别后统一回 409。
- **同名新建由 Gitee 挡下**：`400 {"message":"文件名已存在"}`，原文件不动。重名检查不用自己做第一道。
- **不存在的路径回 `200 + []`**（文件和目录都是），不是 404。拿状态码判存在性会全判错，只能看 body 是不是数组。
- **空内容建不出来**：`400 {"messages":["content is empty"]}`。「建一篇空笔记」写的是一个换行。
- **往还不存在的目录里建文件不用先建目录**：Gitee 顺着路径把目录带出来（201，随后 GET 就能列到）。git 里本来也没有目录这个东西。
- **`DELETE contents` 的参数在 query**（`sha` + `message`），不像 `PUT` 走 body；成功回 `200`，但 **`content` 是 `null`**——别去取 `content.sha`。

## 自行部署须知

这是一个 **self-hosted 单用户**应用，不提供公共实例：clone 后填自己的 Gitee 令牌部署即可，数据始终在自己的仓库里。

前置条件：
- 一个 Gitee 账号 + 一个存放笔记的仓库（公开私有都行，令牌需 `projects` 权限）
- 一台能跑 Node 22 的机器（本地开发），以及 [Deno](https://docs.deno.com/runtime/getting_started/installation/) + 一个 Deno Deploy 账号（线上部署）。**Deno 装完必须把安装目录加进 PATH**（官方 Windows 脚本不会自动加），否则终端认不出 `deno` 命令
- 如果需要**中国大陆免梯子访问**：Deno 账号注册需梯子一次，之后部署与访问均直连（平台政策可能变化，建议自行实测）

## 许可证

[MIT](LICENSE) © 2026 d1cky1990

