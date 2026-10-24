/**
 * 通道页的文案：设置页里「决策通道」那一页的标题、三处设置与说明。
 *
 * 页面上每一句都是给使用者看的：只说「按自己的需求该怎么设」与「改了会怎样」。所以这里不出现本包的参数名
 * （`target`／`guidance`／`threshold`）、不出现请求形状与机制名（工具、技能、`decisions` 层），也不点名任何
 * 具体的决策模型或部署方式——那些字样对换一个环境的读者只是噪音，理由留在设计文档里。
 *
 * 只有一句是实现事实：四项都是每次调用现读，所以「改完马上生效」。
 *
 * @module
 */

/** 本命名空间的文案键。 */
export type ChannelLocaleKey =
  | 'tab'
  | 'title'
  | 'intro'
  | 'live'
  | 'enable'
  | 'switchOn'
  | 'switchHint'
  | 'switchPick'
  | 'target'
  | 'targetHint'
  | 'unset'
  | 'noEntries'
  | 'guidance'
  | 'guidanceTool'
  | 'guidanceContext'
  | 'threshold'
  | 'thresholdOn'
  | 'thresholdValue'
  | 'thresholdHint'
  | 'thresholdInvalid'
  | 'saveFailed'

/** 中文文案。 */
export const zh: Record<ChannelLocaleKey, string> = {
  tab: '决策通道',
  title: '决策通道',
  intro: '需要判断、选择或评分时，把这一层交给决策模型，而不是让主模型自己拿主意。',
  live: '改动马上生效，不用重载插件。',
  enable: '总开关',
  switchOn: '打开',
  switchHint: '关掉时，主模型不会把判断、选择或评分交给决策模型，下面的设置也不起作用。',
  switchPick: '先在上面选一个当前应用的决策模型，再打开。',
  target: '当前应用的决策模型',
  targetHint: '只对决策通道这一层有效，不是全局开关：别的插件各自指名自己的决策模型，不受这里影响。',
  unset: '选一个决策模型',
  noEntries: '还没有可选的决策模型，先到「决策模型」页登记一个',
  guidance: '引导',
  guidanceTool: '按需：需要判断时才交给决策模型',
  guidanceContext: '更主动：另外常驻提醒主模型，拿不准就先问',
  threshold: '可信度门槛',
  thresholdOn: '开启',
  thresholdValue: '低于这个数就标成「拿不准」',
  thresholdHint: '各个决策模型自报可信度的算法不同，同一个数值在它们之间松紧不同：换一个模型可能要重新调。低于门槛的题会标成「拿不准」，答案与概率照样交回。',
  thresholdInvalid: '门槛要填 0 到 1 之间的数。',
  saveFailed: '这次改动没有被接受，没有生效。',
}

/** 英文文案。 */
export const en: Record<ChannelLocaleKey, string> = {
  tab: 'Decision channel',
  title: 'Decision channel',
  intro: 'Hand a judgement, a choice, or a score to a decision model instead of letting the main model decide on its own.',
  live: 'Changes take effect immediately; no reload needed.',
  enable: 'Switch',
  switchOn: 'On',
  switchHint: 'When off, the main model does not hand a judgement, a choice, or a score to the decision model, and the settings below do nothing.',
  switchPick: 'Pick a decision model above first, then switch this on.',
  target: 'Decision model in use',
  targetHint: 'Applies to this decision channel only, not globally: other plugins name their own decision model and are unaffected.',
  unset: 'Choose a decision model',
  noEntries: 'No decision model to choose yet. Add one on the "Decision models" page first.',
  guidance: 'Guidance',
  guidanceTool: 'On demand: only when a judgement is needed',
  guidanceContext: 'More assertive: also keep reminding the main model to ask before deciding',
  threshold: 'Confidence cut-off',
  thresholdOn: 'On',
  thresholdValue: 'Mark as unsure below',
  thresholdHint: 'Each decision model reports confidence its own way, so the same number is looser or tighter on another model: switching models may need a new one. Questions below the cut-off are marked unsure; the answer and its probability still come back.',
  thresholdInvalid: 'Enter a number between 0 and 1.',
  saveFailed: 'This change was not accepted; nothing changed.',
}
