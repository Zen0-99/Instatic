/**
 * Chat relay queue tests — validate concurrent dispatch, timeouts, and
 * out-of-order resolution that the production MCP server depends on.
 */

import { describe, it, expect } from 'bun:test'
import { ChatRelayQueue } from '../chat-relay'

function makeRelay() {
  return new ChatRelayQueue()
}

/** Minimal mock of an SSE controller — only needs enqueue(). */
function mockController(): any {
  const chunks: Uint8Array[] = []
  return {
    enqueue(chunk: Uint8Array) { chunks.push(chunk) },
    close() {},
    _chunks: chunks,
  }
}

// ---------------------------------------------------------------------------
// Tool request / resolve
// ---------------------------------------------------------------------------

describe('ChatRelayQueue.requestBrowserTool', () => {
  it('resolves when resolveToolCall is invoked with the same id', async () => {
    const relay = makeRelay()
    relay.setActiveMessageId('msg-1')
    ;(relay as any).sseControllers.set('msg-1', mockController())

    const promise = relay.requestBrowserTool('applyCss', { css: '.hero { color: red; }' })
    const toolRequestId = [...(relay as any).pendingToolCalls.keys()][0]
    relay.resolveToolCall(toolRequestId, { cssRulesCreated: 1 })

    const result = await promise
    expect(result).toEqual({ cssRulesCreated: 1 })
  })

  it('rejects after timeout when no result arrives', async () => {
    const relay = makeRelay()
    relay.setActiveMessageId('msg-1')
    ;(relay as any).sseControllers.set('msg-1', mockController())

    await expect(
      relay.requestBrowserTool('applyCss', { css: '.hero { color: red; }' }, 50),
    ).rejects.toThrow(/timed out/)
  })

  it('multiple concurrent tool calls are independent', async () => {
    const relay = makeRelay()
    relay.setActiveMessageId('msg-1')
    ;(relay as any).sseControllers.set('msg-1', mockController())

    const p1 = relay.requestBrowserTool('toolA', {}, 1000)
    const p2 = relay.requestBrowserTool('toolB', {}, 1000)

    const ids = [...(relay as any).pendingToolCalls.keys()]
    expect(ids).toHaveLength(2)

    // Resolve out of order
    relay.resolveToolCall(ids[1], { ok: true })
    relay.resolveToolCall(ids[0], { ok: true })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
  })

  it('rejects when no active message is set', async () => {
    const relay = makeRelay()
    await expect(relay.requestBrowserTool('applyCss', {})).rejects.toThrow(/No active chat stream/)
  })

  it('rejects when no SSE stream exists', async () => {
    const relay = makeRelay()
    relay.setActiveMessageId('msg-1')
    await expect(relay.requestBrowserTool('applyCss', {})).rejects.toThrow(/No SSE stream/)
  })
})

// ---------------------------------------------------------------------------
// Message enqueue / dequeue
// ---------------------------------------------------------------------------

describe('ChatRelayQueue message queue', () => {
  it('queues and dequeues messages', () => {
    const relay = makeRelay()
    const m1 = relay.enqueueMessage('hello')
    const m2 = relay.enqueueMessage('world')

    expect(relay.hasPending()).toBe(true)
    const dequeued = relay.dequeueMessages()
    expect(dequeued).toHaveLength(2)
    expect(dequeued[0].text).toBe('hello')
    expect(dequeued[1].text).toBe('world')
    expect(relay.hasPending()).toBe(false)
  })

  it('dequeue empties the queue', () => {
    const relay = makeRelay()
    relay.enqueueMessage('a')
    relay.enqueueMessage('b')
    relay.dequeueMessages()
    expect(relay.dequeueMessages()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Response buffering and SSE push
// ---------------------------------------------------------------------------

describe('ChatRelayQueue response buffering', () => {
  it('buffers responses when no SSE stream exists', () => {
    const relay = makeRelay()
    relay.enqueueResponse('msg-1', 'hello')
    relay.enqueueResponse('msg-1', 'world')
    expect(relay.hasResponse('msg-1')).toBe(true)
  })

  it('flushes buffered responses when an SSE stream registers', () => {
    const relay = makeRelay()
    relay.enqueueResponse('msg-1', 'hello')

    const ctrl = mockController()
    relay.registerSSEStream('msg-1', ctrl)

    // Should have flushed the buffered response
    expect(ctrl._chunks.length).toBe(1)
    const decoded = new TextDecoder().decode(ctrl._chunks[0])
    expect(decoded).toContain('hello')
  })
})

// ---------------------------------------------------------------------------
// Poll timing
// ---------------------------------------------------------------------------

describe('ChatRelayQueue MCP session', () => {
  it('tracks the last poll time', () => {
    const relay = makeRelay()
    expect(relay.isMcpSessionActive()).toBe(false)
    relay.markPoll()
    expect(relay.isMcpSessionActive()).toBe(true)
  })
})
