/**
 * Relay Daemon — long-lived HTTP server that owns the Windsurf connection,
 * chat relay, and SSE streams. Survives MCP server restarts.
 *
 * The thin MCP server (server.ts) forwards all tool calls here via HTTP.
 * Windsurf's watchdog restarts only the thin stdio process; this daemon
 * keeps running and preserves active SSE streams + pending tool calls.
 */

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WindsurfClient, CascadeResponse } from './windsurf-client'
import { ChatRelayQueue } from './chat-relay'
import { CmsClient } from './cms-client'
import { executeHttpApiTool } from './http-tools'
import { allTools, toolByName } from './tool-registry'
import { buildInjectedPrompt, buildFollowUpPrompt, classify, getPack, listPackIds } from './injections'
import { logHop, setTraceLogger } from './trace'

// ─── Known Cascade model pricing ────────────────────────────────────────────
// The Windsurf language server does not include per-token pricing in its
// GetUserStatus / cascade_model_config_data response. We merge in known public
// pricing by model UID so the model picker shows real $/1M values instead of
// misleading $0/$0. Models without an entry are treated as free/unknown and
// show no price label.
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Claude Opus family
  'claude-opus-4-8-medium': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7-medium': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-5-fable-medium': { inputPerMTok: 5, outputPerMTok: 25 },
  // Claude Sonnet family
  'claude-sonnet-5-medium': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  // GPT-4.1 / GPT-4o family
  'MODEL_CHAT_GPT_4O_2024_08_06': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'MODEL_CHAT_GPT_4_1_2025_04_14': { inputPerMTok: 2, outputPerMTok: 8 },
  // Gemini family
  'gemini-3-5-flash-medium': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gemini-3-1-pro-low': { inputPerMTok: 1.25, outputPerMTok: 5 },
  'MODEL_GOOGLE_GEMINI_2_5_PRO': { inputPerMTok: 1.25, outputPerMTok: 5 },
  // Grok family
  'MODEL_XAI_GROK_3': { inputPerMTok: 2, outputPerMTok: 10 },
  // DeepSeek family
  'deepseek-v4': { inputPerMTok: 0.27, outputPerMTok: 1.10 },
}

function resolvePricing(modelUid: string): { inputPerMTok: number; outputPerMTok: number } | undefined {
  // Exact match first
  if (MODEL_PRICING[modelUid]) return MODEL_PRICING[modelUid]
  // Prefix/pattern match for variant models (e.g. claude-opus-4-8-high-fast)
  for (const [pattern, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelUid.startsWith(pattern.replace(/-medium$/, '').replace(/-low$/, ''))) return pricing
  }
  return undefined
}

// ─── Buffered response emitter ─────────────────────────────────────────────
// Instead of pushing every tiny delta to the SSE stream immediately, we buffer
// entries and flush in batches every few seconds. This "catch up" approach
// avoids race conditions where we emit partial content and then the step
// mutates before the next poll. By the time we flush, we've already seen the
// next poll's data, so we always send the most complete picture.

class BufferedResponseEmitter {
  private textBuffer = ''
  private thinkingBuffer = ''
  private toolCallBuffer: Array<{ toolName: string; input: unknown; result?: unknown }> = []
  private searchCallBuffer: Array<{ toolName: string; input: unknown }> = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly flushIntervalMs: number
  private readonly messageId: string
  private readonly chatRelay: ChatRelayQueue

  constructor(messageId: string, chatRelay: ChatRelayQueue, flushIntervalMs = 3000) {
    this.messageId = messageId
    this.chatRelay = chatRelay
    this.flushIntervalMs = flushIntervalMs
    this.scheduleFlush()
  }

  push(entry: CascadeResponse): void {
    if (this.closed) return
    if (entry.text) this.textBuffer += entry.text
    if (entry.thinking) this.thinkingBuffer += entry.thinking
    if (entry.toolCalls) {
      // Flush text that arrived before this tool call so the UI shows it in
      // chronological order, then emit the tool call as its own frame.
      this.flush()
      this.toolCallBuffer.push(...entry.toolCalls)
    }
    if (entry.searchCalls) {
      // Same ordering guarantee for search calls.
      this.flush()
      this.searchCallBuffer.push(...entry.searchCalls)
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.closed) return
    this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs)
  }

  flush(): void {
    if (this.closed) return
    if (this.textBuffer || this.thinkingBuffer || this.toolCallBuffer.length > 0 || this.searchCallBuffer.length > 0) {
      this.chatRelay.enqueueResponse(
        this.messageId,
        this.textBuffer,
        this.toolCallBuffer.length > 0 ? this.toolCallBuffer : undefined,
        this.thinkingBuffer || undefined,
        this.searchCallBuffer.length > 0 ? this.searchCallBuffer : undefined,
      )
      this.textBuffer = ''
      this.thinkingBuffer = ''
      this.toolCallBuffer = []
      this.searchCallBuffer = []
    }
    if (!this.closed) this.scheduleFlush()
  }

  close(): void {
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushFinal()
  }

  private flushFinal(): void {
    if (this.textBuffer || this.thinkingBuffer || this.toolCallBuffer.length > 0 || this.searchCallBuffer.length > 0) {
      this.chatRelay.enqueueResponse(
        this.messageId,
        this.textBuffer,
        this.toolCallBuffer.length > 0 ? this.toolCallBuffer : undefined,
        this.thinkingBuffer || undefined,
        this.searchCallBuffer.length > 0 ? this.searchCallBuffer : undefined,
      )
      this.textBuffer = ''
      this.thinkingBuffer = ''
      this.toolCallBuffer = []
      this.searchCallBuffer = []
    }
  }
}

const LOG_PATH = resolve(process.cwd(), 'relay-daemon.log')
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try { appendFileSync(LOG_PATH, line) } catch { /* ignore */ }
  console.error(...args)
}
setTraceLogger(log)

const TOOL_LOG_PATH = resolve(process.cwd(), 'mcp-tools.log')
const TOOL_LOG_VERBOSE = (process.env.INSTATIC_MCP_TOOL_LOG ?? '1') === '1'

function logToolUsage(
  traceId: string,
  name: string,
  phase: 'start' | 'success' | 'error',
  input: Record<string, unknown>,
  result?: unknown,
  error?: string,
): void {
  if (!TOOL_LOG_VERBOSE) return
  const timestamp = new Date().toISOString()
  const entry: Record<string, unknown> = {
    timestamp,
    traceId,
    tool: name,
    phase,
    input,
  }
  if (result !== undefined) {
    entry.result = summarizeForLog(result)
  }
  if (error) {
    entry.error = error
  }
  const line = JSON.stringify(entry) + '\n'
  try { appendFileSync(TOOL_LOG_PATH, line) } catch { /* ignore */ }
  console.error(`[mcp-tool] ${traceId} ${name} ${phase}`)
}

function summarizeForLog(value: unknown, maxChars = 2000): unknown {
  if (value === null || typeof value !== 'object') return value
  const text = JSON.stringify(value)
  if (text.length <= maxChars) return value
  return text.slice(0, maxChars) + '...[truncated]'
}

// ─── Config ────────────────────────────────────────────────────────────────

const CMS_URL = process.env.INSTATIC_CMS_URL ?? 'http://localhost:3001'
const ADMIN_URL = process.env.INSTATIC_ADMIN_URL ?? 'http://localhost:5173'
const ADMIN_EMAIL = process.env.INSTATIC_ADMIN_EMAIL ?? ''
const ADMIN_PASSWORD = process.env.INSTATIC_ADMIN_PASSWORD ?? ''
const MCP_PORT = parseInt(process.env.INSTATIC_MCP_PORT ?? '9876', 10)

// ─── Subsystems ────────────────────────────────────────────────────────────

const cmsClient = new CmsClient(CMS_URL, ADMIN_EMAIL, ADMIN_PASSWORD)
const windsurfClient = new WindsurfClient()
const chatRelay = new ChatRelayQueue()

// ─── Tool execution (server-resident) ──────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  traceId: string,
): Promise<unknown> {
  const tool = toolByName.get(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)

  logHop(traceId, name, 'relay:executeTool', 'enter')
  logToolUsage(traceId, name, 'start', input)
  const start = Date.now()

  try {
    if (tool.execution === 'http-api') {
      const result = await executeHttpApiTool(name, input, cmsClient, traceId)
      logHop(traceId, name, 'relay:http-api', 'exit', Date.now() - start)
      logToolUsage(traceId, name, 'success', input, result)
      return result
    }
    if (tool.execution === 'browser-bridge') {
      const result = await cmsClient.executeBrowserTool(name, input, traceId)
      logHop(traceId, name, 'relay:browser-bridge', 'exit', Date.now() - start)
      logToolUsage(traceId, name, 'success', input, result)
      return result
    }
    if (tool.execution === 'server') {
      // Server-side tools (e.g. cms_render_snapshot) run through the same
      // execute-tool endpoint but do not require a live browser editor.
      const result = await cmsClient.executeBrowserTool(name, input, traceId)
      logHop(traceId, name, 'relay:server', 'exit', Date.now() - start)
      logToolUsage(traceId, name, 'success', input, result)
      return result
    }
    throw new Error(`Unknown execution type: ${tool.execution}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logHop(traceId, name, 'relay:executeTool', 'error', Date.now() - start, message)
    logToolUsage(traceId, name, 'error', input, undefined, message)
    throw err
  }
}

// ─── HTTP Server ───────────────────────────────────────────────────────────

async function startRelayDaemon(): Promise<void> {
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: MCP_PORT,
      idleTimeout: 0,
      async fetch(req) {
      const url = new URL(req.url)

      const isDev = ADMIN_URL.includes('localhost') || ADMIN_URL.includes('127.0.0.1')
      const corsHeaders = {
        'Access-Control-Allow-Origin': isDev ? '*' : ADMIN_URL,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }

      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders })
      }

      // POST /chat/message — receive a chat message from the CMS
      if (url.pathname === '/chat/message' && req.method === 'POST') {
        const body = await req.json() as { text: string; modelUid?: string; snapshot?: unknown; conversationId?: string }
        if (!body.text?.trim()) {
          return new Response(JSON.stringify({ error: 'text is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        const msg = chatRelay.enqueueMessage(body.text)
        const modelUid = body.modelUid ?? 'glm-5-2'
        const conversationId = body.conversationId ?? msg.id
        chatRelay.setActiveMessageId(msg.id)

        if (!windsurfClient.isConnected()) {
          log('[Relay] Not connected to Windsurf, attempting lazy connect...')
          try { await windsurfClient.connect() } catch { /* fall through */ }
        }

        if (windsurfClient.isConnected()) {
          const preLoadedPack = classify(body.text)
          const isFirstMessage = !windsurfClient.hasInjectedFullPrompt(conversationId)
          const messageWithContext = isFirstMessage
            ? buildInjectedPrompt(body.text, body.snapshot)
            : buildFollowUpPrompt(body.text, body.snapshot)
          log(`[Relay] ${isFirstMessage ? 'Full' : 'Follow-up'} prompt for ${conversationId} — pack "${preLoadedPack}": ${body.text.slice(0, 60)}`)
          if (isFirstMessage) {
            windsurfClient.markInjectedFullPrompt(conversationId)
          }

          const emitter = new BufferedResponseEmitter(msg.id, chatRelay, 1500)

          windsurfClient.sendAndAwait(conversationId, messageWithContext, {
            attachToActive: true,
            modelUid,
            pollIntervalMs: 1000,
            idleTimeoutMs: 45_000,
            onEntry: (entry) => {
              if (entry.text || entry.thinking || entry.searchCalls || entry.toolCalls) {
                emitter.push(entry)
              }
            },
            onContextTokens: (inputTokens, outputTokens, creditCost) => {
              chatRelay.enqueueContext(msg.id, inputTokens, outputTokens, creditCost)
            },
            hasPendingWork: () => chatRelay.hasPendingBrowserToolCalls(),
          }).then(({ completed }) => {
            emitter.close()
            chatRelay.setActiveMessageId(null)
            chatRelay.closeStream(msg.id)
            if (!completed) {
              log(`[Relay] Cascade response for ${msg.id} ended without explicit completion (idle timeout)`)
            }
          }).catch((err) => {
            emitter.close()
            const errType = err?.constructor?.name ?? typeof err
            const errDetail = err instanceof Error ? `${err.message}\n${err.stack}` : typeof err === 'object' ? JSON.stringify(err) : String(err)
            log(`[Relay] Cascade send failed (type=${errType}):`, errDetail)
            chatRelay.enqueueResponse(msg.id, `Error: ${err instanceof Error ? err.message : String(err)}`)
            chatRelay.closeStream(msg.id)
          })

          return new Response(JSON.stringify({ messageId: msg.id, conversationId, path: 'direct' }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        // Fallback to MCP tool queue
        log(`[Relay] Language server unreachable — message queued via MCP (id=${msg.id})`)
        setTimeout(() => {
          if (!chatRelay.hasResponse(msg.id)) {
            chatRelay.enqueueResponse(
              msg.id,
              'No response from Windsurf Cascade within 15s. The language server is not reachable.',
            )
            chatRelay.closeStream(msg.id)
          }
        }, 15_000)

        return new Response(JSON.stringify({ messageId: msg.id, conversationId, path: 'mcp' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // POST /chat/tool-result — browser posts tool result
      if (url.pathname === '/chat/tool-result' && req.method === 'POST') {
        const body = await req.json() as { toolRequestId: string; result?: unknown; error?: string }
        if (!body.toolRequestId) {
          return new Response(JSON.stringify({ error: 'toolRequestId is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        chatRelay.resolveToolCall(body.toolRequestId, body.result, body.error)
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // GET /chat/stream/:id — SSE stream
      const streamMatch = url.pathname.match(/^\/chat\/stream\/(.+)$/)
      if (streamMatch && req.method === 'GET') {
        const messageId = streamMatch[1]
        const stream = new ReadableStream({
          start(controller) { chatRelay.registerSSEStream(messageId, controller) },
          cancel() { chatRelay.unregisterSSEStream(messageId) },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders,
          },
        })
      }

      // POST /chat/abort/:id
      const abortMatch = url.pathname.match(/^\/chat\/abort\/(.+)$/)
      if (abortMatch && req.method === 'POST') {
        windsurfClient.abortCurrentTurn()
        chatRelay.rejectPendingBrowserToolCalls('Aborted by user')
        chatRelay.closeStream(abortMatch[1])
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // POST /chat/reset
      if (url.pathname === '/chat/reset' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as { conversationId?: string }
        windsurfClient.resetSession(body.conversationId)
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // GET /status
      if (url.pathname === '/status' && req.method === 'GET') {
        return new Response(JSON.stringify({
          ok: true,
          cascadeActive: windsurfClient.isConnected(),
          mcpSessionActive: chatRelay.isMcpSessionActive(),
          relayMode: 'daemon',
          toolsAvailable: windsurfClient.isConnected() || chatRelay.isMcpSessionActive(),
          windsurfConnected: windsurfClient.isConnected(),
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // GET /cascade/status — legacy alias used by CMS
      if (url.pathname === '/cascade/status' && req.method === 'GET') {
        return new Response(JSON.stringify({
          mcpSessionActive: chatRelay.isMcpSessionActive(),
          relayMode: 'daemon',
          toolsAvailable: windsurfClient.isConnected() || chatRelay.isMcpSessionActive(),
          windsurfConnected: windsurfClient.isConnected(),
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // GET /models and /cascade/models — model picker source for the Cascade provider
      if ((url.pathname === '/cascade/models' || url.pathname === '/models') && req.method === 'GET') {
        // Fallback models used when the Windsurf client is not connected.
        // These are replaced by live data from the language server when available.
        const FALLBACK_MODELS = [
          { id: 'glm-5-2', label: 'GLM-5.2 High', free: true, contextWindow: 200_000 },
          { id: 'kimi-k2-7', label: 'Kimi K2.7', free: true, contextWindow: 262_000 },
          { id: 'swe-1-6', label: 'SWE 1.6', free: true, contextWindow: 200_000 },
          { id: 'claude-opus-4-8-medium', label: 'Claude Opus 4.8', free: false, pricing: { inputPerMTok: 5, outputPerMTok: 25 }, contextWindow: 1_000_000 },
        ]
        try {
          if (windsurfClient.isConnected()) {
            const configs = windsurfClient.getModelConfigs()
            log(`[Relay] /models: ${configs.length} configs from Windsurf, ${configs.filter((c) => !c.disabled).length} enabled`)
            const models = configs
              .filter((c) => !c.disabled)
              .map((c) => {
                // Live per-token pricing is not provided by the language server,
                // so we merge known public pricing by model UID. Free/unknown
                // models omit the pricing field entirely (no misleading $0/$0).
                const knownPricing = resolvePricing(c.modelUid)
                const pricing = c.pricing ?? knownPricing
                // The language server's is_premium flag is not reliable for all
                // plans; known non-zero pricing is a stronger signal of premium.
                const free = !c.isPremium && !pricing
                return {
                  id: c.modelUid,
                  label: c.label,
                  free,
                  ...(pricing ? { pricing } : {}),
                  ...(c.maxTokens > 0 ? { contextWindow: c.maxTokens } : {}),
                }
              })
            if (models.length > 0) {
              log(`[Relay] /models: returning ${models.length} dynamic models from Windsurf`)
              return new Response(JSON.stringify({
                models,
                defaultModel: models.find((m) => m.free)?.id ?? models[0]?.id,
              }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } })
            }
          } else {
            log('[Relay] /models: Windsurf client not connected, using fallback')
          }
        } catch (err) {
          log('[Relay] Failed to read model configs:', err)
        }
        return new Response(JSON.stringify({
          models: FALLBACK_MODELS,
          defaultModel: 'glm-5-2',
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } })
      }

      // GET /health
      if (url.pathname === '/health' && req.method === 'GET') {
        return new Response(JSON.stringify({
          ok: true,
          windsurfConnected: windsurfClient.isConnected(),
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } })
      }

      // ─── MCP Thin-Server Forwarding Endpoints ─────────────────────────

      // POST /mcp/tool — execute a tool call from the thin MCP server
      // CORS headers are intentionally omitted: this endpoint is only called
      // by the local thin MCP server (server.ts), not by a browser.
      if (url.pathname === '/mcp/tool' && req.method === 'POST') {
        const rawBody = await req.text()
        log(`[Relay] /mcp/tool received: body=${rawBody.length} bytes`)
        let body: { name: string; arguments?: Record<string, unknown>; traceId?: string }
        try {
          body = JSON.parse(rawBody)
          log(`[Relay] /mcp/tool parsed: ${body.name} (trace ${body.traceId ?? 'relay'})`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return new Response(JSON.stringify({ ok: false, error: `Invalid JSON: ${message}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const traceId = body.traceId ?? 'relay'
        try {
          const result = await executeTool(body.name, body.arguments ?? {}, traceId)
          const resultText = JSON.stringify(result)
          log(`[Relay] /mcp/tool response for ${body.name} (trace ${traceId}): ok=true body=${resultText.length} bytes`)
          return new Response(JSON.stringify({ ok: true, result }), {
            headers: { 'Content-Type': 'application/json' },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log(`[Relay] /mcp/tool response for ${body.name} (trace ${traceId}): ok=false error=${message}`)
          return new Response(JSON.stringify({ ok: false, error: message, traceId }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      // GET /mcp/tools — list tools for the thin MCP server
      // The registry is already restricted to the IDE HTTP API tools; return
      // them as-is so the thin MCP server exposes the correct set.
      if (url.pathname === '/mcp/tools' && req.method === 'GET') {
        return new Response(JSON.stringify({
          tools: allTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } })
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    },
  })

  log(`[Relay] HTTP relay listening on http://localhost:${server.port}`)
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      log(`[Relay] Port ${MCP_PORT} in use — checking if another relay is running...`)
      try {
        const res = await fetch(`http://127.0.0.1:${MCP_PORT}/health`, { signal: AbortSignal.timeout(500) })
        const body = await res.json() as { ok?: boolean }
        if (body?.ok) {
          log('[Relay] Another relay daemon is already running — exiting gracefully')
          process.exit(0)
        }
      } catch { /* not our relay, re-throw */ }
    }
    throw err
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('[Relay] Starting Instatic Relay Daemon...')
  log(`[Relay] CMS URL: ${CMS_URL}`)
  log(`[Relay] Admin URL: ${ADMIN_URL}`)
  log(`[Relay] MCP HTTP port: ${MCP_PORT}`)

  await startRelayDaemon()

  // Connect to Windsurf language server
  async function tryConnectWindsurf() {
    if (windsurfClient.isConnected()) return
    try {
      const connected = await windsurfClient.connect()
      if (connected) {
        log('[Relay] Windsurf language server connected')
        // Fetch live model configs (context windows, credit multipliers)
        // from GetUserStatus so the model picker shows real data.
        try {
          await windsurfClient.fetchUserStatus()
        } catch (err) {
          log('[Relay] fetchUserStatus failed (non-fatal):', err)
        }
      }
    } catch { /* retry */ }
  }

  await tryConnectWindsurf()
  function scheduleRetry(delay: number) {
    setTimeout(async () => {
      if (!windsurfClient.isConnected()) await tryConnectWindsurf()
      scheduleRetry(windsurfClient.isConnected() ? 60_000 : 10_000)
    }, delay)
  }
  scheduleRetry(10_000)

  // Authenticate to CMS
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    try {
      await cmsClient.login()
      log('[Relay] CMS authenticated')
    } catch (err) {
      log('[Relay] CMS auth failed:', err)
    }
  }

  log('[Relay] Daemon ready — waiting for MCP tool calls')
}

main().catch((err) => {
  log('[Relay] Fatal error:', err)
  process.exit(1)
})
