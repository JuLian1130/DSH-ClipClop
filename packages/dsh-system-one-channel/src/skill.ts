/**
 * 通道的技能正文。
 *
 * 技能随包交付、登记进 DSH 的技能注册表：正文讲「什么时候该用、什么时候是类别错误」，模型按需加载。
 * 与工具描述的分工是——工具描述在每次请求里都在，所以只写最短的用法；这里写细则。
 *
 * @module
 */

/** 技能名：模型看到的目录按它排序，工具名是 `systemone_ask`。 */
export const SKILL_NAME = 'systemone'

/** 目录里的一句话路由说明。 */
export const SKILL_DESCRIPTION = 'Ask a configured decision model for a typed judgement with probabilities when a decision, a closed choice, or a score matters.'

/** 技能正文。 */
export const SKILL_CONTENT = `# Decision channel

\`systemone_ask\` sends typed questions to a configured decision model and returns answers with probabilities, instead of you writing an opinion. It decides; it does not act.

## When to use it

- A yes/no condition decides what you do next and "probably" is not good enough: whether a diff is safe to apply, whether a test failure is caused by the change, whether a request is in scope.
- The answer must come from a closed set of options, and picking one by feel risks the wrong branch.
- You must rate something on an ordered scale (severity, confidence, priority) and want a number rather than an adjective.
- Two readings are plausible and the tie-break matters enough to spend a round trip on.

## When it is a category error

- You need text, code, a plan, or an explanation back. This channel returns typed answers only; writing is your job.
- The question has no closed answer ("what should I build next?"). Split it into questions that can be answered, or do not ask.
- The answer must be justified to a human with sources. The decision model sees only \`state\`; it knows nothing about this conversation.
- You already know the answer and would only be asking for approval. That is a round trip with no decision in it.
- You want the channel to act on the answer. It never changes files or runs commands.

## How to ask

- One judgement per question. Do not bundle "is it correct and is it fast" into one.
- \`instructions\` must stand alone: the decision model does not see this conversation, so the question's context belongs there.
- Put the evidence in \`state\`: the relevant diff, snippet, criteria, or options. It is sent verbatim, so trim what does not matter.
- Use stable, descriptive ids (\`tests_failing\`, \`which_parser\`): answers come back keyed by id.
- For a closed choice, list \`options\` in the order a human would read them; the answer names one.
- For a scale, \`levels\` are the labels from low to high; the score comes back as a position on that scale.

## How to read the answers

- \`boolean\`: \`probability\` is how likely the condition is true (0–1).
- \`choice\`: \`choice\` is the selected option; \`probabilities\` may carry the full distribution.
- \`score\`: \`score\` is a fractional position where 0 is the first level.
- A question absent from \`answers\` was not answered. Treat it as unknown, not as "no".
- \`decisions\` appears only when a threshold is configured: \`act\` or \`abstain\`, plus a reason. \`abstain\` means the answer is below the confidence threshold the user set, **not** that the answer is wrong; the answer is still there. Look twice, ask again, or handle the uncertainty explicitly — do not silently drop it.
- Confidence is reported by the provider and defined differently by each provider. Compare it with a threshold; never compare it across entries.
`
