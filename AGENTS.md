# AGENTS.md

仓库级 agent 行为规范。以下「硬性规范」优先级最高，任何 skill 或任务指令都不得覆盖。

## 硬性规范

### 1. 提交信息使用约定式提交（Conventional Commits）

格式：`<type>(<scope>): <subject>`。

- 常用 type：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`chore`、`ci`
- 破坏性变更：type 后加 `!`（如 `feat!:`），或在正文中包含 `BREAKING CHANGE:`
- subject 使用祈使语气，不加句号

### 2. 脚本元数据由人工管理

用户脚本头部元数据（`src/index.user.js` 中的 `@name`、`@version`、`@description`、`@namespace`、`@match` 等元数据块）以及 `package.json` 中的 `version` 等版本/元数据字段，**只能由人工手动管理**。agent 未经明确允许不得修改这些字段。

### 3. 样式优先复用 Bangumi 原站样式

新增样式前，先探索目标页面的 DOM 与样式表，查找并复用 Bangumi 原站已有的 CSS 类、CSS 变量和既有视觉语言；只有确认没有可复用的样式后，才手写新的 CSS。

## Agent skills

### Issue tracker

Issues 跟踪在本仓库的 GitHub Issues（`gh` CLI）；agent 默认禁止任何 issue 写操作，仅在人工显式要求时才可操作。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签 triage 词表（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局：根目录 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
