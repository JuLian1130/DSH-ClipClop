/**
 * `settings.plugins.tab` 的一页：**只做指路**。
 *
 * 本插件的设置全在包详情页的配置区（`plugins.bundle.config`）——开关与它们要用的 route、提示词、阈值、日志路径
 * 在同一页上。这一页不留任何开关：曾经有过一版在这里放摘要、隐私、debug 与干跑四个开关，问题是它们离开各自的
 * route 或日志路径按不动，用户在这一页上只能看到一个按了没反应的开关，然后自己去找设置在哪。
 *
 * 所以这里只有一句提示：设置在哪、为什么不在这一页。它不注入任何业务面（没有读数、没有写入路径），页签名与这
 * 句话都只读 `locale`。
 *
 * 本产物只把 React 与 `dsh-client-ui-primitives` 列为 external（`scripts/build-client.mjs`），没有 CSS 管线，
 * 所以布局用内联样式 + 主题变量。
 *
 * @module
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 渲染机为本页合成的 props：槽位运行面与本插件的文案命名空间（没有任何业务面）。 */
export type ResultClipperTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'resultClipper'>

/** 提示正文的排版：与配置区里的说明同一档字号与颜色。 */
const TEXT_STYLE = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '22px',
  padding: '8px 0',
  maxWidth: 720,
} as const

/**
 * 渲染这一页。
 * @param props - 页面文案。
 * @returns 一句「设置在哪」的提示。
 */
export function ResultClipperTab({ t }: ResultClipperTabProps) {
  return <div>
    <p style={TEXT_STYLE}>{t('tabPointer')}</p>
  </div>
}
