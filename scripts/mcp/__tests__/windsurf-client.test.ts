/**
 * WindsurfClient serialization test.
 *
 * Validates that two concurrent sendAndAwait calls are queued rather than
 * racing on shared cascadeId / lastStepOffset state.
 */

import { describe, it, expect } from 'bun:test'
import { WindsurfClient } from '../windsurf-client'
import type { CascadeResponse } from '../windsurf-client'

class TestableWindsurfClient extends WindsurfClient {
  private startCascadeCount = 0

  get startCascadeCalls(): number {
    return this.startCascadeCount
  }

  override async connect(): Promise<boolean> {
    (this as any).info = { port: 0, csrfToken: 'test' }
    return true
  }

  override isConnected(): boolean {
    return true
  }

  override async startCascade(conversationId: string): Promise<string> {
    // Add a small async hop so the await definitely yields, letting a
    // concurrent (un-queued) caller sneak in and also call startCascade.
    await new Promise((r) => setTimeout(r, 10))
    this.startCascadeCount++
    ;(this as any).conversationCascadeIds.set(conversationId, 'test-cascade-id')
    return 'test-cascade-id'
  }

  override async sendMessage(): Promise<void> {
    // no-op
  }

  override async pollTranscript(): Promise<{
    steps: { index: number; type: number; status: number; thinking: string | null; response: string | null; toolCalls: Array<{ toolName: string; input: unknown }>; searchCalls: Array<{ toolName: string; input: unknown }> }[]
    done: boolean
    nextOffset: number
    hasToolSteps: boolean
    stepTypes: number[]
    statuses: number[]
    lastStepType: number
    lastStatus: number
  }> {
    return { steps: [], done: true, nextOffset: 0, hasToolSteps: false, stepTypes: [], statuses: [], lastStepType: -1, lastStatus: -1 }
  }
}

// ---------------------------------------------------------------------------

describe('WindsurfClient.sendQueue', () => {
  it('serializes concurrent sendAndAwait calls — only one cascade is started', async () => {
    const client = new TestableWindsurfClient()
    await client.connect()

    // Start two calls concurrently with attachToActive=true (default).
    // Without the queue both would race into startCascade simultaneously.
    const p1 = client.sendAndAwait('conv-1', 'first message', { pollIntervalMs: 0 })
    const p2 = client.sendAndAwait('conv-1', 'second message', { pollIntervalMs: 0 })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.completed).toBe(true)
    expect(r2.completed).toBe(true)

    // Because the calls were queued, the second message reused the same
    // cascadeId instead of starting a new one.
    const testClient = client as unknown as TestableWindsurfClient
    expect(testClient.startCascadeCalls).toBe(1)
  })
})
