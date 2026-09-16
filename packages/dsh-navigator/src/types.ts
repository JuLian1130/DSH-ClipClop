import z from '@deepseek-ai/schemastery'

/** How the main task behaves while a navigation review is running. */
export type NavigatorMode = 'wait' | 'parallel'

/** What happens when a navigation review cannot produce a valid result. */
export type NavigatorFailurePolicy = 'continue' | 'stop'

/** Configuration for one dsh-navigator installation. */
export interface Config {
  /** Number of completed main-task steps between reviews. */
  triggerEverySteps?: number
  /** Wait for the review before admitting the next main-task step, or continue in parallel. */
  mode?: NavigatorMode
  /** Maximum time allowed for one auxiliary review request. */
  reviewTimeoutMs?: number
  /** Maximum generated tokens allowed for one auxiliary review request. */
  maxOutputTokens?: number
  /** Whether a failed review lets the main task continue or stops it in waiting mode. */
  failurePolicy?: NavigatorFailurePolicy
  /** Prompt instructions added to the fixed structured-output request. */
  prompt?: string
}

/** Validated navigator configuration schema: every field is optional on input, resolved to its default. */
export const Config: z<Config, Required<Config>> = z.object({
  triggerEverySteps: z.number().step(1).min(1).default(50),
  mode: z.union([z.const('wait'), z.const('parallel')]).default('wait'),
  reviewTimeoutMs: z.number().step(1).min(1).default(120_000),
  maxOutputTokens: z.number().step(1).min(1).default(4096),
  failurePolicy: z.union([z.const('continue'), z.const('stop')]).default('continue'),
  prompt: z.string().default(''),
})

/** Structured conclusions accepted from an auxiliary navigation review. */
export type NavigatorVerdict = 'continue' | 'adjust' | 'stop'
