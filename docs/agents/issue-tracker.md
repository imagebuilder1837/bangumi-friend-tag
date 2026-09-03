# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Agent issue 操作限制（硬性规范）

**Agent 默认禁止任何 issue 写操作**——包括创建、评论、修改标签、指派、关闭、编辑正文等。只有以下情况才允许操作 issue：

1. 人工**显式要求**调用相关 skill（如 `to-spec`、`to-tickets`、`triage`、`wayfinder` 等）
2. 人工在对话中**明确指示**对某个 issue 进行某项操作

读操作（`gh issue view` / `gh issue list`）不受此限制。此限制来自 `AGENTS.md` 硬性规范 4，任何 skill 都不得绕过。

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.（需满足上述限制）
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`（需满足上述限制）
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`（需满足上述限制）
- **Close**: `gh issue close <number> --comment "..."`（需满足上述限制）

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue — **仅在人工显式要求时**（见顶部限制）。

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
