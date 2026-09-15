# AGENTS.md

本文件是给在本仓库工作的 agent 的指引。项目概览与运行方式见 `README.md`。

> **语言约定**：章节标题保持英文——有 skill 按标题名检索本文件（`setup-matt-pocock-skills` 会检测 `## Agent skills` 是否存在），翻译标题会让它们失效。正文用中文，与仓库其余文档一致。（`docs/agents/` 下三份是 skill 的配置产物，结构与标题由 skill 定义，因此整体保持英文。）

## Where knowledge lives

提任何方案之前，先读对应的来源；新知识要回写到对应的来源。

| 主题 | 权威来源 |
|---|---|
| 为什么这样设计——技术栈、架构、API 面、鉴权、托管约束 | `docs/design/obsidian-mobile-web/spec.md` |
| 考虑过并否决的选项 | `docs/design/obsidian-mobile-web/`（`map.md`、`issues/`、`research/`）—— **历史快照，只读** |
| 已定下、不该重开的决定 | `docs/adr/` |
| 怎么跑、怎么测、怎么部署，以及已知的坑 | `README.md` |
| 未完成的工作与进行中的决定 | GitHub Issues —— 见下文 |

以下三条规则，比它们看上去的要紧：

- **设计档案是快照，`spec.md` 是现行方案。** 两者冲突时以 `spec.md` 为准——而且这个冲突本身是**待修的缺陷**，不是可以容忍的状态。（档案写于 2026-08-29 并原样保留；票 01 的托管结论此后已被取代。）
- **一个事实不许住两处。** 重复的知识必然漂移，而没人校对的那一份先烂掉——档案当初落后于代码，就是这么来的。这就是 `spec.md` §9 指向 `README.md`、而不复述部署步骤的原因。见 `docs/adr/0002`。
- **未完稿放 `.scratch/`，而 `.scratch/` 不是知识来源。** 它被 git 忽略、永不发布。成熟的设计档案移入 `docs/design/`（现有档案就是这么搬过来的）。`.scratch/` 里的任何东西都不该被当作决定来读——要查决定，去看 `docs/adr/` 和未关闭的 issue。

## Agent skills

### Issue tracker

issue 与 spec 都存放在 `d1cky1990/GitObsidianLite` 的 GitHub Issues 里，用 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范的 triage 角色；标签名与角色名一一对应（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

单一 context —— 仓库根的 `CONTEXT.md` 与 `docs/adr/`，由 `/domain-modeling` 惰性创建。见 `docs/agents/domain.md`。
