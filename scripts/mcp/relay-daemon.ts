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
import { WindsurfClient } from './windsurf-client'
import { ChatRelayQueue } from './chat-relay'
import { CmsClient } from './cms-client'
import { executeHttpApiTool } from './http-tools'
import { allTools, toolByName } from './tool-registry'
import { buildInjectedPrompt, buildFollowUpPrompt, classify, getPack, listPackIds } from './injections'
import { logHop, setTraceLogger } from './trace'

const LOG_PATH = resolve(process.cwd(), 'relay-daemon.log')
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try { appendFileSync(LOG_PATH, line) } catch { /* ignore */ }
  console.error(...args)
}
setTraceLogger(log)

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
  const start = Date.now()

  try {
    switch (tool.execution) {
      case 'browser': {
        // render_snapshot's html-to-image screenshot capture is very slow for
        // full-page desktop captures and exceeds the browser's 25s budget.
        // Through the MCP text channel the model gets the layout report
        // (bounding boxes, text, computed styles) which is sufficient for
        // verification.  Skip the screenshot to avoid timeouts.
        if (name === 'render_snapshot') {
          input = { ...input, captureScreenshot: false }
        }
        const result = await chatRelay.requestBrowserTool(name, input, { traceId })
        logHop(traceId, name, 'relay:browser', 'exit', Date.now() - start)
        return result
      }

      case 'http-api': {
        const result = await executeHttpApiTool(name, input, cmsClient, traceId)
        logHop(traceId, name, 'relay:http-api', 'exit', Date.now() - start)
        return result
      }

      case 'chat-relay': {
        switch (name) {
          case 'get_cms_chat_messages': {
            chatRelay.markPoll()
            const messages = chatRelay.dequeueMessages()
            return { messages }
          }
          case 'send_cms_chat_response': {
            return { ok: true, note: 'ignored in hybrid mode' }
          }
          default:
            return { error: `Unknown chat relay tool: ${name}` }
        }
      }

      case 'local': {
        switch (name) {
          case 'get_guidance': {
            const packId = input.pack as string
            const validIds = listPackIds()
            if (!validIds.includes(packId)) {
              return { error: `Unknown guidance pack: "${packId}"`, validPacks: validIds }
            }
            return { pack: packId, guidance: getPack(packId) }
          }
          default:
            return { error: `Unknown local tool: ${name}` }
        }
      }

      default:
        throw new Error(`Unknown execution type: ${tool.execution}`)
    }
  } catch (err) {
    logHop(traceId, name, 'relay:executeTool', 'error', Date.now() - start, err instanceof Error ? err.message : String(err))
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
        const body = await req.json() as { text: string; modelUid?: string; snapshot?: unknown }
        if (!body.text?.trim()) {
          return new Response(JSON.stringify({ error: 'text is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        const msg = chatRelay.enqueueMessage(body.text)
        const modelUid = body.modelUid ?? 'kimi-k2-6'
        chatRelay.setActiveMessageId(msg.id)

        if (!windsurfClient.isConnected()) {
          log('[Relay] Not connected to Windsurf, attempting lazy connect...')
          try { await windsurfClient.connect() } catch { /* fall through */ }
        }

        if (windsurfClient.isConnected()) {
          const preLoadedPack = classify(body.text)
          const isFirstMessage = !windsurfClient.hasInjectedFullPrompt
          const messageWithContext = isFirstMessage
            ? buildInjectedPrompt(body.text, body.snapshot)
            : buildFollowUpPrompt(body.text, body.snapshot)
          log(`[Relay] ${isFirstMessage ? 'Full' : 'Follow-up'} prompt — pack "${preLoadedPack}": ${body.text.slice(0, 60)}`)
          if (isFirstMessage) {
            windsurfClient.hasInjectedFullPrompt = true
          }

          windsurfClient.sendAndAwait(messageWithContext, {
            attachToActive: true,
            modelUid,
            idleTimeoutMs: 45_000,
            onEntry: (entry) => {
              const text = entry.text ?? ''
              if (text || entry.thinking) {
                chatRelay.enqueueResponse(msg.id, text, entry.toolCalls, entry.thinking)
              }
            },
            hasPendingWork: () => chatRelay.hasPendingBrowserToolCalls(),
          }).then(({ completed }) => {
            chatRelay.setActiveMessageId(null)
            chatRelay.closeStream(msg.id)
            if (!completed) {
              log(`[Relay] Cascade response for ${msg.id} ended without explicit completion (idle timeout)`)
            }
          }).catch((err) => {
            const errType = err?.constructor?.name ?? typeof err
            const errDetail = err instanceof Error ? `${err.message}\n${err.stack}` : typeof err === 'object' ? JSON.stringify(err) : String(err)
            log(`[Relay] Cascade send failed (type=${errType}):`, errDetail)
            chatRelay.enqueueResponse(msg.id, `Error: ${err instanceof Error ? err.message : String(err)}`)
            chatRelay.closeStream(msg.id)
          })

          return new Response(JSON.stringify({ messageId: msg.id, path: 'direct' }), {
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

        return new Response(JSON.stringify({ messageId: msg.id, path: 'mcp' }), {
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
        chatRelay.closeStream(abortMatch[1])
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // POST /chat/reset
      if (url.pathname === '/chat/reset' && req.method === 'POST') {
        windsurfClient.resetSession()
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

      // GET /cascade/models
      if (url.pathname === '/cascade/models' && req.method === 'GET') {
        try {
          if (windsurfClient.isConnected()) {
            const configs = windsurfClient.getModelConfigs()
            const models = configs
              .filter((c) => !c.disabled)
              .map((c) => ({ id: c.modelUid, label: c.label, free: !c.isPremium }))
            if (models.length > 0) {
              return new Response(JSON.stringify({
                models,
                defaultModel: models.find((m) => m.free)?.id ?? models[0]?.id,
              }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } })
            }
          }
        } catch (err) {
          log('[Relay] Failed to read model configs:', err)
        }
        return new Response(JSON.stringify({
          models: [
            { id: 'kimi-k2-6', label: 'Kimi K2.6', free: true },
            { id: 'swe-1-6', label: 'SWE 1.6', free: true },
            { id: 'claude-opus-4-8-medium', label: 'Claude Opus 4.8', free: false },
          ],
          defaultModel: 'kimi-k2-6',
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
      if (url.pathname === '/mcp/tool' && req.method === 'POST') {
        const body = await req.json() as { name: string; arguments?: Record<string, unknown>; traceId?: string }
        const traceId = body.traceId ?? 'relay'
        try {
          const result = await executeTool(body.name, body.arguments ?? {}, traceId)
          return new Response(JSON.stringify({ ok: true, result }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log(`[Relay] Tool ${body.name} (trace ${traceId}) error: ${message}`)
          return new Response(JSON.stringify({ ok: false, error: message, traceId }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
      }

      // GET /mcp/tools — list tools for the thin MCP server
      // In hybrid mode, messages flow via SSE directly; hide both relay tools
      // so the AI doesn't try to use them (would duplicate or stall).
      if (url.pathname === '/mcp/tools' && req.method === 'GET') {
        const excluded = new Set(['send_cms_chat_response', 'get_cms_chat_messages'])
        return new Response(JSON.stringify({
          tools: allTools
            .filter((t) => !excluded.has(t.name))
            .map((t) => ({
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
      if (connected) log('[Relay] Windsurf language server connected')
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
