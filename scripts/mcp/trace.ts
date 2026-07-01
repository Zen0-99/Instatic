/**
 * Trace helper — generates correlation ids and logs structured hop enter/exit
 * lines so a stalled tool call is instantly attributable to one hop.
 *
 * Format (single line, easy to grep):
 *   [ISO] TRACE <traceId> | <tool> | <hop> | <phase> | <elapsedMs> | <extra>
 *
 * Used across server.ts, relay-daemon.ts, chat-relay.ts, and
 * browser-side agentSlice.ts (via a shim).
 */

import { randomUUID } from 'node:crypto'

let globalLogFn: (...args: unknown[]) => void = console.error

export function setTraceLogger(fn: (...args: unknown[]) => void): void {
  globalLogFn = fn
}

export function genTraceId(): string {
  return randomUUID().slice(0, 8)
}

export type TracePhase = 'enter' | 'exit' | 'error' | 'timeout' | 'stall'

export function logHop(
  traceId: string,
  tool: string,
  hop: string,
  phase: TracePhase,
  elapsedMs?: number,
  extra?: string,
): void {
  const elapsed = elapsedMs !== undefined ? String(elapsedMs) : '-'
  const extraStr = extra ? ` | ${extra}` : ''
  globalLogFn(`TRACE ${traceId} | ${tool} | ${hop} | ${phase} | ${elapsed}ms${extraStr}`)
}

/**
 * Wrap a promise with a budget. Resolves with the result or rejects with a
 * typed TimeoutError so the caller can distinguish a budget breach from other
 * failures.
 */
export class TimeoutError extends Error {
  constructor(
    readonly traceId: string,
    readonly tool: string,
    readonly hop: string,
    readonly budgetMs: number,
  ) {
    super(`TRACE ${traceId} | ${tool} | ${hop} | timeout | ${budgetMs}ms`)
    this.name = 'TimeoutError'
  }
}

export function withBudget<T>(
  traceId: string,
  tool: string,
  hop: string,
  budgetMs: number,
  promise: Promise<T>,
  onStall?: (elapsedMs: number) => void,
  stallThresholdMs?: number,
): Promise<T> {
  const start = Date.now()
  logHop(traceId, tool, hop, 'enter')

  let stallTimer: ReturnType<typeof setTimeout> | null = null
  if (onStall && stallThresholdMs !== undefined && stallThresholdMs > 0) {
    stallTimer = setTimeout(() => {
      const elapsed = Date.now() - start
      logHop(traceId, tool, hop, 'stall', elapsed, `soft threshold ${stallThresholdMs}ms exceeded`)
      onStall(elapsed)
    }, stallThresholdMs)
  }

  const timeoutPromise = new Promise<T>((_, reject) => {
    setTimeout(() => {
      if (stallTimer) clearTimeout(stallTimer)
      reject(new TimeoutError(traceId, tool, hop, budgetMs))
    }, budgetMs)
  })

  return Promise.race([promise, timeoutPromise]).then(
    (result) => {
      if (stallTimer) clearTimeout(stallTimer)
      logHop(traceId, tool, hop, 'exit', Date.now() - start)
      return result
    },
    (err) => {
      if (stallTimer) clearTimeout(stallTimer)
      const elapsed = Date.now() - start
      if (err instanceof TimeoutError) {
        logHop(traceId, tool, hop, 'timeout', elapsed, `budget ${budgetMs}ms`)
      } else {
        logHop(traceId, tool, hop, 'error', elapsed, err instanceof Error ? err.message : String(err))
      }
      throw err
    },
  )
}
