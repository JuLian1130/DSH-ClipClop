/**
 * 四个注入服务的桩：本插件的两套夹具共用一份契约。
 *
 * `llm.stream`、`sessions.get` 是函数，`sessionProjections.register` 按真实签名返回释放回调并记下注册
 * 单元的 `key`，`storageDomain.open` 返回一张可用的内存表（04 追加；只让 `apply` 跑完，真实存储栈
 * 见 `loop-fixture`）。02 的夹具在进程内造服务值（`createStubServices`），02b 的夹具把本文件作为
 * **绝对路径 loader 条目**（`apply`）——后者由 DSH 的 Loader 经 Node 内部 ESM loader 导入，所以本文件
 * 必须是纯 JS 且不 import 任何东西。
 *
 * @module
 */

/**
 * 记录域的桩：`open()` 返回一张可用的内存表。只保证 `apply` 能跑完、写入不抛错——域 open / 关闭 /
 * 重开这一串在桩上不成立，也没有 schema 校验与坏记录备份，所以要用原始文档、或要让记录跨重挂载
 * 存活的用例必须换真实存储栈（见 `loop-fixture` 的 `storageRoot`）。
 * @returns 一个 `storageDomain` 服务值。
 */
function createStubStorageDomain() {
  return {
    open: () => {
      /** @type {Map<string, Map<string, unknown>>} */
      const tables = new Map()
      const table = (/** @type {string} */ name) => {
        let rows = tables.get(name)
        if (rows === undefined) {
          rows = new Map()
          tables.set(name, rows)
        }
        const records = rows
        return {
          get: (/** @type {string} */ key) => records.get(key),
          entries: () => records.entries(),
          keys: () => records.keys(),
          get size() { return records.size },
          put: async (/** @type {string} */ key, /** @type {unknown} */ value) => { records.set(key, value) },
          delete: async (/** @type {string} */ key) => records.delete(key),
          update: async (/** @type {string} */ key, /** @type {(current: unknown) => unknown} */ fn) => {
            const next = fn(records.get(key))
            records.set(key, next)
            return next
          },
        }
      }
      return Promise.resolve({ name: 'stub', table, close: async () => {} })
    },
  }
}

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
  if (!omit.includes('storageDomain')) services.storageDomain = createStubStorageDomain()
  return { services, registered }
}

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
