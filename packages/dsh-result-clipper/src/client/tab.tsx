/**
 * `settings.plugins.tab` 的一页：摘要与隐私两项能力开关、debug 开关与干跑开关。
 *
 * 四个开关都走 `configForms` 的**立即写**（`set`），因为 host 半把它们声明成 `volatile`——保存即生效，不需要
 * 重启。失败形态照框架先例：页内自带 `busy` / `failed` 两态、失败渲染 `role="alert"`；`ConfigForm.set` 在
 * Host 拒绝时 resolve `false`（不是 reject、也不抛），所以失败态必须在 await 之后核验返回值才能置位。
 *
 * 摘要准入判断不在这一页：它是「要先有一条 route 才有意义」的开关，所以跟它的 route 与提示词一起放在包详情页的
 * 准入组里——勾选即启用、收起即不启用，写入走那一组的原子保存。
 *
 * 干跑还要读 debug 开关与日志路径（在包详情页配置区上）：两者缺一干跑不生效，这一行就地显示提示，避免用户以为
 * 自己已经在干跑。
 *
 * 本产物只把 React 与 `dsh-client-ui-primitives` 列为 external（`scripts/build-client.mjs`），没有 CSS 管线，
 * 所以页内布局用内联样式 + 主题变量，而不是 DSH 客户端惯用的 CSS module。
 *
 * @module
 */

import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 本页可写的四个开关字段，与 host 半 `Config` 的字段同名（也是 settings section 里的键）。 */
export type ResultClipperToggle = 'summarize' | 'privacyGate' | 'debug' | 'dryRun'

/** 注册者自己的业务面：四个读数、干跑生效与否要读的日志路径，加一条写入。 */
export interface ResultClipperTabInjected {
  hooks: {
    /** `Config.summarize` 的当前值。 */
    summarize: ObservableSnapshot<boolean>
    /** `Config.privacyGate` 的当前值。 */
    privacyGate: ObservableSnapshot<boolean>
    /** `Config.debug` 的当前值。 */
    debug: ObservableSnapshot<boolean>
    /** `Config.dryRun` 的当前值。 */
    dryRun: ObservableSnapshot<boolean>
    /** `Config.debugPath` 的当前值；干跑要求它非空。 */
    debugPath: ObservableSnapshot<string>
  }
  /**
   * 写回一个开关字段。
   * @param field - 要写的字段。
   * @param value - 用户要的新取值。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  setToggle(field: ResultClipperToggle, value: boolean): Promise<boolean>
}

/** 渲染机为本页合成的 props：槽位运行面、本插件的文案命名空间、注入的业务面。 */
export type ResultClipperTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'resultClipper'>
  & InjectFace<ResultClipperTabInjected>

/** 一行开关的排版。 */
const ROW_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, padding: '12px 0' } as const

/** 行标题的排版。 */
const TITLE_STYLE = { fontSize: 14, lineHeight: '20px' } as const

/** 次要说明文字（描述、失败提示）共用的排版。 */
const HINT_STYLE = { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } as const

/** 一个开关行自己持有的写入状态。 */
interface ToggleRowProps {
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  /** 该开关当下需要一个额外提示时给出的文案（干跑缺 debug 或路径时用它）。 */
  readonly notice?: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => Promise<boolean>
}

/**
 * 渲染一行：文案在左、开关在右，写入失败时在文案下方出现 `role="alert"`。
 * @param props - 该行的文案、当前值与写入动作；`notice` 给出时附带一行提示。
 * @returns 一行开关。
 */
function ToggleRow(props: ToggleRowProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <section style={ROW_STYLE}>
    <div>
      <div style={TITLE_STYLE}>{props.label}</div>
      <div style={HINT_STYLE}>{props.hint}</div>
      {props.notice !== undefined && <div role="alert" style={HINT_STYLE}>{props.notice}</div>}
      {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
    </div>
    <Switch
      checked={props.checked}
      disabled={busy}
      label={props.label}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void props.onChange(next)
          .then((accepted) => { if (!accepted) setFailed(true) })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }}
    />
  </section>
}

/**
 * 渲染这一页。
 * @param props - 注入的读数、写入路径与页面文案。
 * @returns 内置插件里的一个页签内容。
 */
export function ResultClipperTab(
  { useSummarize, usePrivacyGate, useDebug, useDryRun, useDebugPath, setToggle, t }: ResultClipperTabProps,
) {
  const summarize = useSummarize(value => value)
  const privacyGate = usePrivacyGate(value => value)
  const debug = useDebug(value => value)
  const dryRun = useDryRun(value => value)
  const debugPath = useDebugPath(value => value)
  const onChange = (field: ResultClipperToggle) => (next: boolean) => setToggle(field, next)
  // 干跑要求 debug 开关已开启且日志路径已配置；两者缺一时干跑不生效（结果照常被替换），必须当场说出来。
  const inactive = dryRun && (!debug || debugPath === '')
  return <div>
    <ToggleRow label={t('summarize')} hint={t('summarizeHint')} failedHint={t('failedHint')}
      checked={summarize} onChange={onChange('summarize')} />
    <ToggleRow label={t('privacyGate')} hint={t('privacyGateHint')} failedHint={t('failedHint')}
      checked={privacyGate} onChange={onChange('privacyGate')} />
    <ToggleRow label={t('debug')} hint={t('debugHint')} failedHint={t('failedHint')}
      checked={debug} onChange={onChange('debug')} />
    <ToggleRow label={t('dryRun')} hint={t('dryRunHint')} failedHint={t('failedHint')}
      notice={inactive ? t('dryRunInactiveHint') : undefined}
      checked={dryRun} onChange={onChange('dryRun')} />
  </div>
}
