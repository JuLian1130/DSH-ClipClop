/** 浏览器半自己持有的文案：内置插件页的页签名与页内文案。 */

/** 本命名空间的文案键。 */
export type ReasoningPrunerLocaleKey = 'tab' | 'title' | 'description' | 'disabledHint' | 'failedHint'

/** 中文文案。 */
export const zh: Record<ReasoningPrunerLocaleKey, string> = {
  tab: '推理裁剪',
  title: '历史推理裁剪',
  description: '控制手动入口 /prune-reasoning 是否可用；自动裁剪不受这个开关影响。',
  disabledHint: '当前模型路由无法从推理裁剪中受益。',
  failedHint: '推理裁剪偏好未能保存。',
}

/** 英文文案。 */
export const en: Record<ReasoningPrunerLocaleKey, string> = {
  tab: 'Reasoning pruning',
  title: 'Prune historical reasoning',
  description: 'Control whether the manual /prune-reasoning entry is available; automatic pruning is unaffected.',
  disabledHint: 'The current model route cannot benefit from reasoning pruning.',
  failedHint: 'The reasoning pruning preference was not saved.',
}
