# Issue Tracker: Local Markdown

本仓库的规格和任务保存在 `.scratch/`。

## Conventions

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- 功能规格保存为 `.scratch/<feature-slug>/spec.md`。
- 规格顶部使用 `Status:` 记录状态；可交由编码代理实施的规格使用 `ready-for-agent`。
- 如需拆分实施任务，在 `.scratch/<feature-slug>/issues/` 下按 `01-<slug>.md` 顺序创建；当前功能不需要预先拆票。

当技能要求发布到 issue tracker 时，按以上约定创建或更新对应 Markdown 文件。
