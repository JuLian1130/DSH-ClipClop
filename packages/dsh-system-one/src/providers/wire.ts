/**
 * 两个 provider 共用的那一半线上读写：解析凭据、发 JSON 请求、把失败包成 provider 级失败。
 *
 * 端点路径、请求体与响应形状各家不同，由 provider 自己拼；共用的只有这些与形状无关的部分。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '../config.ts'
import type { ProviderRequest } from '../provider.ts'

/**
 * 凭据服务上 provider 用到的那一半：`ctx.credentials.resolve(ref)`。
 *
 * 用结构类型而不是依赖 `@deepseek-ai/dsh-credentials`：这里只调一个方法，加一条依赖不值得；
 * 服务没装载时按 provider 级失败报错，也不会静默当成「没有凭据」。
 */
interface CredentialResolver {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** 报错前缀：每条失败都要点出是哪个条目。 */
export function at(entry: Entry): string {
  return `system-one: entry "${entry.id}"`
}

/**
 * 向条目的端点发一份 JSON 请求并读回响应体。
 * @param path - `baseUrl` 之后的那一段，例如 `/v1/decisions`。
 * @throws 端点不可达、HTTP 非 2xx、响应不是 JSON、凭据解析不到或解析失败——都是 provider 级失败。
 */
export async function postJson(
  entry: Entry,
  ctx: Context,
  path: string,
  body: unknown,
  request: ProviderRequest,
): Promise<unknown> {
  const url = `${entry.baseUrl.replace(/\/+$/, '')}${path}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const apiKey = await resolveApiKey(entry, ctx)
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: requestSignal(request),
    })
  } catch (error) {
    throw new Error(`${at(entry)}: ${(error as Error).message}`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`${at(entry)}: HTTP ${response.status} from ${url}: ${text}`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${at(entry)}: ${url} answered with non-JSON: ${text}`)
  }
}

/** 响应里读一个数字；不是数字就当作没这一项。 */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** 响应里必须有的数字：缺了就按 provider 级失败抛错并点出字段。 */
export function requiredNumber(entry: Entry, value: unknown, id: string, field: string): number {
  if (typeof value !== 'number') throw new Error(`${at(entry)}: question "${id}": the response has no ${field}`)
  return value
}

/** 响应里必须有的字符串：缺了就按 provider 级失败抛错并点出字段。 */
export function requiredString(entry: Entry, value: unknown, id: string, field: string): string {
  if (typeof value !== 'string') throw new Error(`${at(entry)}: question "${id}": the response has no ${field}`)
  return value
}

/** 解析 `apiKeyEnv` 指名的凭据：为空＝不带凭据；解析不到按 provider 级失败抛错。 */
async function resolveApiKey(entry: Entry, ctx: Context): Promise<string | undefined> {
  const ref = entry.apiKeyEnv
  if (!ref) return undefined
  const key = `${at(entry)}: apiKeyEnv "${ref}"`
  // `ctx.get` 取的是**可选**服务：没装凭据子系统的 profile 照常装载，只是真用到凭据时报错，
  // 而不是静默当成「没有凭据」。
  const credentials = ctx.get('credentials') as CredentialResolver | undefined
  if (credentials === undefined) throw new Error(`${key} needs the credentials service, which this profile does not load`)
  let resolved: { value: string } | undefined
  try {
    resolved = await credentials.resolve(ref)
  } catch (error) {
    throw new Error(`${key}: ${(error as Error).message}`)
  }
  if (resolved === undefined) throw new Error(`${key} is not configured`)
  return resolved.value
}

/** 调用方的取消信号与 deadline 合成一个给 `fetch` 的信号。 */
function requestSignal(request: ProviderRequest): AbortSignal | undefined {
  const timeout = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs)
  if (request.signal === undefined) return timeout
  return timeout === undefined ? request.signal : AbortSignal.any([request.signal, timeout])
}
