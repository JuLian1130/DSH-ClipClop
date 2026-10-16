/**
 * 命令族夹具：一份**真实形态**的 `git diff`（两个文件头、一个 150 删 150 增的 hunk）。
 *
 * 150 处改动同时超过这一族的两级封顶（每 hunk 明细 100 行、整体 200 行），也超过通用链的封顶触发行数 300，
 * 所以「走的是命令族还是通用链」在正文形态上直接看得出来（族给 `  +N -M`，通用链给 `…[省略 N 行]`）。
 * 两个 spec 共用它：票 15 的 `condense-pipeline.spec.ts`（平台面那条阴性对照）与票 16 的
 * `dispatch-pipeline.spec.ts`。
 *
 * @module
 */

/** 这份 diff 里每侧的改动行数。 */
export const GIT_DIFF_CHANGED = 150

/** 真实形态的 hunk：`@@ -1,150 +1,150 @@` 之后 150 删 + 150 增。 */
export const GIT_DIFF_BODY = [
  'diff --git a/app.ts b/app.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/app.ts',
  '+++ b/app.ts',
  `@@ -1,${GIT_DIFF_CHANGED} +1,${GIT_DIFF_CHANGED} @@ function main() {`,
  ...Array.from(
    { length: GIT_DIFF_CHANGED },
    (_, index) => `-const old${String(index).padStart(3, '0')} = compute(${index})`,
  ),
  ...Array.from(
    { length: GIT_DIFF_CHANGED },
    (_, index) => `+const neu${String(index).padStart(3, '0')} = compute(${index})`,
  ),
].join('\n')

/** 一次 git diff 调用的参数：`command` 就是分派要读的那条命令串。 */
export const GIT_DIFF_ARGS = { command: 'git diff HEAD~1' }

/** 族真正收窄后会出现的逐文件聚合量；通用链不会产生它。 */
export const AGGREGATE_LINE = /^ {2}\+\d+ -\d+$/m
