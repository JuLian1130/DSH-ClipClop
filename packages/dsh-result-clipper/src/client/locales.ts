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
  | 'summaryGroup'
  | 'summaryGroupHint'
  | 'admissionGroup'
  | 'admissionGroupHint'
  | 'privacyGroup'
  | 'privacyGroupHint'
  | 'diagnosticsGroup'
  | 'diagnosticsGroupHint'
  | 'routeProvider'
  | 'routeProviderHint'
  | 'routeModel'
  | 'routeModelHint'
  | 'routeUnset'
  | 'followSummaryRoute'
  | 'customValue'
  | 'pickFromCatalog'
  | 'notInCatalog'
  | 'admissionProvider'
  | 'admissionModel'
  | 'privacyProvider'
  | 'privacyModel'
  | 'minInlineTokens'
  | 'minInlineTokensHint'
  | 'maxSummarizeTokens'
  | 'maxSummarizeTokensHint'
  | 'reasoningEffort'
  | 'reasoningEffortHint'
  | 'effortOff'
  | 'effortMinimal'
  | 'effortLow'
  | 'effortMedium'
  | 'effortHigh'
  | 'effortXhigh'
  | 'effortMax'
  | 'privacyConfirmedLocal'
  | 'privacyConfirmedLocalHint'
  | 'routeUnconfirmedWarning'
  | 'failurePolicy'
  | 'failurePolicyHint'
  | 'failurePolicyPassthrough'
  | 'failurePolicyBlock'
  | 'summaryPrompt'
  | 'admissionPrompt'
  | 'privacyPrompt'
  | 'promptHint'
  | 'saveGroup'
  | 'resetGroup'
  | 'modelSourceHint'
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
  privacyGateHint: '开启后每个标准工具结果先经所选模型判断；默认关闭。',
  debug: 'debug 记录',
  debugHint: '开启后向下面的日志路径追加 metadata 记录；关闭时不写盘。',
  dryRun: '干跑',
  dryRunHint: '开启后走完整流水线但只写诊断记录：不替换内容、不写会话事件、不调用存储、不写 memo。需要同时开启 debug 记录并填好日志路径。',
  dryRunInactiveHint: '干跑未生效：debug 记录关闭或日志路径为空，工具结果仍会被照常替换。',
  flowWarning: '摘要与隐私分别把工具正文发送给各自所选 route。',
  modelSourceHint: '模型端点与 API key 不在本卡片：先在「设置 → 模型 → 自定义提供方」建好 route（那里填 baseURL 与 API key，本地服务填它的地址），再在下面按角色选它的 provider 与 model。三个角色可以填同一条。',
  summaryGroup: '摘要模型',
  summaryGroupHint: '把工具结果改写成与当前任务相关的短说明，并留下取回原文的入口。工具结果在之后的每次请求里都要重发，长正文让提示缓存反复失效、token 被反复计费；裁短之后这部分成本随之省下。下面两处设置只做判断，只有这里会替换正文。',
  admissionGroup: '摘要准入判断模型',
  admissionGroupHint: '可以不设置：留空就跟随摘要模型，不用为它单独配一条 route。它的作用是省 token——先用一次不读正文的小判断拦掉不值得摘要的结果，那些结果就不再产生摘要请求的费用。',
  privacyGroup: '隐私闸门模型',
  privacyGroupHint: '判断结果是否涉及隐私或机密：判定敏感就拦下、不进主模型。把它设成本地模型，并在下面勾选确认，敏感内容就不会发往外部网络。',
  diagnosticsGroup: '诊断',
  diagnosticsGroupHint: 'debug 记录与干跑的日志位置；记录 metadata，不含原文、提示词与凭据。',
  routeProvider: 'provider',
  routeProviderHint: '候选是「设置 → 模型」里已配好的 route；端点与 API key 也在那里配。',
  routeModel: 'model',
  routeModelHint: '该 route 的模型；目录外的 id 用「自定义…」手填。',
  routeUnset: '不设置（清空）',
  followSummaryRoute: '跟随摘要模型（清空）',
  customValue: '自定义…',
  pickFromCatalog: '从目录里选',
  notInCatalog: '（不在目录里）',
  admissionProvider: 'provider',
  admissionModel: 'model',
  privacyProvider: 'provider',
  privacyModel: 'model',
  minInlineTokens: '摘要下限（token）',
  minInlineTokensHint: '低于它的结果原样保留；按 token 估算。0 表示不设下限。',
  maxSummarizeTokens: '摘要上限（token）',
  maxSummarizeTokensHint: 'bash 与 web_fetch 达到或超过它的结果交给 spill，read 不受它约束；按 token 估算。',
  reasoningEffort: '推理档位',
  reasoningEffortHint: '默认「不推理」以降低延迟；档位由该 route 声明，不声明时去掉该字段重发一次。',
  effortOff: '不推理',
  effortMinimal: '极低',
  effortLow: '低',
  effortMedium: '中',
  effortHigh: '高',
  effortXhigh: '极高',
  effortMax: '最高',
  privacyConfirmedLocal: '隐私 route 已确认为本地',
  privacyConfirmedLocalHint: '隐私闸门要求你确认这条 route 不会把内容发往外部网络；插件无法自行证明，也不通过 baseURL 猜测。',
  routeUnconfirmedWarning: '隐私闸门已开启，但隐私 route 尚未确认为本地：每个工具结果都会按失败策略处理。确认它是本地 route，或关闭隐私闸门。',
  failurePolicy: '隐私失效的处理策略',
  failurePolicyHint: '判定敏感始终拦截；判断不确定或失败时按这条策略处理。',
  failurePolicyPassthrough: '放行原文',
  failurePolicyBlock: '拦截',
  summaryPrompt: '摘要提示词规则正文',
  admissionPrompt: '准入提示词规则正文',
  privacyPrompt: '隐私提示词规则正文',
  promptHint: '框里是当前生效的规则正文，未改时就是内置默认；改完要点「保存」才写回，没保存就离开不会留下改动；只改规则正文，安全外壳与输出格式由插件固定，不可编辑。',
  saveGroup: '保存',
  resetGroup: '恢复默认',
  debugPath: '调试日志路径',
  debugPathHint: 'metadata JSONL 的写入位置；留空时 debug 不写盘。不会自动改用临时路径。',
  failedHint: '设置未能保存：Host 拒绝了这次写入。若插件刚更新过，重启 DSH 后再试；否则检查该组的取值是否合法。',
}

/** 英文文案。 */
export const en: Record<ResultClipperLocaleKey, string> = {
  tab: 'Result clipper',
  summarize: 'Summarize tool results',
  summarizeHint: 'Only with this on can a tool result be rewritten; while off, results keep the original DSH behavior.',
  admissionJudge: 'Summary admission judge',
  admissionJudgeHint: 'With this on, a result in range first gets a body-free yes/no judgment; off by default.',
  privacyGate: 'Privacy gate',
  privacyGateHint: 'Judges every standard tool result with the selected model before it reaches the model; off by default.',
  debug: 'Debug records',
  debugHint: 'Appends metadata records to the log path below; nothing is written while off.',
  dryRun: 'Dry run',
  dryRunHint: 'Runs the whole pipeline but only writes diagnostics: no replacement, no session events, no storage, no memo. Needs debug records on and a log path filled in.',
  dryRunInactiveHint: 'Dry run is not in effect: debug records are off or the log path is empty, so tool results are still replaced.',
  flowWarning: 'Summarization and the privacy gate each send the tool body to their own selected route.',
  modelSourceHint: 'Model endpoints and API keys are not in this card: create the route first in Settings → Models → custom provider (that is where baseURL and API key go, and where a local server address is entered), then pick its provider and model per role below. All three roles may name the same route.',
  summaryGroup: 'Summary model',
  summaryGroupHint: 'Rewrites a tool result into a short task-relevant note and leaves an entry back to the original. Tool results are resent with every later request, so a long body keeps invalidating the prompt cache and re-billing its tokens; clipping it saves that cost. The two settings below only judge; this is the one that replaces a body.',
  admissionGroup: 'Admission judge model',
  admissionGroupHint: 'Optional: leave it unset to follow the summary model, with no route of its own to configure. It saves tokens — one small body-free judgment first drops the results not worth summarizing, so those never cost a summary request.',
  privacyGroup: 'Privacy gate model',
  privacyGroupHint: 'Decides whether a result touches privacy or secrets: a sensitive verdict is blocked before the main model sees it. Point it at a local model and tick the confirmation below, and sensitive content never leaves this machine.',
  diagnosticsGroup: 'Diagnostics',
  diagnosticsGroupHint: 'Where debug records and dry runs are written; metadata only, never the original text, prompts, or credentials.',
  routeProvider: 'Provider',
  routeProviderHint: 'The options are the routes already configured in Settings → Models; a custom provider\'s baseURL and API key are configured there too.',
  routeModel: 'Model',
  routeModelHint: 'A model of that route; use "Custom…" to type an id outside the catalog.',
  routeUnset: 'Not set (clear)',
  followSummaryRoute: 'Follow the summary model (clear)',
  customValue: 'Custom…',
  pickFromCatalog: 'Pick from the catalog',
  notInCatalog: ' (not in the catalog)',
  admissionProvider: 'Provider',
  admissionModel: 'Model',
  privacyProvider: 'Provider',
  privacyModel: 'Model',
  minInlineTokens: 'Summarize floor (tokens)',
  minInlineTokensHint: 'Results below it are kept as-is; estimated in tokens. 0 removes the floor.',
  maxSummarizeTokens: 'Summarize ceiling (tokens)',
  maxSummarizeTokensHint: 'bash and web_fetch results at or above it go to spill, read is not bound by it; estimated in tokens.',
  reasoningEffort: 'Reasoning effort',
  reasoningEffortHint: '"Off" is the default because it lowers latency; the levels are declared by the route, and the plugin drops the field and retries once when the route rejects it.',
  effortOff: 'Off',
  effortMinimal: 'Minimal',
  effortLow: 'Low',
  effortMedium: 'Medium',
  effortHigh: 'High',
  effortXhigh: 'Extra high',
  effortMax: 'Max',
  privacyConfirmedLocal: 'Confirmed the privacy route is local',
  privacyConfirmedLocalHint: 'The privacy gate needs you to confirm this route never sends content to an external network; the plugin cannot prove it, and does not guess from a baseURL.',
  routeUnconfirmedWarning: 'The privacy gate is on, but the privacy route is not confirmed local: every tool result is handled by the failure policy. Confirm it is a local route, or turn the privacy gate off.',
  failurePolicy: 'Privacy failure policy',
  failurePolicyHint: 'A sensitive verdict is always blocked; an uncertain verdict or a failure follows this policy.',
  failurePolicyPassthrough: 'Pass through',
  failurePolicyBlock: 'Block',
  summaryPrompt: 'Summary prompt rule text',
  admissionPrompt: 'Admission prompt rule text',
  privacyPrompt: 'Privacy prompt rule text',
  promptHint: 'The box holds the rule text in effect (the built-in default until you change it); press Save to write an edit back, leaving without saving keeps it out of the configuration; only the rule text is editable, the safety shell and output format are fixed by the plugin.',
  saveGroup: 'Save',
  resetGroup: 'Reset',
  debugPath: 'Debug log path',
  debugPathHint: 'Where the metadata JSONL is written; an empty path writes nothing. The plugin never falls back to a temporary path.',
  failedHint: 'Not saved: the Host refused this write. If the plugin was just updated, restart DSH and try again; otherwise check the values in this group.',
}
