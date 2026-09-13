# AGENTS.md

Guidance for agents working in this repo. Project overview and run instructions live in `README.md`.

## Where knowledge lives

Read the right source before proposing anything; write new knowledge back to the right source.

| Topic | Source of truth |
|---|---|
| Why the system is built this way — stack, architecture, API surface, auth, hosting constraints | `docs/design/obsidian-mobile-web/spec.md` |
| Options considered and rejected | `docs/design/obsidian-mobile-web/` (`map.md`, `issues/`, `research/`) — **historical snapshot, read-only** |
| Settled decisions that shouldn't be reopened | `docs/adr/` |
| How to run, test and deploy, including known pitfalls | `README.md` |
| Open work and in-flight decisions | GitHub issues — see below |

Two rules that matter more than they look:

- **Design archives are snapshots; `spec.md` is current.** Where they disagree, `spec.md` wins — and the disagreement is a defect to fix, not a state to tolerate. (The archives were written on 2026-08-29 and kept verbatim; ticket 01's hosting conclusion has since been superseded.)
- **Never let one fact live in two places.** Duplicated knowledge drifts, and the copy nobody proofreads is the one that rots — that's exactly how the archives fell behind the code in the first place. This is why `spec.md` §9 points at `README.md` instead of restating the deploy steps. See `docs/adr/0002`.
- **Work-in-progress goes in `.scratch/`, and `.scratch/` is not a source of truth.** It is git-ignored and never published. A design archive that is finished moves into `docs/design/` (that move is how the current archives got here). Nothing in `.scratch/` should be read as a decision — check `docs/adr/` and the open issues instead.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `d1cky1990/GitObsidianLite`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles; each label string equals its role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
