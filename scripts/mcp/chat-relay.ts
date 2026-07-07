/**
 * Chat relay — in-memory message queue bridging the CMS chat panel and Cascade.
 *
 * The CMS chat panel POSTs messages here when "IDE Cascade" toggle is ON.
 * Cascade polls for messages via the get_cms_chat_messages MCP tool.
 * Responses are pushed back via send_cms_chat_response MCP tool and
 * streamed to the CMS via SSE.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { logHop, setTraceLogger } from './trace'

const LOG_PATH = resolve(process.cwd(), 'mcp-server.log')
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try { appendFileSync(LOG_PATH, line) } catch { /* ignore */ }
  console.error(...args)
}
setTraceLogger(log)

interface PendingMessage {
  id: string
  text: string
  timestamp: number
}

interface RelayResponse {
  messageId: string
  text: string
  thinking?: string
  toolCalls?: Array<{ toolName: string; input: unknown; result?: unknown }>
  searchCalls?: Array<{ toolName: string; input: unknown }>
  timestamp: number
}

interface PendingToolCall {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ChatRelayQueue {
  private pending: PendingMessage[] = []
  private responses = new Map<string, RelayResponse[]>()
  private sseControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  private closedMessages = new Set<string>()
  private lastContext = new Map<string, { contextTokens: number; outputTokens?: number; creditCost?: number }>()
  private lastPollTime = 0
  private readonly MCP_SESSION_TIMEOUT_MS = 30_000

  // ── Browser tool-call bridge ──────────────────────────────────────────────
  // When Cascade calls a browser tool via MCP, we push a `toolRequest` frame
  // down the active SSE stream. The browser runs the tool and POSTs the result
  // to /chat/tool-result, which resolves the pending promise.
  private pendingToolCalls = new Map<string, PendingToolCall>()
  private activeMessageId: string | null = null

  /** Track which chat message's SSE stream is active (for routing tool requests). */
  setActiveMessageId(id: string | null): void {
    this.activeMessageId = id
  }

  /** Push a toolRequest to the active SSE stream and await the browser's result. */
  requestBrowserTool(
    name: string,
    args: Record<string, unknown>,
    options?: number | { traceId?: string; timeoutMs?: number },
  ): Promise<unknown> {
    const traceId = typeof options === 'number' ? 'relay' : options?.traceId ?? 'relay'
    const timeoutMs = typeof options === 'number' ? options : options?.timeoutMs ?? 30_000
    logHop(traceId, name, 'chatRelay:requestBrowserTool', 'enter')

    const messageId = this.activeMessageId
    if (!messageId) {
      logHop(traceId, name, 'chatRelay:requestBrowserTool', 'error', 0, 'no active message')
      return Promise.reject(
        new Error('No active chat stream — open the CMS chat panel before using browser tools'),
      )
    }
    const controller = this.sseControllers.get(messageId)
    if (!controller) {
      logHop(traceId, name, 'chatRelay:requestBrowserTool', 'error', 0, 'no SSE stream')
      return Promise.reject(
        new Error('No SSE stream for active chat message — browser may have disconnected'),
      )
    }

    const toolRequestId = randomUUID()
    const start = Date.now()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(toolRequestId)
        const elapsed = Date.now() - start
        logHop(traceId, name, 'chatRelay:browserToolTimeout', 'timeout', elapsed, `budget ${timeoutMs}ms`)
        log(`[ChatRelay] Browser tool '${name}' (trace ${traceId}) timed out after ${timeoutMs}ms`)
        reject(new Error(`Browser tool '${name}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingToolCalls.set(toolRequestId, { resolve, reject, timer })

      const data = JSON.stringify({
        type: 'toolRequest',
        toolRequestId,
        name,
        args,
        traceId,
      })
      log(`[ChatRelay] Sending toolRequest to browser: ${name} (id=${toolRequestId}, trace=${traceId})`)
      try {
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      } catch (err) {
        this.pendingToolCalls.delete(toolRequestId)
        clearTimeout(timer)
        logHop(traceId, name, 'chatRelay:enqueue', 'error', Date.now() - start, err instanceof Error ? err.message : String(err))
        reject(new Error(`SSE stream closed while sending tool request '${name}'`))
      }
    }).finally(() => {
      logHop(traceId, name, 'chatRelay:requestBrowserTool', 'exit', Date.now() - start)
    })
  }

  /** True when a browser tool is currently waiting for the CMS panel to POST a result. */
  hasPendingBrowserToolCalls(): boolean {
    return this.pendingToolCalls.size > 0
  }

  /** Abort all pending browser tool calls — used when the user stops the turn. */
  rejectPendingBrowserToolCalls(reason = 'Aborted by user'): void {
    for (const [id, pending] of this.pendingToolCalls) {
      clearTimeout(pending.timer)
      this.pendingToolCalls.delete(id)
      pending.reject(new Error(reason))
    }
  }

  /** Called by /chat/tool-result endpoint — resolves a pending tool call. */
  resolveToolCall(toolRequestId: string, result: unknown, error?: string): void {
    const pending = this.pendingToolCalls.get(toolRequestId)
    if (!pending) {
      log(`[ChatRelay] tool-result for unknown id=${toolRequestId} (already resolved or timed out)`)
      return
    }
    this.pendingToolCalls.delete(toolRequestId)
    clearTimeout(pending.timer)
    if (error) {
      log(`[ChatRelay] tool-result error for id=${toolRequestId}: ${error}`)
      pending.reject(new Error(error))
    } else {
      log(`[ChatRelay] tool-result received for id=${toolRequestId}`)
      pending.resolve(result)
    }
  }

  /** Called when Cascade polls get_cms_chat_messages via MCP. */
  markPoll(): void {
    this.lastPollTime = Date.now()
  }

  /** True if Cascade in the IDE has polled within the last 30s. */
  isMcpSessionActive(): boolean {
    return Date.now() - this.lastPollTime < this.MCP_SESSION_TIMEOUT_MS
  }

  enqueueMessage(text: string): PendingMessage {
    const msg: PendingMessage = {
      id: randomUUID(),
      text,
      timestamp: Date.now(),
    }
    this.pending.push(msg)
    log(`[ChatRelay] Message queued: ${msg.id} (${text.slice(0, 50)}...)`)
    return msg
  }

  dequeueMessages(): PendingMessage[] {
    const msgs = this.pending
    this.pending = []
    return msgs
  }

  enqueueResponse(
    messageId: string,
    text: string,
    toolCalls?: RelayResponse['toolCalls'],
    thinking?: string,
    searchCalls?: RelayResponse['searchCalls'],
  ): void {
    const response: RelayResponse = {
      messageId,
      text,
      thinking,
      toolCalls,
      searchCalls,
      timestamp: Date.now(),
    }
    const existing = this.responses.get(messageId) ?? []
    existing.push(response)
    this.responses.set(messageId, existing)

    // Push to SSE stream if one exists for this message
    const controller = this.sseControllers.get(messageId)
    if (controller) {
      if (thinking) {
        const thinkData = JSON.stringify({
          type: 'thinking',
          text: thinking,
          timestamp: response.timestamp,
        })
        log(`[ChatRelay] SSE push to ${messageId}: thinking=${thinking.slice(0, 80)}...`)
        controller.enqueue(new TextEncoder().encode(`data: ${thinkData}\n\n`))
      }
      if (searchCalls && searchCalls.length > 0) {
        const searchData = JSON.stringify({
          type: 'search',
          searchCalls,
          timestamp: response.timestamp,
        })
        log(`[ChatRelay] SSE push to ${messageId}: searchCalls=${searchCalls.length}`)
        controller.enqueue(new TextEncoder().encode(`data: ${searchData}\n\n`))
      }
      if (text || thinking || (toolCalls && toolCalls.length > 0) || (searchCalls && searchCalls.length > 0)) {
        const data = JSON.stringify({
          type: 'response',
          text,
          toolCalls,
          thinking,
          searchCalls,
          timestamp: response.timestamp,
        })
        log(`[ChatRelay] SSE push to ${messageId}: text=${text ? text.slice(0, 80) : '[none]'} tools=${toolCalls?.length ?? 0} search=${searchCalls?.length ?? 0}`)
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      } else {
        log(`[ChatRelay] SSE push to ${messageId}: response frame skipped (empty)`)
      }
    } else {
      log(`[ChatRelay] No SSE stream for ${messageId} — response buffered`)
    }
  }

  registerSSEStream(messageId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.sseControllers.set(messageId, controller)

    // Send the latest context value if we already have one, so the panel
    // doesn't stay stale until the next poll cycle.
    this.emitContext(messageId)

    // Send any already-queued responses
    const existing = this.responses.get(messageId) ?? []
    for (const resp of existing) {
      if (resp.thinking) {
        const thinkData = JSON.stringify({
          type: 'thinking',
          text: resp.thinking,
          timestamp: resp.timestamp,
        })
        controller.enqueue(new TextEncoder().encode(`data: ${thinkData}\n\n`))
      }
      if (resp.searchCalls && resp.searchCalls.length > 0) {
        const searchData = JSON.stringify({
          type: 'search',
          searchCalls: resp.searchCalls,
          timestamp: resp.timestamp,
        })
        controller.enqueue(new TextEncoder().encode(`data: ${searchData}\n\n`))
      }
      if (resp.text || resp.thinking || (resp.toolCalls && resp.toolCalls.length > 0) || (resp.searchCalls && resp.searchCalls.length > 0)) {
        const data = JSON.stringify({
          type: 'response',
          text: resp.text,
          toolCalls: resp.toolCalls,
          thinking: resp.thinking,
          searchCalls: resp.searchCalls,
          timestamp: resp.timestamp,
        })
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      }
    }

    // If the relay already finished this message before the CMS stream opened,
    // flush and close immediately so the client is not stuck waiting.
    if (this.closedMessages.has(messageId)) {
      const done = JSON.stringify({ type: 'done' })
      controller.enqueue(new TextEncoder().encode(`data: ${done}\n\n`))
      controller.close()
      this.sseControllers.delete(messageId)
    }
  }

  unregisterSSEStream(messageId: string): void {
    this.sseControllers.delete(messageId)
  }

  closeStream(messageId: string): void {
    this.closedMessages.add(messageId)
    this.lastContext.delete(messageId)
    const controller = this.sseControllers.get(messageId)
    if (controller) {
      try {
        const data = JSON.stringify({ type: 'done' })
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
        controller.close()
      } catch {
        // Stream may already be closed; ignore.
      }
      this.sseControllers.delete(messageId)
    }
  }

  hasPending(): boolean {
    return this.pending.length > 0
  }

  hasResponse(messageId: string): boolean {
    return (this.responses.get(messageId)?.length ?? 0) > 0
  }

  enqueueContext(messageId: string, contextTokens: number, outputTokens?: number, creditCost?: number): void {
    this.lastContext.set(messageId, { contextTokens, outputTokens, creditCost })
    const controller = this.sseControllers.get(messageId)
    if (controller) {
      const data = JSON.stringify({ type: 'context', contextTokens, outputTokens, creditCost, timestamp: Date.now() })
      log(`[ChatRelay] SSE push to ${messageId}: context=${contextTokens} output=${outputTokens ?? 0} credits=${creditCost ?? 0}`)
      try {
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      } catch { /* stream may be closed */ }
    }
  }

  private emitContext(messageId: string): void {
    const ctx = this.lastContext.get(messageId)
    const controller = this.sseControllers.get(messageId)
    if (ctx && controller) {
      const data = JSON.stringify({ type: 'context', ...ctx, timestamp: Date.now() })
      try {
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      } catch { /* stream may be closed */ }
    }
  }
}

export const chatRelay = new ChatRelayQueue()
