/**
 * 上游尾部元数据的识别：位置说明与 bash 截断说明。
 *
 * **这是一条外部约定假设**（DSH `>= 0.2.0-rc.2` 的写入点），不是本插件与它们之间的契约。通用链的单行截断与
 * 命令族的行封顶都靠这份判定放行这些行；两处各写一份就会各自漂，漂的那一边会把路径切掉、把可回退的入口弄坏。
 *
 * @module
 */

/**
 * 上游位置说明的识别串：spill-policy 写 `Full formatted result stored at: `、native `grep` 写
 * `Full grep result stored at: `、native `glob` 写 `Full sorted result stored at: `——三者共用 ` stored at: `
 * 这一段，都收在正文末尾的 `\n\n(...)` 块里。
 *
 * 漏认的后果是本层追加第二条入口、模型面对两条互相竞争的说明；认到的收益是硬的：上游那条指向**完整输出**，
 * 本层只指向被保留的片段，能复用它就不该再写一条。
 */
const POSITION_NOTICE_MARKER = ' stored at: '

/**
 * bash 工具追加的截断说明；路径不是 `(unavailable)` 时它就是一条指向完整输出的上游入口。
 *
 * 漏认的后果是把 `(unavailable)` 当成可用入口：本层因此不写自己的入口，模型没有可回退的位置。
 */
export const TRUNCATED_NOTICE = /\[output truncated; full output: ([^\]]*)\]/g

/** 截断说明没有可用的完整输出路径时写入的占位符。 */
export const UNAVAILABLE_PATH = '(unavailable)'

/**
 * 这行是不是指向完整输出的上游元数据（位置说明或截断说明）。
 *
 * 它不参与单行截断：按字符上限截掉路径等于把唯一可回退的入口弄坏（票 20 复审）。不能假设它一定在最后一行——
 * bash 的 `[exit code: N]` / 超时 / 信号标记可能跟在截断说明之后（上游 `renderResult` 把退出标记放在最后）。
 * @param line - 正文的一行。
 * @returns 是上游元数据行时为真。
 */
export function isUpstreamNoticeLine(line: string): boolean {
  return (line.startsWith('(') && line.includes(POSITION_NOTICE_MARKER))
    || line.match(TRUNCATED_NOTICE) !== null
}
