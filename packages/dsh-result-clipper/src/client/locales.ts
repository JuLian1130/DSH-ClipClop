/** 浏览器半自己持有的文案：内置插件页签与包详情页配置区的文案。 */

/** 本命名空间的文案键。 */
export type ResultClipperLocaleKey =
  | 'tab'
  | 'summarize'
  | 'summarizeHint'
  | 'admissionJudge'
  | 'admissionJudgeHint'
  | 'privacyGate'
  | 'privacyGateHint'
  | 'debug'
  | 'debugHint'
  | 'dryRun'
  | 'dryRunHint'
  | 'dryRunInactiveHint'
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
  | 'admissionPrompt'
  | 'privacyPrompt'
  | 'promptHint'
  | 'savePrompt'
  | 'resetPrompt'
  | 'debugPath'
  | 'debugPathHint'
  | 'failedHint'

/** 中文文案。 */
export const zh: Record<ResultClipperLocaleKey, string> = {
  tab: '工具结果裁剪',
  summarize: '工具结果摘要',
  summarizeHint: '开启后工具结果才可能被改写；关闭时结果保持 DSH 原有行为。',
  admissionJudge: '摘要准入判断',
  admissionJudgeHint: '开启后命中长度的结果先经一次不带正文的 yes/no 判断；默认关闭。',
  privacyGate: '隐私闸门',
  privacyGateHint: '开启后每个标准工具结果先经本地模型判断；默认关闭。',
  debug: 'debug 记录',
  debugHint: '开启后向下面的日志路径追加 metadata 记录；关闭时不写盘。',
  dryRun: '干跑',
  dryRunHint: '开启后走完整流水线但只写诊断记录：不替换内容、不写会话事件、不调用存储、不写 memo。需要同时开启 debug 记录并填好日志路径。',
  dryRunInactiveHint: '干跑未生效：debug 记录关闭或日志路径为空，工具结果仍会被照常替换。',
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
  admissionPrompt: '准入提示词规则正文',
  privacyPrompt: '隐私提示词规则正文',
  promptHint: '框里是当前生效的规则正文，未改时就是内置默认；改完要点「保存」才写回，没保存就离开不会留下改动；只改规则正文，安全外壳与输出格式由插件固定，不可编辑。',
  savePrompt: '保存',
  resetPrompt: '恢复默认',
  debugPath: '调试日志路径',
  debugPathHint: 'metadata JSONL 的写入位置；留空时 debug 不写盘。不会自动改用临时路径。',
  failedHint: '设置未能保存。',
}

/** 英文文案。 */
export const en: Record<ResultClipperLocaleKey, string> = {
  tab: 'Result clipper',
  summarize: 'Summarize tool results',
  summarizeHint: 'Only with this on can a tool result be rewritten; while off, results keep the original DSH behavior.',
  admissionJudge: 'Summary admission judge',
  admissionJudgeHint: 'With this on, a result in range first gets a body-free yes/no judgment; off by default.',
  privacyGate: 'Privacy gate',
  privacyGateHint: 'Judges every standard tool result locally before it reaches the model; off by default.',
  debug: 'Debug records',
  debugHint: 'Appends metadata records to the log path below; nothing is written while off.',
  dryRun: 'Dry run',
  dryRunHint: 'Runs the whole pipeline but only writes diagnostics: no replacement, no session events, no storage, no memo. Needs debug records on and a log path filled in.',
  dryRunInactiveHint: 'Dry run is not in effect: debug records are off or the log path is empty, so tool results are still replaced.',
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
  admissionPrompt: 'Admission prompt rule text',
  privacyPrompt: 'Privacy prompt rule text',
  promptHint: 'The box holds the rule text in effect (the built-in default until you change it); press Save to write an edit back, leaving without saving keeps it out of the configuration; only the rule text is editable, the safety shell and output format are fixed by the plugin.',
  savePrompt: 'Save',
  resetPrompt: 'Reset to default',
  debugPath: 'Debug log path',
  debugPathHint: 'Where the metadata JSONL is written; an empty path writes nothing. The plugin never falls back to a temporary path.',
  failedHint: 'The setting was not saved.',
}
