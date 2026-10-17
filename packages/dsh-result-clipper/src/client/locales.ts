/** 浏览器半自己持有的文案：内置插件页签与包详情页配置区的文案。 */

/** 本命名空间的文案键。 */
export type ResultClipperLocaleKey =
  | 'tab'
  | 'tabPointer'
  | 'condense'
  | 'condenseHint'
  | 'condenseByCommand'
  | 'condenseByCommandHint'
  | 'summarize'
  | 'summarizeHint'
  | 'ruleSummary'
  | 'ruleSummaryHint'
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
  | 'effortNoReasoning'
  | 'effortUnsupported'
  | 'effortUnsupportedHint'
  | 'effortNeverSent'
  | 'privacyConfirmedLocal'
  | 'privacyConfirmedLocalHint'
  | 'webFetchPrivacyGate'
  | 'webFetchPrivacyGateHint'
  | 'summarizeOffHint'
  | 'routeUnconfirmedWarning'
  | 'failurePolicy'
  | 'failurePolicyHint'
  | 'failurePolicyPassthrough'
  | 'failurePolicyBlock'
  | 'summaryPrompt'
  | 'summaryPromptInactive'
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
  tabPointer: '本插件的设置都在侧边栏「插件」页里这个插件的详情页：工具结果精简的两个开关，摘要、摘要准入判断与隐私闸门各自的模型、推理档位与提示词，摘要阈值，以及 debug 记录与干跑。',
  condense: '工具结果精简',
  condenseHint: '推荐保持勾选：长命令输出只留判断要用的那部分，省上下文，也不额外发模型请求。不勾时工具结果按原样交给模型。',
  condenseByCommand: '按命令语义精简',
  condenseByCommandHint: '默认勾选：按命令再收窄一次（例如 git diff 的改动视图、按行区间看文件、整份目录列表），只留继续工作要用的部分。它会丢掉一部分内容；不需要就取消勾选。',
  summarize: '工具结果摘要',
  summarizeHint: '允许主模型自主请求摘要（摘要 token 消耗计入摘要模型）。改动对之后新建的会话生效。',
  summarizeOffHint: '摘要关着：主模型不会看到「请求摘要」这项能力。隐私闸门若开着，仍会逐条判断并用它给出的摘要替换正文。',
  ruleSummary: '自动摘要大内容',
  ruleSummaryHint: '勾选会在非主模型主动请求时也尝试摘要大内容。默认不勾：只摘要主模型主动请求的那些结果。',
  admissionJudge: '启用摘要准入判断',
  admissionJudgeHint: '不勾选（默认）就跳过这一步：结果直接去摘要。勾起来才先问一次「值不值得摘要」，不值得的就不再产生摘要请求、省下这部分费用；用哪条模型、哪份规则正文在下面设置，改完要点那一组的「保存」。勾选与否当场生效。',
  privacyGate: '隐私闸门',
  privacyGateHint: '勾选后工具结果先交给所选模型判断是否含隐私或机密；网页抓取默认不过这一关，需要时在下面单独勾；默认不勾。',
  debug: 'debug 记录',
  debugHint: '开启后把每次工具结果的处理记录写到下面的日志路径；关闭时不写盘。',
  dryRun: '干跑',
  dryRunHint: '勾选后完整走一遍处理、但只写诊断记录：不替换正文、不改会话，也不留下别的东西。需要同时开启 debug 记录并填好日志路径。',
  dryRunInactiveHint: '干跑未生效：debug 记录关闭或日志路径为空，工具结果仍会被照常替换。',
  flowWarning: '摘要与隐私会分别把工具正文发送给它们各自所选的模型。',
  modelSourceHint: '模型地址与 API key 不在本卡片：先在「设置 → 模型 → 自定义提供方」建好一条（那里填地址与 API key，本地服务填它的地址），再在下面为摘要、准入判断与隐私闸门各选 provider 与 model；三处可以选同一条。',
  summaryGroup: '摘要模型',
  summaryGroupHint: '主模型不用反复读长正文——节省缓存计费，上下文也更干净，可以提升模型效果。清空等于请求不发，结果原样透传。',
  admissionGroup: '摘要准入判断模型',
  admissionGroupHint: '不值得摘要的结果不会再产生摘要请求，省下这部分 token 费用，强烈建议跟随摘要模型。不启用会直接走摘要模型。',
  privacyGroup: '隐私闸门模型',
  privacyGroupHint: '每条工具结果先判一次，判定敏感就在进主模型之前拦下，敏感内容不会发往外部网络，应该设成本地模型。',
  diagnosticsGroup: '诊断',
  diagnosticsGroupHint: 'debug 记录与干跑的日志位置；只记处理信息，不含原文、提示词与凭据。',
  routeProvider: 'provider',
  routeProviderHint: '候选是「设置 → 模型」里已配好的提供方；地址与 API key 也在那里配。',
  routeModel: 'model',
  routeModelHint: '所选提供方下的模型；目录外的 id 用「自定义…」手填。',
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
  maxSummarizeTokensHint: 'bash、pwsh 与 web_fetch 达到或超过它的结果不摘要，交给 DSH 的超长结果处理（可能只留下其中一部分），read 不受它约束；按 token 估算。',
  reasoningEffort: '推理档位',
  reasoningEffortHint: '建议选「不推理」以提升速度；如果这个模型不能不推理，建议从最低档位开始选。',
  effortNoReasoning: '不推理',
  effortUnsupported: '当前模型未提供推理等级',
  effortUnsupportedHint: '这个模型不提供推理等级选项，这一项对它没有影响。',
  effortNeverSent: '（不会下发）',
  privacyConfirmedLocal: '隐私模型已确认为本地',
  privacyConfirmedLocalHint: '隐私闸门要求你确认所选模型不会把内容发往外部网络；插件无法自行证明，也不从配置的地址猜测。改了这一组的 provider 或 model，这个确认就作废，要重新勾选。',
  webFetchPrivacyGate: 'web_fetch 也过隐私闸门',
  webFetchPrivacyGateHint: '默认不勾：web_fetch 取的多是外网公开信息，不送本地模型判断（它照常走摘要）。取内网地址或含机密页面的部署可以勾上，勾上后它和别的工具一样逐条判断。',
  routeUnconfirmedWarning: '隐私闸门已开启，但隐私模型尚未确认为本地：每个工具结果都会按失败策略处理。确认它是本地模型，或关闭隐私闸门。',
  failurePolicy: '隐私失效的处理策略',
  failurePolicyHint: '判定敏感始终拦截；判断不确定或失败时按这条策略处理。',
  failurePolicyPassthrough: '放行原文',
  failurePolicyBlock: '拦截',
  summaryPrompt: '摘要提示词规则正文',
  summaryPromptInactive: '没勾上面的「自动摘要大内容」时用不到这份规则正文，所以现在不能编辑；勾上它才能改。',
  admissionPrompt: '准入提示词规则正文',
  privacyPrompt: '隐私提示词规则正文',
  promptHint: '框里是当前生效的规则正文，未改时就是内置默认；改完要点「保存」才写回，没保存就离开不会留下改动；只有规则正文能改，其余部分由插件固定。',
  saveGroup: '保存',
  resetGroup: '恢复默认',
  debugPath: '调试日志路径',
  debugPathHint: '处理记录的写入位置；留空时不写任何文件，也不会改写到别处。',
  failedHint: '没有保存成功。若插件刚更新过，重启 DSH 后再试；否则检查这一组的取值是否合法。',
}

/** 英文文案。 */
export const en: Record<ResultClipperLocaleKey, string> = {
  tab: 'Result clipper',
  tabPointer: 'This plugin\'s settings are on its detail page in the Plugins page of the sidebar: the two trim switches, the model, reasoning effort and prompt for summarization, the admission judge and the privacy gate, the summary thresholds, and the debug records and dry run.',
  condense: 'Trim tool results',
  condenseHint: 'Keeping this ticked is recommended: long command output keeps only what is needed to keep working, which saves context without any model request. Unticked, tool results reach the model unchanged.',
  condenseByCommand: 'Trim by command semantics',
  condenseByCommandHint: 'On by default: narrow the output once more per command (a git diff view, a line range of a file, a full directory listing), keeping only what is needed to keep working. It drops some content; untick it if you do not want that.',
  summarize: 'Summarize tool results',
  summarizeHint: 'Lets the main model ask for a summary by itself (the summary tokens are billed to the summary model). The change applies to sessions created afterwards.',
  summarizeOffHint: 'Summarization is off: the main model does not get the option to ask for a summary. A privacy gate that is on still judges every result and replaces a safe one with its summary.',
  ruleSummary: 'Summarize large results automatically',
  ruleSummaryHint: 'Tick to also try summarizing large results the main model did not ask to summarize. Off by default: only what the main model asks for is summarized.',
  admissionJudge: 'Enable the admission judge',
  admissionJudgeHint: 'Unchecked (the default) skips this step: results go straight to summarization. Tick it to ask “is this worth summarizing?” first, so results that are not never cost a summary call; the model and rule text for that question are set below and need that group\'s Save. Ticking itself takes effect at once.',
  privacyGate: 'Privacy gate',
  privacyGateHint: 'When ticked, tool results are judged by the selected model for privacy or secrets; web fetch results skip this check by default — tick the separate option below if you need them judged; off by default.',
  debug: 'Debug records',
  debugHint: 'Writes a record of how each tool result was handled to the log path below; nothing is written while off.',
  dryRun: 'Dry run',
  dryRunHint: 'Runs the whole handling but only writes diagnostics: the body is not replaced, the session is not changed, and nothing else is left behind. Needs debug records on and a log path filled in.',
  dryRunInactiveHint: 'Dry run is not in effect: debug records are off or the log path is empty, so tool results are still replaced.',
  flowWarning: 'Summarization and the privacy gate each send the tool body to the model they have selected.',
  modelSourceHint: 'Model endpoints and API keys are not in this card: create the provider first in Settings → Models → custom provider (that is where the address and API key go, and where a local server address is entered), then pick provider and model below for each of the three: summary, admission judge, privacy gate. All three may name the same one.',
  summaryGroup: 'Summary model',
  summaryGroupHint: 'The main model never has to re-read a long body — that saves cache billing, keeps the context cleaner, and can improve model output. Clearing the route means no request is sent and the tool result is passed through unchanged.',
  admissionGroup: 'Admission judge model',
  admissionGroupHint: 'Results not worth summarizing never cost a summary request, saving those tokens — following the summary model is strongly recommended. While it is off, results go straight to summarization.',
  privacyGroup: 'Privacy gate model',
  privacyGroupHint: 'Every tool result is judged first, and a sensitive verdict is blocked before it reaches the main model; sensitive content never leaves for an external network, so point this at a local model.',
  diagnosticsGroup: 'Diagnostics',
  diagnosticsGroupHint: 'Where debug records and dry runs are written; the records hold processing information only, never the original text, prompts, or credentials.',
  routeProvider: 'Provider',
  routeProviderHint: 'The options are the providers already configured in Settings → Models; a custom provider\'s address and API key are configured there too.',
  routeModel: 'Model',
  routeModelHint: 'A model of the selected provider; use "Custom…" to type an id outside the catalog.',
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
  maxSummarizeTokensHint: 'bash, pwsh and web_fetch results at or above it are not summarized; DSH\'s over-long result handling takes them over (it may keep only part of them), read is not bound by it; estimated in tokens.',
  reasoningEffort: 'Reasoning effort',
  reasoningEffortHint: 'Pick “no reasoning” for speed; if this model cannot turn reasoning off, start from its lowest level.',
  effortNoReasoning: 'No reasoning',
  effortUnsupported: 'This model offers no reasoning levels',
  effortUnsupportedHint: 'This model offers no reasoning levels, so this setting has no effect on it.',
  effortNeverSent: ' (not sent)',
  privacyConfirmedLocal: 'Confirmed the privacy model is local',
  privacyConfirmedLocalHint: 'The privacy gate needs you to confirm the selected model never sends content to an external network; the plugin cannot prove it, and does not guess from a configured address. Changing this group\'s provider or model invalidates the confirmation, so tick it again.',
  webFetchPrivacyGate: 'Send web_fetch results through the privacy gate too',
  webFetchPrivacyGateHint: 'Unticked by default: web_fetch mostly returns public pages, so they skip the local judge (they are still summarized). Tick it when the deployment fetches intranet addresses or confidential pages; web_fetch is then judged like every other tool.',
  routeUnconfirmedWarning: 'The privacy gate is on, but the privacy model is not confirmed local: every tool result is handled by the failure policy. Confirm it is a local model, or turn the privacy gate off.',
  failurePolicy: 'Privacy failure policy',
  failurePolicyHint: 'A sensitive verdict is always blocked; an uncertain verdict or a failure follows this policy.',
  failurePolicyPassthrough: 'Pass through',
  failurePolicyBlock: 'Block',
  summaryPrompt: 'Summary prompt rule text',
  summaryPromptInactive: 'Without “Summarize large results automatically” ticked this rule text is not used, so it cannot be edited yet; tick that box to change it.',
  admissionPrompt: 'Admission prompt rule text',
  privacyPrompt: 'Privacy prompt rule text',
  promptHint: 'The box holds the rule text in effect (the built-in default until you change it); press Save to write an edit back, leaving without saving keeps it out of the configuration; only the rule text is editable, the rest is fixed by the plugin.',
  saveGroup: 'Save',
  resetGroup: 'Reset',
  debugPath: 'Debug log path',
  debugPathHint: 'Where those records go; an empty path writes nothing, and nothing is written elsewhere instead.',
  failedHint: 'Not saved. If the plugin was just updated, restart DSH and try again; otherwise check the values in this group.',
}
