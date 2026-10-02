/** 浏览器半自己持有的文案：内置插件页签与插件详情卡片的文案。 */

/** 本命名空间的文案键。 */
export type ResultClipperLocaleKey =
  | 'tab'
  | 'title'
  | 'description'
  | 'summarize'
  | 'summarizeHint'
  | 'privacyGate'
  | 'privacyGateHint'
  | 'debug'
  | 'debugHint'
  | 'debugPath'
  | 'debugPathHint'
  | 'failedHint'

/** 中文文案。 */
export const zh: Record<ResultClipperLocaleKey, string> = {
  tab: '工具结果裁剪',
  title: '工具结果裁剪',
  description: '摘要把适合继续工作的工具结果改写成较短的说明并保留原结果入口；隐私闸门在结果进入模型前做一次本地判断。两项能力都默认关闭。',
  summarize: '工具结果摘要',
  summarizeHint: '开启后工具结果才可能被改写；关闭时结果保持 DSH 原有行为。',
  privacyGate: '隐私闸门',
  privacyGateHint: '开启后每个标准工具结果先经本地模型判断；默认关闭。',
  debug: 'debug 记录',
  debugHint: '开启后向下面的日志路径追加 metadata 记录；关闭时不写盘。',
  debugPath: '调试日志路径',
  debugPathHint: 'metadata JSONL 的写入位置；留空时 debug 不写盘。不会自动改用临时路径。',
  failedHint: '设置未能保存。',
}

/** 英文文案。 */
export const en: Record<ResultClipperLocaleKey, string> = {
  tab: 'Result clipper',
  title: 'Result clipper',
  description: 'Summarization rewrites tool results worth continuing with into a shorter note and keeps an entry back to the original; the privacy gate judges each result locally before it reaches the model. Both abilities are off by default.',
  summarize: 'Summarize tool results',
  summarizeHint: 'Only with this on can a tool result be rewritten; while off, results keep the original DSH behavior.',
  privacyGate: 'Privacy gate',
  privacyGateHint: 'Judges every standard tool result locally before it reaches the model; off by default.',
  debug: 'Debug records',
  debugHint: 'Appends metadata records to the log path below; nothing is written while off.',
  debugPath: 'Debug log path',
  debugPathHint: 'Where the metadata JSONL is written; an empty path writes nothing. The plugin never falls back to a temporary path.',
  failedHint: 'The setting was not saved.',
}
