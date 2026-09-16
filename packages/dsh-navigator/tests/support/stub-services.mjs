/**
 * 三个注入服务的桩：本插件的两套夹具共用一份契约。
 *
 * `llm.stream`、`sessions.get` 是函数，`sessionProjections.register` 按真实签名返回释放回调并记下注册
 * 单元的 `key`。02 的夹具在进程内造服务值（`createStubServices`），02b 的夹具把本文件作为**绝对路径
 * loader 条目**（`apply`）——后者由 DSH 的 Loader 经 Node 内部 ESM loader 导入，所以本文件必须是纯 JS
 * 且不 import 任何东西。
 *
 * @module
 */

/**
 * 造一组服务值；返回值可被用例改写（覆写或删掉其中一项）。
 * @param {readonly string[]} [omit] - 不提供的服务名；缺省全给。
 * @returns 服务值映射与投影注册记录。
 */
export function createStubServices(omit = []) {
  const registered = []
  /** @type {Record<string, unknown>} */
  const services = {}
  if (!omit.includes('llm')) services.llm = { stream: () => {} }
  if (!omit.includes('sessions')) services.sessions = { get: () => {} }
  if (!omit.includes('sessionProjections')) {
    services.sessionProjections = {
      registered,
      register: (/** @type {{ key: string }} */ definition) => {
        registered.push(definition.key)
        return () => {}
      },
    }
  }
  return { services, registered }
}

/** Cordis 插件名。 */
export const name = 'navigator-stub-services'

/**
 * loader 条目形态的桩：按条目配置 `omit` 去掉服务，缺省全给。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 条目自己的 context。
 * @param {{ omit?: readonly string[] } | undefined} config - 条目配置。
 */
export function apply(ctx, config) {
  const { services } = createStubServices(config?.omit)
  for (const [serviceName, value] of Object.entries(services)) ctx.provide(serviceName, value)
}
