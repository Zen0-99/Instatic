/**
 * Trace helper tests — budget wrapping and structured hop logging.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { genTraceId, withBudget, TimeoutError, logHop, setTraceLogger } from '../trace'

const logs: string[] = []
setTraceLogger((...args: unknown[]) => {
  logs.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
})

beforeEach(() => { logs.length = 0 })

describe('genTraceId', () => {
  it('produces an 8-char hex string', () => {
    const id = genTraceId()
    expect(id).toMatch(/^[a-f0-9]{8}$/)
  })
})

describe('withBudget', () => {
  it('resolves when the promise resolves before the budget', async () => {
    const result = await withBudget('t1', 'tool', 'hop', 1000, Promise.resolve(42))
    expect(result).toBe(42)
    expect(logs.some((l) => l.includes('t1') && l.includes('enter'))).toBe(true)
    expect(logs.some((l) => l.includes('t1') && l.includes('exit'))).toBe(true)
  })

  it('rejects with TimeoutError when the budget is exceeded', async () => {
    await expect(
      withBudget('t2', 'tool', 'hop', 50, new Promise(() => {})),
    ).rejects.toBeInstanceOf(TimeoutError)
    const err = await withBudget('t3', 'tool', 'hop', 50, new Promise(() => {})).catch((e) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    if (err instanceof TimeoutError) {
      expect(err.traceId).toBe('t3')
      expect(err.tool).toBe('tool')
      expect(err.hop).toBe('hop')
    }
  })

  it('calls the stall callback at the soft threshold', async () => {
    let stalledAt = 0
    const promise = withBudget(
      't4',
      'tool',
      'hop',
      200,
      new Promise(() => {}),
      (elapsed) => { stalledAt = elapsed },
      50,
    )
    // Wait for the stall callback to fire
    await new Promise((r) => setTimeout(r, 80))
    expect(stalledAt).toBeGreaterThan(0)
    await expect(promise).rejects.toBeInstanceOf(TimeoutError)
  })

  it('logs error phase when the inner promise rejects', async () => {
    await expect(
      withBudget('t5', 'tool', 'hop', 1000, Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    expect(logs.some((l) => l.includes('t5') && l.includes('error'))).toBe(true)
  })
})

describe('logHop', () => {
  it('emits a structured trace line', () => {
    logHop('abc123', 'insertHtml', 'relay:browser', 'enter')
    expect(logs[0]).toContain('TRACE abc123')
    expect(logs[0]).toContain('insertHtml')
    expect(logs[0]).toContain('relay:browser')
    expect(logs[0]).toContain('enter')
  })
})
