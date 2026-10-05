/**
 * dsh-result-clipper 的浏览器半：把两项能力开关、摘要准入判断开关、debug 开关与干跑开关注册成「设置 →
 * 内置插件」里的一个页签，并把三个角色（摘要、摘要准入判断、隐私闸门）各自的 route、推理档位与提示词，
 * 以及摘要阈值与 debug 日志路径，注册成包详情页的配置区。
 *
 * 座位分两处的依据是设计文档「配置面与设置座位」：开关在插件页签，参数在包自己的详情页配置区；两处都经
 * `ctx.configForms.get(ns)` 取得同一个 settings 命名空间（命名空间 = profile patch 行的 `id`，本插件的入口
 * `name`，不是包名）。配置区走 `plugins.bundle.config` 而不是 `plugins.item`：本插件按 profile bundle 装载
 * （`dsh.bundle.patch` + `dsh.profile.bundles`），插件管理器给它的卡片是包卡片，而包详情页只渲染按包名索引
 * 的 `plugins.bundle.config`，注册到 `plugins.item` 会得到另一张「官方插件」卡片、包详情页仍是空的。
 *
 * 当前值与写回全走 `ctx.configForms`：`getSnapshot()` 读，配置区用 `mutate(ops)` 把一组的改动作为一次原子写入
 * 提交、页签的开关用 `set(field, value)` 立即写；两者在 Host 拒绝时都**resolve `false`**（不是 reject、也不抛），
 * 所以失败态由控件/分组在 await 之后核验返回值置位。注册包在 `whileServed([...])` 里：宿主从未 serve 该命名
 * 空间的部署不显示这两处，否则会出现没有写入目标的死页。
 *
 * 产物形状（CJS 闭包工厂）与打包步骤见 `scripts/build-client.mjs`；`import type` 一律只进类型图，产物里
 * 除平台模块外没有别的跨包值依赖。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// 类型专用：`ctx.locale` 的 Context 合并与文案字典。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型专用：`ctx.configForms` 的 Context 合并、`ConfigForm` 类型与 `settings.plugins.tab` 槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型专用：`plugins.bundle.config` 槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 类型专用：`ctx.slots` 的 Context 合并（槽位服务由渲染器提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createModelCatalog } from './catalog.ts'
import { ResultClipperCard, type ResultClipperSettingOp } from './card.tsx'
import { en, zh, type ResultClipperLocaleKey } from './locales.ts'
import { ResultClipperTab, type ResultClipperToggle } from './tab.tsx'
import type { ReasoningEffort } from '../reasoning.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本页签与配置区的文案字典。 */
    'resultClipper': ResultClipperLocaleKey
  }
}

/** settings 命名空间 = profile patch 行的 `id`（也是 host 半的入口 `name`）。 */
export const PREFERENCE_NAMESPACE = 'dsh-result-clipper'

/** 本页签在 `settings.plugins.tab` 里的注册 id。 */
const TAB_ID = 'result-clipper'

/** 本页签的排序位。 */
const TAB_ORDER = 30

/**
 * 本插件在 profile 里的包名：`plugins.bundle.config` 是按包名索引的 keyed 槽位，包详情页用
 * `entryKey: pkg.name` 取它，所以这里与 `package.json` 的 `name` 逐字相同。
 */
const BUNDLE_NAME = '@dsh-clipclop/dsh-result-clipper'

/** 本插件在客户端 locale 里的字典命名空间。 */
const LOCALE_NAMESPACE = 'resultClipper'

/** 本命名空间在浏览器侧的形状（只声明本半读到的键）。 */
interface PreferenceSection {
  summarize: boolean
  ruleSummary: boolean
  privacyGate: boolean
  webFetchPrivacyGate: boolean
  admissionJudge: boolean
  debug: boolean
  dryRun: boolean
  debugPath: string
  routeProvider: string
  routeModel: string
  admissionProvider: string
  admissionModel: string
  privacyProvider: string
  privacyModel: string
  minInlineTokens: number
  maxSummarizeTokens: number
  summaryReasoningEffort: ReasoningEffort
  admissionReasoningEffort: ReasoningEffort
  privacyReasoningEffort: ReasoningEffort
  privacyConfirmedLocal: boolean
  failurePolicy: 'passthrough' | 'block'
  summaryPrompt: string
  admissionPrompt: string
  privacyPrompt: string
}

/**
 * 注册这两处所需的客户端服务（host 服务不在其中——它们在 host 半）。
 *
 * `remote` / `remote.session` 只为配置区的 provider 与 model 候选服务：候选取自 `session.modelCatalog()`，
 * 也就是「设置 → 模型」那一页的同一个来源。目录读失败时候选为空、输入框退化成手填，不阻塞配置。
 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

/**
 * 注册页签与包详情页配置区。
 * @param ctx - 客户端插件 context；上面 inject 的服务都已就绪。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-result-clipper: dictionaries')
  // 页签名是 thunk：内置插件那一节每次投影都重读它，所以语言切换不必重新注册。
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const form = ctx.configForms.get<PreferenceSection>(PREFERENCE_NAMESPACE)
  const catalog = createModelCatalog(ctx)
  ctx.effect(() => ctx.configForms.whileServed([PREFERENCE_NAMESPACE], () => ctx.slots.inject(
    'settings.plugins.tab',
    () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: TAB_ID,
      order: TAB_ORDER,
      label: () => t('tab'),
      locale: LOCALE_NAMESPACE,
      inject: () => ({
        hooks: {
          summarize: booleanField(form, 'summarize'),
          privacyGate: booleanField(form, 'privacyGate'),
          debug: booleanField(form, 'debug'),
          dryRun: booleanField(form, 'dryRun'),
          // 干跑生效与否要读日志路径：两者缺一时页签上当场给出提示。
          debugPath: stringField(form, 'debugPath'),
        },
        setToggle: (field: ResultClipperToggle, value: boolean) => form.set(field, value),
      }),
    }, ResultClipperTab),
  )), 'dsh-result-clipper: built-in plugins tab')
  ctx.effect(() => ctx.configForms.whileServed([PREFERENCE_NAMESPACE], () => ctx.slots.inject(
    'plugins.bundle.config',
    () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
      locale: LOCALE_NAMESPACE,
      inject: () => ({
        hooks: {
          summarize: booleanField(form, 'summarize'),
          // 规则摘要开关的默认是**开**：镜像里还没有这个键（老版本存过的 section）时按"照旧摘要"显示。
          ruleSummary: booleanField(form, 'ruleSummary', true),
          privacyGate: booleanField(form, 'privacyGate'),
          webFetchPrivacyGate: booleanField(form, 'webFetchPrivacyGate'),
          privacyConfirmedLocal: booleanField(form, 'privacyConfirmedLocal'),
          failurePolicy: policyField(form),
          routeProvider: stringField(form, 'routeProvider'),
          routeModel: stringField(form, 'routeModel'),
          // 准入判断的启用开关跟着它的 route 与提示词一起在准入组里（勾选＝启用，收起＝不启用）。
          admissionJudge: booleanField(form, 'admissionJudge'),
          admissionProvider: stringField(form, 'admissionProvider'),
          admissionModel: stringField(form, 'admissionModel'),
          privacyProvider: stringField(form, 'privacyProvider'),
          privacyModel: stringField(form, 'privacyModel'),
          minInlineTokens: numberField(form, 'minInlineTokens', 1024),
          maxSummarizeTokens: numberField(form, 'maxSummarizeTokens', 12500),
          summaryReasoningEffort: effortField(form, 'summaryReasoningEffort'),
          admissionReasoningEffort: effortField(form, 'admissionReasoningEffort'),
          privacyReasoningEffort: effortField(form, 'privacyReasoningEffort'),
          summaryPrompt: stringField(form, 'summaryPrompt'),
          admissionPrompt: stringField(form, 'admissionPrompt'),
          privacyPrompt: stringField(form, 'privacyPrompt'),
          debugPath: stringField(form, 'debugPath'),
          modelCatalog: catalog,
        },
        saveFields: (ops: readonly ResultClipperSettingOp[]) => form.mutate(ops),
        refreshModelCatalog: () => { catalog.refresh() },
      }),
    }, ResultClipperCard),
  )), 'dsh-result-clipper: bundle config page')
}

/**
 * 一个布尔字段的读数：镜像还没给出 section 时回落到给定默认。
 * @param form - 本插件的 settings 表单。
 * @param field - 字段名。
 * @param fallback - section 缺席时的取值。
 * @returns 供控件绑定的读数。
 */
function booleanField(
  form: ConfigForm<PreferenceSection>,
  field: 'summarize' | 'ruleSummary' | 'privacyGate' | 'webFetchPrivacyGate' | 'admissionJudge' | 'debug' | 'dryRun' | 'privacyConfirmedLocal',
  fallback = false,
): ObservableSnapshot<boolean> {
  return {
    getSnapshot: () => form.getSnapshot().value?.[field] ?? fallback,
    subscribe: (listener) => form.subscribe(listener),
  }
}

/**
 * 一个字符串字段的读数：镜像还没给出 section 时回落到空串。
 * @param form - 本插件的 settings 表单。
 * @param field - 字段名。
 * @returns 供控件绑定的读数。
 */
function stringField(
  form: ConfigForm<PreferenceSection>,
  field: 'debugPath' | 'routeProvider' | 'routeModel' | 'summaryPrompt'
    | 'admissionProvider' | 'admissionModel' | 'admissionPrompt'
    | 'privacyProvider' | 'privacyModel' | 'privacyPrompt',
): ObservableSnapshot<string> {
  return {
    getSnapshot: () => form.getSnapshot().value?.[field] ?? '',
    subscribe: (listener) => form.subscribe(listener),
  }
}

/**
 * 一个推理档位字段的读数：镜像还没给出 section 时回落到 schema 的默认（不推理）。
 * @param form - 本插件的 settings 表单。
 * @param field - 字段名。
 * @returns 供控件绑定的读数。
 */
function effortField(
  form: ConfigForm<PreferenceSection>,
  field: 'summaryReasoningEffort' | 'admissionReasoningEffort' | 'privacyReasoningEffort',
): ObservableSnapshot<ReasoningEffort> {
  return {
    getSnapshot: () => form.getSnapshot().value?.[field] ?? 'off',
    subscribe: (listener) => form.subscribe(listener),
  }
}

/**
 * 隐私失败策略字段的读数：镜像还没给出 section 时回落到 schema 的默认（放行原文）。
 * @param form - 本插件的 settings 表单。
 * @returns 供控件绑定的读数。
 */
function policyField(form: ConfigForm<PreferenceSection>): ObservableSnapshot<'passthrough' | 'block'> {
  return {
    getSnapshot: () => form.getSnapshot().value?.failurePolicy ?? 'passthrough',
    subscribe: (listener) => form.subscribe(listener),
  }
}

/**
 * 一个数字字段的读数：镜像还没给出 section 时回落到 schema 的默认。
 * @param form - 本插件的 settings 表单。
 * @param field - 字段名。
 * @param fallback - section 缺席时的取值（与 host 半 schema 的默认一致）。
 * @returns 供控件绑定的读数。
 */
function numberField(
  form: ConfigForm<PreferenceSection>,
  field: 'minInlineTokens' | 'maxSummarizeTokens',
  fallback: number,
): ObservableSnapshot<number> {
  return {
    getSnapshot: () => form.getSnapshot().value?.[field] ?? fallback,
    subscribe: (listener) => form.subscribe(listener),
  }
}
