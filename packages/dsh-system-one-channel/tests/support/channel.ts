/**
 * 票据 05 的夹具：一个进程内的假 provider、一个装着真实接缝的 context。
 *
 * 接缝取真实的 `ctx.tools`、`ctx.systemPrompt`、`ctx.skills` 与接入层服务（票面的「工具面」「技能注册表」
 * 两个接缝），只把**决策模型的实现**换成假的——那才是这一票要验的边界之外的东西。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SystemOneProvider, type ProviderRequest, type ProviderResponse } from '@dsh-clipclop/dsh-system-one'
import * as SystemOne from '@dsh-clipclop/dsh-system-one'
import * as Channel from '../../src/index.ts'

/** 一个条目 id；通道配置的 `target` 指它。 */
export const TARGET = 'local'

/** 假 provider：记下收到的请求，按构造时给的函数回应。 */
export class StubProvider extends SystemOneProvider {
  readonly requests: ProviderRequest[] = []

  constructor(private readonly respond: (request: ProviderRequest) => ProviderResponse = () => ({ answers: {} })) {
    super()
  }

  override evaluate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request)
    return Promise.resolve(this.respond(request))
  }
}

/** 装载选项。 */
export interface MountOptions {
  /** 通道的配置（patch 里的原始形状）。 */
  channel?: object
  /** 假 provider 的回应；省略即「一题都没答」。 */
  respond?: (request: ProviderRequest) => ProviderResponse
  /** 是否组合技能子系统（它是可选依赖）。 */
  skills?: boolean
}

/**
 * 装齐接缝、注册假 provider、再装通道插件。
 * @param options - 装载选项。
 * @returns context、通道的 fiber、装载失败的原因（成功时为 `undefined`）与假 provider。
 */
export async function mount(options: MountOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  if (options.skills === true) await ctx.plugin(SkillRegistry)
  await ctx.plugin(SystemOne)
  const provider = new StubProvider(options.respond)
  ctx.systemOne.register(TARGET, provider)
  const fiber = ctx.plugin(Channel, options.channel as never)
  const error = await fiber.then(() => undefined, (reason: unknown) => reason)
  return { ctx, fiber, error, provider }
}

/** 技能注册表；没组合技能子系统时为空。 */
export function skills(ctx: Context): { list(options?: unknown): Promise<Array<{ name: string }>> } {
  const registry = ctx.get('skills') as { list(options?: unknown): Promise<Array<{ name: string }>> } | undefined
  if (registry === undefined) throw new Error('the skills subsystem is not mounted')
  return registry
}

/** 当前注册的工具定义；开关关着时是 `undefined`。 */
export function tool(ctx: Context) {
  return ctx.tools.get(Channel.TOOL_NAME)
}

/**
 * 调一次工具。
 * @param ctx - 装着通道插件的 context。
 * @param args - 模型给的参数（`defineTool` 会先校验）。
 * @param signal - 执行上下文的取消信号；省略即一个不取消的信号。
 * @returns 工具交回的规范值。
 */
export async function callTool(
  ctx: Context,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  const definition = tool(ctx)
  if (definition === undefined) throw new Error('systemone_ask is not registered')
  // 工具体只读 `signal`；其余字段（callId、agent、token…）是执行器的账，夹具不需要编。
  const exec = { signal } as unknown as ToolRunContext
  return definition.execute(args, exec)
}

/**
 * 当前系统提示的正文。
 * @param ctx - 装着通道插件的 context。
 * @returns 装配并渲染后的提示文本。
 */
export async function prompt(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble())
}

/** 一题是非题的题面（工具参数里的形状）。 */
export const BOOLEAN_QUESTION = { id: 'ok', type: 'boolean', instructions: 'Is this change safe to apply?' } as const

/** 交给工具的 `state`：原样透传的那一份。 */
export const STATE = { diff: '- old\n+ new' }
