Status: resolved
Type: research

## Question

Gitee API 有哪些轻量手段，能高效检测"远端（PC 高频改动）是否有变化"，用于打开应用/切编辑模式时判断本地缓存是否过期？

具体查证：

- 获取仓库默认分支最新 commit sha 的接口与成本。
- git trees API（GET /repos/{owner}/{repo}/git/trees/{sha}）能否拿到递归 tree 的 sha，用于对比"目录/文件是否有变化"。
- contents/{path} 返回的 sha 是否稳定，能否做单文件级别的变化检测。
- 是否存在 CORS 限制（浏览器直接调 Gitee API 是否可行）——这决定是否需要后端代理。
- 限流/分页情况（影响"打开 app 时批量检查"的可负担性）。

## Answer

二阶段检测，经后端代理：打开 app → branches/{default_branch} 取 HEAD sha；变了 → git/trees/{sha}?recursive=1 拿整棵树 diff 出变化文件 → 只拉变化文件。CORS 结论：Gitee 不返回 CORS 头，必须后端代理（顺带隐藏 token）。限流 60/分钟（匿名），用量远低于限额。

详见 research/03-remote-change-detection.md
