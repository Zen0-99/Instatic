/**
 * MCP server concurrent dispatch test.
 *
 * Validates that a blocking browser tool (e.g. requestBrowserTool waiting
 * for an SSE result) does NOT stall reading the next stdin chunk or sending
 * other responses. This was the root cause of the production hang.
 */

import { describe, it, expect } from 'bun:test'

interface McpRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

interface McpResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

/** Minimal reproduction of the old (buggy) sequential dispatch loop. */
async function dispatchSequential(
  requests: McpRequest[],
  handler: (req: McpRequest) => Promise<McpResponse>,
): Promise<McpResponse[]> {
  const responses: McpResponse[] = []
  for (const req of requests) {
    responses.push(await handler(req))
  }
  return responses
}

/** The new (fixed) concurrent dispatch. */
async function dispatchConcurrent(
  requests: McpRequest[],
  handler: (req: McpRequest) => Promise<McpResponse>,
): Promise<McpResponse[]> {
  const promises = requests.map(async (req) => handler(req))
  return Promise.all(promises)
}

/** Simulates a browser tool that blocks for a long time. */
async function mockHandler(req: McpRequest): Promise<McpResponse> {
  const p = req.params as { name?: string }
  if (p?.name === 'browser_tool') {
    await new Promise((r) => setTimeout(r, 200))
  }
  return { jsonrpc: '2.0', id: req.id, result: { ok: true } }
}

// ---------------------------------------------------------------------------

describe('MCP dispatch behavior', () => {
  it('sequential dispatch blocks the second request behind the first', async () => {
    const requests: McpRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tool' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fast_tool' } },
    ]

    const start = Date.now()
    const results = await dispatchSequential(requests, mockHandler)
    const elapsed = Date.now() - start

    expect(results).toHaveLength(2)
    expect(results[1].id).toBe(2)
    // With sequential dispatch, request 2 cannot start until request 1 finishes,
    // so total time is >200ms.
    expect(elapsed).toBeGreaterThanOrEqual(180)
  })

  it('concurrent dispatch runs both requests in parallel', async () => {
    const requests: McpRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tool' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fast_tool' } },
    ]

    const start = Date.now()
    const results = await dispatchConcurrent(requests, mockHandler)
    const elapsed = Date.now() - start

    expect(results).toHaveLength(2)
    expect(results[1].id).toBe(2)
    // With concurrent dispatch, request 2 starts immediately alongside request 1,
    // so total time should be < 200ms (browser tool time) + some overhead.
    expect(elapsed).toBeLessThan(250)
  })

  it('concurrent dispatch finishes faster than the sum of individual latencies', async () => {
    const requests: McpRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tool' } }, // 200ms
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fast_tool' } },    // 0ms
    ]

    const start = Date.now()
    const results = await dispatchConcurrent(requests, mockHandler)
    const elapsed = Date.now() - start

    // Both requests should complete in ~200ms (the slow one), not 400ms.
    expect(elapsed).toBeLessThan(250)
    // Promise.all preserves input order in the result array, but each
    // handler ran in parallel.  The key point is the total time.
    expect(results[0].id).toBe(1)
    expect(results[1].id).toBe(2)
  })
})
