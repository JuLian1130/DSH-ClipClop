import type { AskRequest, ProviderResponse } from './types.ts'

/** 交给 provider 的那部分请求：没有 `target`，服务已经按它解析过了。 */
export type ProviderRequest = Omit<AskRequest, 'target'>

/**
 * 一个决策模型条目在服务里的实现。
 *
 * 一个实例对一个条目：端点、模型、凭据、超时都由它自己持有（来自装载它的插件配置）。它只负责
 * 「把题面发出去、把答案收回来」——什么时候问、答案不可信时怎么办，是调用方（业务插件）的事。
 */
export abstract class SystemOneProvider {
  /** 回答一批题。分片、并发与重试都在实现内部决定，返回时给出实际请求数。 */
  abstract evaluate(request: ProviderRequest): Promise<ProviderResponse>
}
