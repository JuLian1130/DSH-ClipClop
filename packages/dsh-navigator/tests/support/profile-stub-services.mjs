/**
 * 服务桩：02b 的预构建产物夹具把它作为**绝对路径**条目插进 loader 树，因此 DSH 的 Loader 会经
 * Node 内部 ESM loader 导入它，绕过 vitest 的模块运行器。它不 import 任何东西，也不自己发布观测：
 * `sessionProjections` 桩对象自带 `register` 记录，夹具用 `ctx.get('sessionProjections')` 取回同一个对象。
 */

export const name = 'navigator-profile-stub-services'

/**
 * 按条目配置 provide 服务；缺省提供本插件的三个注入服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 条目自己的 context。
 * @param {{ services?: string[] } | undefined} config - 条目配置。
 */
export function apply(ctx, config) {
  const services = config?.services ?? ['llm', 'sessions', 'sessionProjections']
  if (services.includes('llm')) ctx.provide('llm', { stream: () => {} })
  if (services.includes('sessions')) ctx.provide('sessions', { get: () => {} })
  if (services.includes('sessionProjections')) {
    const registered = []
    ctx.provide('sessionProjections', {
      registered,
      register: (definition) => {
        registered.push(definition.key)
        return () => {}
      },
    })
  }
}
