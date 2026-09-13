# 调研：Gitee 远端改动检测机制（票 03）

## 结论

**推荐二阶段检测，经后端代理：**

打开 app → `GET /v5/repos/{owner}/{repo}/branches/{default_branch}` 取 HEAD sha；变了 → `GET /v5/repos/{owner}/{repo}/git/trees/{sha}?recursive=1` 拿整棵树 → 与本地缓存的 path→blob sha 映射 diff → 只拉变化文件。

## 各级判据

- 仓库级：`/branches/{branch}` 返回 commit.sha（最新提交），一次请求、响应体小，sha 变化即代表「远端有新提交」。局限：只反映「最后提交」，无法区分哪个文件变了。
- 目录/文件级：`/git/trees/{sha}?recursive=1` 一次返回整棵树的 tree.sha 与每个条目 path/type/blob sha，无分页；用于 diff 出精确变化文件。
- 单文件：`contents/{path}` 返回内容寻址的 blob sha，内容不变则稳定，但默认附带 base64 content、逐文件请求成本高，仅适合单文件精确校验。

## CORS：必须后端代理

Gitee OpenAPI v5 响应不返回 Access-Control-Allow-Origin，浏览器直接 fetch 报错（有实测）。故移动端 web 不能直连，需后端代理，顺带隐藏 access_token。

## 限流/分页

匿名约 60 请求/分钟（X-RateLimit-Limit: 60），带 token/OAuth 额度更高；列表接口 page/per_page（最大 100）。「打开一次 app 仅 1–2 次请求」远低于限额。

## 来源

- https://gitee.com/api/v5/swagger （官方 Swagger）
- https://apis.io/rate-limits/gitee/gitee-rate-limits （限流 60/分钟）
- https://gitee.com/vieyahn/react-schema-linker/issues/IE3MUD （CORS 实测报错）
- https://www.cnblogs.com/pc2005/p/22381409 （trees/contents/blobs 结构）
