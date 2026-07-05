#!/usr/bin/env bun
/**
 * Stdio Proxy — a deadlock-proof stdio wrapper for the Instatic MCP server.
 *
 * Windsurf's MCP client does not drain stderr and can block on large stdout
 * writes, causing an OS pipe-buffer deadlock. This proxy sits between
 * Windsurf and the thin MCP server:
 *
 *   Windsurf  ──stdin──▶  proxy  ──stdin──▶  MCP server
 *   Windsurf  ◀─stdout──  proxy ◀─stdout──  MCP server
 *   proxy drains MCP server stderr to a file (so the server never blocks)
 *
 * The proxy is spawned by Windsurf. It then spawns the real MCP server.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..')
const STDERR_LOG_PATH = resolve(PROJECT_ROOT, 'mcp-server-stderr.log')
const PROXY_LOG_PATH = resolve(PROJECT_ROOT, 'stdio-proxy.log')

function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}
`
  try { appendFileSync(PROXY_LOG_PATH, line) } catch { /* ignore */ }
}

const serverPath = resolve(SCRIPT_DIR, 'server.ts')
log(`[Stdio Proxy] Starting MCP server: ${serverPath}`)

const server = spawn(process.execPath, ['run', serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  windowsHide: true,
})

// Forward client stdin to the server stdin.
process.stdin.pipe(server.stdin as NodeJS.WritableStream)

// Forward server stdout to the client stdout.
// The built-in .pipe() handles backpressure: if Windsurf is slow to read,
// the server's stdout is paused automatically, preventing memory blowout.
server.stdout.pipe(process.stdout)

// Drain server stderr to a file. This is the critical part: without a reader,
// the MCP server's stderr pipe would fill up and deadlock the whole session.
server.stderr.on('data', (chunk: Buffer) => {
  try { appendFileSync(STDERR_LOG_PATH, chunk) } catch { /* ignore */ }
})

server.on('error', (err) => {
  log('[Stdio Proxy] MCP server spawn error:', err instanceof Error ? err.message : String(err))
})

server.on('exit', (code, signal) => {
  log(`[Stdio Proxy] MCP server exited: code=${code}, signal=${signal}`)
  process.exit(code ?? 0)
})

process.stdin.on('end', () => {
  log('[Stdio Proxy] Client stdin ended')
  server.stdin?.end()
})

process.on('exit', () => {
  if (!server.killed) {
    server.kill()
  }
})
