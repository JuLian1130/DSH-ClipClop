import type { NavigatorMode, NavigatorReviewResult } from './types.ts'

/** Durable diagnostic payload emitted when a review starts. */
export interface NavigatorReviewStartEvent {
  readonly reviewId: string
  readonly triggerStep: number
  readonly mode: NavigatorMode
  readonly messageSeqs: readonly number[]
}

/** Durable diagnostic payload emitted when a review settles. */
export interface NavigatorReviewEndEvent {
  readonly reviewId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly result?: NavigatorReviewResult
  readonly error?: string
  readonly durationMs: number
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'navigator/review-start': NavigatorReviewStartEvent
    'navigator/review-end': NavigatorReviewEndEvent
  }
}
