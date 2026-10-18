# Obsidian 移动端轻量同步 Web 应用

手机浏览器访问的轻量应用，通过 Gitee API 按需拉取 / 编辑笔记并提交，替代手机端 obsidian-git 的整库拉取。

## 目录

- `server/src/core.js` — 平台无关 API 核心（藏 token、解 CORS，代理 Gitee API v5）
- `server/src/index.js` — Cloudflare Workers 入口：`/api/*` 交给 core，其余交给静态资源（**线上与本地都走它**）
- `server/wrangler.toml` — Worker 配置：入口、静态资源目录（`web/dist`）、两个普通变量
- `web/` — 前端（Vite + 原生 JS + markdown-it）
- `scripts/` — 仓库工具：一条命令的部署（`deploy.mjs`）、提交前凭据检查、hook 安装
- `docs/guide/` — 要你本人点网页的那几步（注册账号、生成令牌）；截图位置已留好，图待补
- `.githooks/pre-commit` — 凭据检查的挂载点（见「提交前凭据检查」）

## 本地运行

前置：Node 22。

1. 配置后端凭据：复制 `server/.dev.vars.example` 为 `server/.dev.vars`，填入 Gitee 私人令牌、owner、仓库名。**这份文件同时是部署用的那一份配置**，只有一处（见「部署上线」）。
2. 起后端：`cd server && npm install && npm run dev`（默认 `http://localhost:8787`）。
3. 起前端：`cd web && npm install && npm run dev`（默认 `http://localhost:5173`，`/api` 已代理到后端）。
4. 想验证**线上形态**（前后端同进程伺服）：先 `cd web && npm run build`，再 `cd server && npm run dev` 并打开 `http://localhost:8787`。线上就是这么跑的——`web/dist` 在 `wrangler.toml` 里被当作静态资源目录。

浏览器打开 `http://localhost:5173`（或第 4 步的 `http://localhost:8787`）即可。

> 后端默认端口是 8787（`wrangler dev`）。Windows 上起不来说「端口被占用」，先用 `netsh int ipv4 show excludedportrange protocol=tcp` 看一眼是不是落在系统保留段里，再换一个：`cd server && npx wrangler dev --port 8790`。

## 测试

```sh
cd web && npm test                     # 前端：双链 / 引用解析等纯函数
node --test "scripts/**/*.test.mjs"    # 仓库工具：凭据检查的规则
```

两边都是 `node --test`，没有额外测试框架。前端里能单测的只有不碰 DOM 的部分，所以渲染与判定被刻意抽成纯函数（`web/src/wikilinks.js`、`web/src/vault-refs.js`、`web/src/tags.js`、`web/src/task-markers.js`、`web/src/tasks-query.js`、`web/src/frontmatter.js`、`web/src/search.js`、`web/src/note-sync.js`）——想给某个行为加回归测试，先看它是不是还在纯函数里。

单测盯的是纯函数；**一张票交付前还要在真语料上跑一遍**：从归档解出全库路径清单与每篇正文，`import` 被测模块**本身**整体渲染一遍，用改完的真实代码路径数结果。不要另写一份复刻被测逻辑的复算脚本——两边会一起错，而且错得看不出来。

这条吃过两次亏，两次都是「拿另一把尺子量」：`#7` 数出的「173 条目标非 `.md`」里只有 40 条真有文件；`#8` 数出的「107 条解析不到」里有 6 条落在 markdown-it 根本不渲染的缩进代码块里。**尺子必须和被测的东西在同一层**——文本层的正则数与渲染层真产出的 `<img>` 是两个数。

### 只存在于屏幕上的那些行为，怎么验

**先读远端那个仓库自己的规矩。** 那是别人的地盘，红线写在各家自己的 `AGENTS.md` 里，本项目文档说了不算、也不能推及（见根 `AGENTS.md` 的「Boundaries outside this repo」）。

渲染与交互抽不进纯函数（那部分是 DOM），所以它们**没有单测可依赖**，只能真跑一遍：起本地全栈（「本地运行」第 4 步），用真浏览器打它，远端用真仓库。光看代码不算验过——`#26` 的两条判据（「点「⋯」不会顺带打开笔记」「向下滚收起、向上滚出现」）都只能靠真点击和真滚动测出来，而且真点了一次就抓到一处「按下去什么都不发生」的死键。

- 浏览器不用装驱动：headless Chrome 加 `--remote-debugging-port`，用 Node 自带的 `WebSocket` 直连 CDP 就够了。
- **点之前用 `document.elementFromPoint` 复核坐标上真是它**。少了这一步，一个被浮层盖住的按钮会让测试点到别的东西上去，报出来的失败指向别处。
- 测完**必须清干净**：写操作是真的写到仓库里的，`finally` 里删掉测试文件，然后再回远端确认一遍。测试本身留下的 commit 删不掉（git 历史），所以临时目录要取一眼能认出来的名字。
- 量尺寸/等渲染之前先等**新的一屏**出来：只换 hash 的导航不会重新加载页面，上一屏还留在 DOM 里，量到的是上一屏的尺寸。
- **用一个内存版假后端，别拿真仓库当靶子**：静态托管 `web/dist` + 内存里的 `/api`（一份样本内容、一个版本号、一张提交记账），跑得快、写操作不留痕，也不用清场。`#27` 的勾选、`#28` 的记号、`#29` 的标签、`#30` 的声明区都这么验的，样本与脚本留在 `.scratch/`（已被 `.gitignore` 排除）。真仓库那套（「本地运行」第 4 步）留给最后一步的真机确认。
- **`.scratch/` 里的脚本解析不到裸包名**：它不在 `web/` 下，`import MarkdownIt from 'markdown-it'` 会报 `ERR_MODULE_NOT_FOUND`（Node 按**脚本自己所在目录**往上找 `node_modules`）。写成 `../../web/node_modules/markdown-it/index.mjs` 最省事。
- **拿真库当真数据量一遍时，先确认尺子和被测的东西在同一层**：`#29` 量标签时，用正则在原文上数出的条数比渲染后数出来的多一倍，多出来的全是 `### 标题` 这类被当成了标签的噪音。**import 被测模块本身、整体跑一遍再数**，两个口径对不上就一直查到对上为止——对不上的那部分往往正是规则该干的活。
- **量「收起来的 `<details>` 里那几行看不见」，别用 `getBoundingClientRect()`**：收起是靠 `::details-content { content-visibility: hidden }` 实现的，那几行**布局盒还在**（`#30` 实测 `offsetHeight` 26、rect 高 25.6），拿尺寸量会得出「明明收着却全都看得见」。用 `el.checkVisibility()`（它把 `content-visibility` 算进去）+ 折叠块自身的高度。
- **比「新旧两套渲染管线输出是否一致」时，比法本身也得同层**：`#30` 第一版拿「删掉声明块后的正文」去和「原文渲染结果」比，全线不一致——不是功能坏了，是删掉的那几行让**源文绝对行号**整体前移，而勾选框的 `data-task-line` 记的正是绝对行号。正确比法是**把那段原地挖空、行数不动**再渲染一遍。
- **单测「import 被测模块本身跑一遍」不等于应用里也这么接线**：`#8` 的图片规则要一个 `isIndexPending()`，而它读的是 `main.js` 里一个模块级变量；单测里传的是写死的 `false`，于是全都过，应用里那个变量却一直非空——**每一张库内图片都被摆成「正在确认位置」的中性占位，永远换不成真图**。`#33` 在真浏览器里打开一篇带图的笔记才看见。教训：跨模块的**接线**（谁读谁、什么时候清）没有单测可依赖，验它就得真跑一遍。
- **验「打字」要用输入法那条通路，别只用直接插入**：`#33` 用 `Input.insertText` 把「打一个字母之后输入状态还在不在」验得全绿，需求方一试还是「刚打一个字母就断」——因为中文用户走的是**组字**：整页重画把那个 `<input>` 换成新节点，组字当场被丢掉。换 `Input.imeSetComposition` 一测就现（框被换掉、`compositionend` 再不触发、接着敲的字母糊成一串）。**尺子和被测的东西在同一层**这条，在输入上也成立。
- **别在重画里换掉用户正在打字的那个 `<input>`**：光标丢不丢只是它的一个后果，根子是节点不能换。`#33` 的办法是把列表页拆成「骨架（只建一次）+ 内容区（只换这块）」，那些「有/没有」的元素（面包屑、清空、新建）改成切 `hidden`，不靠增删节点。

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

## 部署上线（Cloudflare Workers）

```sh
node scripts/deploy.mjs
```

一条命令跑完，不用先建应用、也不用逐个推变量。

**前提只有两件**：

1. 一个 Cloudflare 账号（免费档够用）。
2. 本机环境变量 `CLOUDFLARE_API_TOKEN` 里放一个 API 令牌：

   ```
   setx CLOUDFLARE_API_TOKEN "..."
   ```

   在 cmd 里跑，然后**重开终端**。用 cmd 而不是 PowerShell：后者会把命令记进历史文件，令牌跟着落盘。

   这个令牌**必须是「用户级」的**：账号页的 Account API Tokens、以及对象存储（R2）那边生成的都属于「账号级」，wrangler 认不出该往哪个账号部署。在哪生成、模板选哪个，见指引；撞上了看下面「已知的坑」第一条。

这两件事都要你**本人登录后点网页**，截图与逐步说明在 [`docs/guide/manual-steps.md`](docs/guide/manual-steps.md)。本节只写本机要做什么。

**配置只有一处**：`server/.dev.vars`（从 `.dev.vars.example` 复制）。三项必填——`GITEE_TOKEN` / `GITEE_OWNER` / `GITEE_REPO`，加一个可选的 `APP_PASSWORD`。本地开发和部署读的是同一份，脚本**只挑这几项**推上去，文件里多出来的键一律不推。

**部署令牌不进这个文件**：它只在本机环境变量里。那份文件会被整份读进应用进程（`wrangler dev` 直接读它），把不属于应用的东西放进去，等于顺手交出去。

### 这条命令会依次做什么

| 步 | 做什么 | 没过时 |
|---|---|---|
| 1 | 读 `server/.dev.vars` | 点名缺哪一项、该去哪补 |
| 2 | 查 `CLOUDFLARE_API_TOKEN` | 点名令牌没设，附去哪生成 |
| 3 | **自检**（本机 → gitee.com）：令牌活否 / 仓库在否 / 有没有写权限 / 默认分支读不读得到 | 配置类点名改哪一项；网络类说重跑一次 |
| 4 | 构建前端（`web/dist`；缺依赖时先 `npm install`） | 给最后几行输出与手动复现的命令 |
| 5 | 推机密（`GITEE_TOKEN`，设了密码再加 `APP_PASSWORD`）→ `wrangler deploy`（owner 与仓库名跟着这条命令走） | 认得出就点名：令牌不认 / 账号不止一个 / 没连上 |
| 6 | **确认**（Cloudflare → gitee.com）：打一次线上地址、读一次仓库最新版本 | 分清「没部署成功」与「部署成功但连不上仓库」 |

第 3 步放在开头不是随手排的：它走「本机 → gitee.com」，五秒出结果。放在构建之后才停，就白等几分钟。

第 6 步不能省，因为它走的是**另一条网络路**——「Cloudflare → gitee.com」。本机自检全过，不等于线上够得到仓库；这两句话说的不是一件事。

**幂等**：Workers 没有「建应用」这一步，`wrangler deploy` 第一次跑就把 Worker 建出来。紧接着再跑一次只是重新构建、重新上传，机密已存在就改值。

### 失败怎么读

两种话，对应两种动作：

- **说得清的**（令牌 / 仓库名 / 写权限 / 缺变量）→ 点名哪一项、去哪改。改完重跑。
- **说不清的**（网络 / 对方临时出错）→ 「这项没测出来，多半是网络，重跑一次」。

**没有强行部署的开关。** 这条命令包的只是几步标准步骤、不是黑盒：它每一步都以 `▸ n/6 …` 打出来，背后就是 `wrangler`（装在 `server/` 里，部署由 `wrangler deploy` 完成）。检查本身有毛病时，人看得到卡在哪一步。

### 已知的坑

一处一条，写的都是**撞上时看到的样子**——这些是 2026-10 搬到 Workers 时真撞出来的，而症状和原因通常对不上号。

- **`Authentication failed (status: 400) [code: 9106]`，打头就是 `/memberships`** → 用的是**账号级**令牌（账号页的 Account API Tokens、R2 那边生成的都算）。wrangler 部署前要先问「这个令牌属于哪个账号」，账号级令牌答不上这个问题。换成用户级令牌——生成路径见[指引](docs/guide/manual-steps.md)第 2 节，或者把账号 ID 也设上。**它不是「令牌不对」**——同一个令牌可能调别的接口是好的。
- **代码确实传上去了，却一个网址都没给** → 这个账号还没注册过 `workers.dev` 子域（每个账号只注册一次）。脚本会停下来让你加 `--subdomain 你的名字` 重跑，因为这个名字会进网址、全球唯一，只能你自己选。**别把这一步当成「部署失败」**。
- **`wrangler` 一启动就报找不到 `../web/dist`** → 静态资源目录还没有内容。先 `cd web && npm run build`；走部署脚本的话第 4 步会替你构建。
- **页面打得开，所有接口却都是 404，报错里一个字都不提路由** → `web/dist` 里出现了一个叫 `api` 的东西（多半是有人往 `web/public/` 放了同名文件，Vite 会原样复制过去）。静态资源优先匹配，`/api/*` 就被挡在门外。机制写在 `server/wrangler.toml` 的 `[assets]` 注释里，`server/src/index.test.mjs` 有一条测试守着。
- **把批大小调大之后，整趟同步每批都 400、一篇都取不到** → 服务端一批上限 20、上游并发 6，这两个数是平台免费档的「单次调用最多 50 个外发请求、同时最多 6 条连接」倒推出来的，不是调优值。原因写在 `server/src/core.js` 那两个常量上方。
- **电脑上正常，手机上打不开** → 这不是配置没调好，而是地址本身的脾气，见下面「自行部署须知」的「访问方式」。
- **第一次打开带图的笔记，像卡住了十几秒** → 冷启动要先拉全库名单、再逐张取图；同一篇再开是秒开。慢不构成故障（那条判据已撤销），数字记在 [#41](https://github.com/d1cky1990/GitObsidianLite/issues/41)。

### 仓库还没建？

```
node scripts/deploy.mjs --create-repo
```

脚本会在**你自己的账号下**建一个私有仓，并在仓库根放一篇示例笔记（`从这里开始.md`：标题 / 列表 / 勾选框 / 双链 / 标签各演示一遍），让第一次打开不是空白页。名字被占了就停下让你改名，**不自动加后缀**——那样会凭空多出一个仓，你自己都找不到。已有仓库不用管这个参数。

### 想先看会不会炸？

```
node scripts/deploy.mjs --dry-run
```

自检、构建、试打包，不上传、不推变量。

### 访问保护

`APP_PASSWORD`（可选）：设了之后所有 `/api` 请求要带 `X-Auth` 头，前端输一次存 localStorage。**不设就完全不鉴权**——靠「地址不公开 + 免费档没人枚举」兜底，地址一旦泄漏即等同无保护。

### GitHub 那条路（旁路，不是主路径）

本项目的应用只对接 Gitee：`server/src/core.js` 里写的全是对 Gitee API v5 的调用。把**笔记仓库**换成 GitHub 这条路**现在不通**，它缺的是一层适配，不是改个名字。

- **要求能连上 `github.com`**。这个域名在大陆不挂梯子实测不通，而 `api.github.com` 通——所以「接口回得正常」不能当作「这条路能用」：注册、生成令牌、首次授权都要过 `github.com` 那一步。
- **令牌范围不一样**：GitHub 勾 `repo`，Gitee 勾 `projects`。
- **仓库名写法一样**（`owner/repo`），但接口路径、错误体措辞、以及「一个 400 混着好几种错」的那套脾气全不同——见下面「Gitee 写操作的脾气」，那几条按措辞判定的规则在 GitHub 上一条都不成立，得重写一遍。

给本来就把**代码**放在 GitHub 的人：代码放哪都行（本仓库自己的 issue 就在 GitHub 上）。但应用读写的那个**笔记仓库**目前只能是 Gitee。

## 后端 API

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/head` | 默认分支 + 最新 commit sha |
| GET | `/api/tree?path=` | 列目录 / 文件 |
| GET | `/api/tree/recursive` | 整棵树（path→blob sha） |
| GET | `/api/file?path=` | 读文件（utf8） |
| PUT | `/api/file` | 写文件（body: path/message/content/sha）。**带 sha 是改，不带是建** |
| DELETE | `/api/file` | 删文件（body: path/sha/message） |
| POST | `/api/blobs` | **批量取正文**（body: `{files:[{path,sha}]}`，一批 ≤20）。单条失败只报单条 |
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
- 一台能跑 Node 22 的机器（构建前端、跑那条部署命令都要它）
- 一个 Cloudflare 账号 + 一个 API 令牌（见「部署上线」与[图文指引](docs/guide/manual-steps.md)）
- **访问方式**：`*.workers.dev` 在国内长期不稳，日常打开大概要挂着梯子。这是选这个平台时明确接受的代价（[#39](https://github.com/d1cky1990/GitObsidianLite/issues/39)），不是配置没调好

## 许可证

[MIT](LICENSE) © 2026 d1cky1990

