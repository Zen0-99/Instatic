#!/usr/bin/env bun
/**
 * Instatic MCP Server — THIN stdio client that forwards tool calls to the
 * Relay Daemon (relay-daemon.ts). The daemon owns the Windsurf connection,
 * chat relay, and SSE streams. It survives MCP server restarts.
 *
 * Architecture:
 *   Windsurf ──(stdio)──▶ MCP Server (thin) ──(HTTP)──▶ Relay Daemon (port 9876)
 *                                                       └── long-lived
 *
 * IMPORTANT: This server is started BY Windsurf via MCP stdio. The Relay Daemon
 * is started automatically if not already running.
 */

import { allTools, toolByName } from './tool-registry'
import { genTraceId, withBudget, TimeoutError, logHop, setTraceLogger } from './trace'
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'

// ─── File logger (stderr is not drained by Windsurf, so log only to file) ───

const LOG_PATH = resolve(process.cwd(), 'mcp-server.log')

function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch { /* ignore */ }
  // Intentionally NOT writing to stderr. Windsurf's MCP client does not drain
  // stderr, so filling the stderr pipe causes an OS pipe-buffer deadlock.
  // See: https://github.com/patchwright/mcpdrain
}

// ─── Trace logging ─────────────────────────────────────────────────────────
setTraceLogger(log)

// ─── Configuration ─────────────────────────────────────────────────────────

const MCP_PORT = parseInt(process.env.INSTATIC_MCP_PORT ?? '9876', 10)
const RELAY_TOOL_TIMEOUT_MS = parseInt(process.env.MCP_RELAY_TOOL_TIMEOUT_MS ?? '75000', 10)
const RELAY_HEALTH_URL = `http://127.0.0.1:${MCP_PORT}/health`
const RELAY_TOOL_URL = `http://127.0.0.1:${MCP_PORT}/mcp/tool`
const RELAY_TOOLS_LIST_URL = `http://127.0.0.1:${MCP_PORT}/mcp/tools`
const PID_FILE = resolve(process.cwd(), 'relay-daemon.pid')
// Windsurf's MCP stdio client can break its pipe on extremely long single-line JSON
// messages. Cap responses so one huge catalog payload does not kill the session.
const MAX_RESPONSE_CHARS = parseInt(process.env.MCP_MAX_RESPONSE_CHARS ?? '20000', 10)

// ─── MCP Protocol (stdio) ──────────────────────────────────────────────────

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

// ─── Stdout write chain ──────────────────────────────────────────────────
// process.stdout.write on a pipe (Windsurf's stdio) can BLOCK on Windows
// when the read-side isn't draining fast enough. We chain writes as
// promises so each waits for the previous to complete. A 5-second safety
// timeout prevents a broken pipe from freezing the chain forever.

let writeChain: Promise<void> = Promise.resolve()

// Write a chunk with a drain timeout. On Windows, writing more than the pipe
// buffer can synchronously block the event loop, so we chunk large messages.
function writeChunk(chunk: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stdout write timeout (pipe may be broken)')), 5_000)
    let cleared = false
    const clear = () => {
      if (!cleared) {
        cleared = true
        clearTimeout(timeout)
      }
    }
    try {
      const canContinue = process.stdout.write(chunk, (err) => {
        clear()
        if (err) reject(err)
        else resolve()
      })
      // If the write returned false, wait for the drain event before resolving.
      if (!canContinue) {
        process.stdout.once('drain', () => {
          clear()
          resolve()
        })
      } else {
        clear()
      }
    } catch (err) {
      clear()
      reject(err)
    }
  })
}

function sendResponse(response: McpResponse): void {
  const json = JSON.stringify(response) + '\n'
  const chunkSize = 1024
  const chunks: string[] = []
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.slice(i, i + chunkSize))
  }
  // If the response is small, write it in one go.
  if (chunks.length === 1) {
    writeChain = writeChain.then(() => writeChunk(chunks[0]!)).catch((err) => {
      log('[MCP Server] stdout write error:', err instanceof Error ? err.message : String(err))
    })
    return
  }
  // Large responses: write chunks with a yield between each to let the event loop run.
  writeChain = writeChain.then(async () => {
    for (let i = 0; i < chunks.length; i++) {
      await writeChunk(chunks[i]!)
      if (i < chunks.length - 1) {
        await new Promise((r) => setImmediate(r))
      }
    }
  }).catch((err) => {
    log('[MCP Server] stdout write error:', err instanceof Error ? err.message : String(err))
    // Continue — one bad write must not block the chain forever.
  })
}

function sendError(id: number | string, code: number, message: string): void {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } })
}

// ─── Relay Daemon Management ───────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * HTTP helper using node:http instead of Bun's fetch.
 *
 * Bun's fetch blocks the JavaScript event loop on Windows when the server
 * holds the TCP body stream open (e.g. while the relay daemon executes a
 * browser tool that takes several seconds).  This caused tool call results
 * to be delayed for minutes/hours — the MCP server could not read new stdio
 * messages or send responses while fetch was blocked.
 *
 * node:http is callback-driven and never blocks the event loop.
 */
function httpGet(url: string, timeoutMs = 500): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve) => {
    // agent: false prevents connection-pool reuse.  Bun's node:http
    // compatibility layer on Windows silently hangs when reusing a
    // connection that Bun.serve() has closed.
    const req = httpRequest(url, { method: 'GET', timeout: timeoutMs, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 300, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', () => resolve({ ok: false, body: '' }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '' }) })
    req.end()
  })
}

function httpPostJson(url: string, payload: object, timeoutMs = 80000): Promise<{ ok: boolean; status: number; body: string }> {
  const bodyStr = JSON.stringify(payload)
  return new Promise((resolve) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }) })
    // Safety net: if Bun's node:http layer doesn't fire the timeout event,
    // force-resolve after timeoutMs so the caller never hangs forever.
    const safetyTimer = setTimeout(() => {
      req.destroy()
      resolve({ ok: false, status: 0, body: 'timeout' })
    }, timeoutMs)
    req.on('response', () => clearTimeout(safetyTimer))
    req.on('error', () => clearTimeout(safetyTimer))
    req.on('timeout', () => clearTimeout(safetyTimer))
    req.write(bodyStr)
    req.end()
  })
}

async function ensureRelayDaemon(): Promise<void> {
  // 1. If another MCP process already spawned the daemon, the PID file tells
  //    us which process to check. This avoids the race where two processes
  //    both see port 9876 as free and both spawn a daemon.
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
      if (!Number.isNaN(pid) && isPidAlive(pid)) {
        log(`[MCP Server] Daemon PID ${pid} is alive — waiting for health endpoint`)
        for (let i = 0; i < 40; i++) {
          const res = await httpGet(RELAY_HEALTH_URL, 250)
          if (res.ok) {
            log('[MCP Server] Relay daemon already running (found via PID file)')
            return
          }
          await new Promise((r) => setTimeout(r, 150))
        }
        // PID is alive but health never responded — stale PID file
        log('[MCP Server] Stale PID file — removing')
        try { unlinkSync(PID_FILE) } catch { /* ignore */ }
      } else {
        // Dead PID — clean up
        try { unlinkSync(PID_FILE) } catch { /* ignore */ }
      }
    } catch { /* malformed PID file, ignore */ }
  }

  // 2. Health-check retry loop — daemon may be mid-startup from another proc
  for (let i = 0; i < 10; i++) {
    const res = await httpGet(RELAY_HEALTH_URL, 400)
    if (res.ok) {
      log('[MCP Server] Relay daemon already running (health check)')
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  log('[MCP Server] Starting relay daemon...')
  try {
    const daemonPath = fileURLToPath(new URL('relay-daemon.ts', import.meta.url))
    const relayLogPath = resolve(process.cwd(), 'relay-daemon.log')
    const relayLogFd = openSync(relayLogPath, 'a')
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: ['ignore', relayLogFd, relayLogFd],
      env: process.env,
      windowsHide: true,
    })
    try { closeSync(relayLogFd) } catch { /* child inherited the fd */ }
    if (child.pid) {
      writeFileSync(PID_FILE, String(child.pid))
    }
    child.unref()
  } catch (err) {
    log('[MCP Server] Failed to spawn relay daemon:', err)
    return
  }

  // Wait up to 5s for daemon to be ready
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const res = await httpGet(RELAY_HEALTH_URL, 200)
    if (res.ok) {
      log('[MCP Server] Relay daemon ready')
      return
    }
  }
  log('[MCP Server] Relay daemon did not respond within 5s — will retry on next tool call')
}

async function callRelayTool(
  name: string,
  args: Record<string, unknown>,
  traceId: string,
): Promise<unknown> {
  const payload = { name, arguments: args, traceId }
  log(`[MCP Server] POST to relay: ${name} (trace ${traceId}) body=${JSON.stringify(payload).length} bytes`)
  // Render snapshots need a longer budget than normal node-editing tools.
  const toolTimeoutMs = name === 'site_render_snapshot' ? 130_000 : RELAY_TOOL_TIMEOUT_MS
  const bodyPromise = httpPostJson(
    RELAY_TOOL_URL,
    payload,
    toolTimeoutMs + 5000,
  ).then((res) => {
    log(`[MCP Server] Relay response for ${name} (trace ${traceId}): status=${res.status} body=${res.body.length} bytes`)
    if (!res.ok) {
      throw new Error(`Relay tool error: ${res.body.slice(0, 500)}`)
    }
    const body = JSON.parse(res.body) as { ok: boolean; result?: unknown; error?: string }
    if (!body.ok) throw new Error(body.error ?? 'Tool execution failed')
    return body.result
  })

  return withBudget(
    traceId,
    name,
    'server:callRelayTool',
    toolTimeoutMs,
    bodyPromise,
    (elapsed) => {
      log(`[MCP Server] Tool ${name} (trace ${traceId}) stalled at ${elapsed}ms — relay unresponsive`)
    },
    Math.min(toolTimeoutMs, 20000),
  )
}

// ─── MCP Request Handler ───────────────────────────────────────────────────

async function handleMcpRequest(req: McpRequest): Promise<void> {
  const { id, method, params } = req
  log(`[MCP Server] Handling request ${id}: ${method}`)

  switch (method) {
    case 'initialize': {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'instatic', version: '0.2.0' },
        },
      })
      break
    }

    case 'notifications/initialized': {
      break
    }

    case 'ping': {
      sendResponse({ jsonrpc: '2.0', id, result: {} })
      break
    }

    case 'notifications/cancelled': {
      const p = params as { requestId?: string | number }
      log(`[MCP Server] Cancellation notification for request ${p.requestId ?? 'unknown'}`)
      break
    }

    case 'tools/list': {
      try {
        const res = await httpGet(RELAY_TOOLS_LIST_URL, 2000)
        if (!res.ok) throw new Error('Relay tools list failed')
        const body = JSON.parse(res.body) as { tools: Array<{ name: string; description: string; inputSchema: object }> }
        sendResponse({ jsonrpc: '2.0', id, result: { tools: body.tools } })
      } catch {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            tools: allTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        })
      }
      break
    }

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> }
      const traceId = genTraceId()
      log(`[MCP Server] Tool call: ${p.name} (trace ${traceId})`)
      try {
        const result = await callRelayTool(p.name, p.arguments ?? {}, traceId)
        let resultText =
          typeof result === 'string' ? result
            : result === undefined ? 'OK'
            : JSON.stringify(result)
        if (resultText.length > MAX_RESPONSE_CHARS) {
          log(`[MCP Server] Tool ${p.name} (trace ${traceId}) result oversized: ${resultText.length} chars, truncating to ${MAX_RESPONSE_CHARS}`)
          resultText = resultText.slice(0, MAX_RESPONSE_CHARS) + '\n...[truncated by MCP server]'
        }
        log(`[MCP Server] Tool ${p.name} (trace ${traceId}) result: ${resultText.slice(0, 200)}`)
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: resultText }],
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const isTimeout = err instanceof TimeoutError
        const display = isTimeout
          ? `Tool '${p.name}' timed out after ${p.name === 'site_render_snapshot' ? 130_000 : RELAY_TOOL_TIMEOUT_MS}ms. The relay or inner tool (CMS/browser) may be stalled. Check relay-daemon.log for trace ${(err as TimeoutError).traceId}.`
          : `Tool error: ${message}`
        log(`[MCP Server] Tool ${p.name} (trace ${traceId}) error: ${message}`)
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: display }],
            isError: true,
          },
        })
      }
      break
    }

    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`[MCP Server] Starting Instatic MCP Server (pid=${process.pid}, cwd=${process.cwd()})`)
  log(`[MCP Server] Relay port: ${MCP_PORT}`)

  // Start stdio loop IMMEDIATELY — Windsurf's watchdog will restart us if we
  // don't respond to initialize within ~1s. Daemon connect happens in background.
  log('[MCP Server] Ready — listening for MCP requests on stdio')

  // Kick off relay daemon in the background — tool calls will retry if not ready
  void ensureRelayDaemon().catch((err) => {
    log('[MCP Server] Relay daemon startup error:', err)
  })

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let req: McpRequest
      try {
        log(`[MCP Server] Raw stdio: ${trimmed.slice(0, 400)}`)
        req = JSON.parse(trimmed) as McpRequest
      } catch (err) {
        log('[MCP Server] Failed to parse MCP request:', err)
        continue
      }
      void handleMcpRequest(req).catch((err) => {
        log(`[MCP Server] Unhandled error in request ${String(req.id)}:`, err)
      })
    }
  })

  process.stdin.on('end', () => {
    log('[MCP Server] stdin ended — exiting')
    process.exit(0)
  })

  process.stdin.on('error', (err) => {
    log('[MCP Server] stdin error:', err)
  })

  // Keep the event loop alive
  await new Promise(() => {})
}

main().catch((err) => {
  log('[MCP Server] Fatal error:', err)
  process.exit(1)
})
