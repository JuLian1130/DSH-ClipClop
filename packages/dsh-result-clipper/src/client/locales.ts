/** 浏览器半自己持有的文案：内置插件页签与插件详情卡片的文案。 */

/** 本命名空间的文案键。 */
export type ResultClipperLocaleKey =
  | 'tab'
  | 'title'
  | 'description'
  | 'summarize'
  | 'summarizeHint'
  | 'admissionJudge'
  | 'admissionJudgeHint'
  | 'privacyGate'
  | 'privacyGateHint'
  | 'debug'
  | 'debugHint'
  | 'flowWarning'
  | 'routeProvider'
  | 'routeProviderHint'
  | 'routeModel'
  | 'routeModelHint'
  | 'admissionProvider'
  | 'admissionProviderHint'
  | 'admissionModel'
  | 'admissionModelHint'
  | 'minInlineTokens'
  | 'minInlineTokensHint'
  | 'maxSummarizeTokens'
  | 'maxSummarizeTokensHint'
  | 'summaryDisableReasoning'
  | 'summaryDisableReasoningHint'
  | 'admissionDisableReasoning'
  | 'admissionDisableReasoningHint'
  | 'privacyDisableReasoning'
  | 'privacyDisableReasoningHint'
  | 'routeConfirmedLocal'
  | 'routeConfirmedLocalHint'
  | 'routeUnconfirmedWarning'
  | 'failurePolicy'
  | 'failurePolicyHint'
  | 'failurePolicyPassthrough'
  | 'failurePolicyBlock'
  | 'summaryPrompt'
  | 'summaryPromptHint'
  | 'admissionPrompt'
  | 'admissionPromptHint'
  | 'privacyPrompt'
  | 'privacyPromptHint'
  | 'resetPrompt'
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
  admissionJudge: '摘要准入判断',
  admissionJudgeHint: '开启后命中长度的结果先经一次不带正文的 yes/no 判断；默认关闭。',
  privacyGate: '隐私闸门',
  privacyGateHint: '开启后每个标准工具结果先经本地模型判断；默认关闭。',
  debug: 'debug 记录',
  debugHint: '开启后向下面的日志路径追加 metadata 记录；关闭时不写盘。',
  flowWarning: '摘要会把工具正文发送给所选 route。',
  routeProvider: '摘要 route 的 provider',
  routeProviderHint: '摘要与隐私请求发往这条 provider 路由；留空时摘要路径失败并原样透传。',
  routeModel: '摘要 route 的 model',
  routeModelHint: '与 provider 一起决定请求发往哪条 route。',
  admissionProvider: '准入 route 的 provider',
  admissionProviderHint: '准入请求发往这条 provider 路由；留空时跟随摘要 route。',
  admissionModel: '准入 route 的 model',
  admissionModelHint: '与 provider 一起决定准入请求发往哪条 route；留空时跟随摘要 route。',
  minInlineTokens: '摘要下限（估算单位）',
  minInlineTokensHint: '低于它的结果原样保留；0 表示不设下限。',
  maxSummarizeTokens: '摘要上限（估算单位）',
  maxSummarizeTokensHint: 'bash 与 web_fetch 达到或超过它的结果交给 spill；read 不受它约束。',
  summaryDisableReasoning: '摘要请求关闭推理',
  summaryDisableReasoningHint: '默认开启，让本地模型更快响应。',
  admissionDisableReasoning: '准入请求关闭推理',
  admissionDisableReasoningHint: '默认开启，让本地模型更快响应。',
  privacyDisableReasoning: '隐私请求关闭推理',
  privacyDisableReasoningHint: '默认开启，让本地模型更快响应。',
  routeConfirmedLocal: '主 route 已确认为本地',
  routeConfirmedLocalHint: '隐私闸门要求你确认主 route 不会把内容发往外部网络；插件无法自行证明这一点。',
  routeUnconfirmedWarning: '隐私闸门已开启，但主 route 尚未确认为本地：每个工具结果都会按失败策略处理。确认它是本地 route，或关闭隐私闸门。',
  failurePolicy: '隐私失效的处理策略',
  failurePolicyHint: '判定敏感始终拦截；判断不确定或失败时按这条策略处理。',
  failurePolicyPassthrough: '放行原文',
  failurePolicyBlock: '拦截',
  summaryPrompt: '摘要提示词规则正文',
  summaryPromptHint: '只改规则正文；安全外壳与输出格式由插件固定，不可编辑。留空时用内置默认。',
  admissionPrompt: '准入提示词规则正文',
  admissionPromptHint: '只改规则正文；安全外壳与输出格式由插件固定，不可编辑。留空时用内置默认。',
  privacyPrompt: '隐私提示词规则正文',
  privacyPromptHint: '只改规则正文；安全外壳与输出格式由插件固定，不可编辑。留空时用内置默认。',
  resetPrompt: '恢复默认',
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
  admissionJudge: 'Summary admission judge',
  admissionJudgeHint: 'With this on, a result in range first gets a body-free yes/no judgment; off by default.',
  privacyGate: 'Privacy gate',
  privacyGateHint: 'Judges every standard tool result locally before it reaches the model; off by default.',
  debug: 'Debug records',
  debugHint: 'Appends metadata records to the log path below; nothing is written while off.',
  flowWarning: 'Summarization sends the tool body to the selected route.',
  routeProvider: 'Summary route provider',
  routeProviderHint: 'Summary and privacy requests go to this provider route; while empty the summary path fails and passes the result through.',
  routeModel: 'Summary route model',
  routeModelHint: 'Together with the provider this picks the exact route requests go to.',
  admissionProvider: 'Admission route provider',
  admissionProviderHint: 'Admission requests go to this provider route; while empty they follow the summary route.',
  admissionModel: 'Admission route model',
  admissionModelHint: 'Together with the provider this picks the admission route; while empty it follows the summary route.',
  minInlineTokens: 'Summarize floor (estimated units)',
  minInlineTokensHint: 'Results below it are kept as-is; 0 removes the floor.',
  maxSummarizeTokens: 'Summarize ceiling (estimated units)',
  maxSummarizeTokensHint: 'bash and web_fetch results at or above it go to spill; read is not bound by it.',
  summaryDisableReasoning: 'Disable reasoning for summary requests',
  summaryDisableReasoningHint: 'On by default, so local models answer faster.',
  admissionDisableReasoning: 'Disable reasoning for admission requests',
  admissionDisableReasoningHint: 'On by default, so local models answer faster.',
  privacyDisableReasoning: 'Disable reasoning for privacy requests',
  privacyDisableReasoningHint: 'On by default, so local models answer faster.',
  routeConfirmedLocal: 'Confirmed the main route is local',
  routeConfirmedLocalHint: 'The privacy gate needs you to confirm the main route never sends content to an external network; the plugin cannot prove it.',
  routeUnconfirmedWarning: 'The privacy gate is on, but the main route is not confirmed local: every tool result is handled by the failure policy. Confirm it is a local route, or turn the privacy gate off.',
  failurePolicy: 'Privacy failure policy',
  failurePolicyHint: 'A sensitive verdict is always blocked; an uncertain verdict or a failure follows this policy.',
  failurePolicyPassthrough: 'Pass through',
  failurePolicyBlock: 'Block',
  summaryPrompt: 'Summary prompt rule text',
  summaryPromptHint: 'Only the rule text is editable; the safety shell and output format are fixed by the plugin. Empty uses the built-in default.',
  admissionPrompt: 'Admission prompt rule text',
  admissionPromptHint: 'Only the rule text is editable; the safety shell and output format are fixed by the plugin. Empty uses the built-in default.',
  privacyPrompt: 'Privacy prompt rule text',
  privacyPromptHint: 'Only the rule text is editable; the safety shell and output format are fixed by the plugin. Empty uses the built-in default.',
  resetPrompt: 'Reset to default',
  debugPath: 'Debug log path',
  debugPathHint: 'Where the metadata JSONL is written; an empty path writes nothing. The plugin never falls back to a temporary path.',
  failedHint: 'The setting was not saved.',
}
