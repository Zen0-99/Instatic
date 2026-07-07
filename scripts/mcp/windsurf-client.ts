/**
 * Windsurf Connect-RPC client — communicates with the local Windsurf language
 * server via HTTP Connect-RPC (Buf Connect protocol) to send/receive Cascade
 * chat messages and discover available models.
 *
 134 x 18
 
 
 
 
 11h
 
 * Protocol (reverse-engineered from Windsurf extension.js):
 *   1. InitializeCascadePanelState(metadata, workspace_trusted)  — once per session
 *   2. StartCascade(metadata, source)                            — returns cascade_id
 *   3. SendUserCascadeMessage(cascade_id, items, metadata, cascade_config)
 *   4. GetCascadeTrajectorySteps(cascade_id, step_offset)        — poll for response
 *   5. ArchiveCascadeTrajectory(cascade_id)                      — cleanup
 *
 * The language server runs as a local process (language_server_windows_x64.exe
 * on Windows). We discover its port from Windsurf logs, the CSRF token from the
 * process environment block (WINDSURF_CSRF_TOKEN env var), and the API key from
 * the Windsurf global state database.
 *
 * All RPC calls use HTTP POST with Content-Type: application/proto and binary
 * protobuf encoding (Connect-RPC protocol).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { request } from 'node:http'

const LOG_PATH = resolve(process.cwd(), 'mcp-server.log')
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try { appendFileSync(LOG_PATH, line) } catch { /* ignore */ }
  console.error(...args)
}
import { randomUUID } from 'node:crypto'

// ─── Protobuf encoding helpers ──────────────────────────────────────────────

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v & 0x7f)
  return Buffer.from(bytes)
}

function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  const tag = (fieldNumber << 3) | 2 // wire type 2 = length-delimited
  return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), data])
}

function encodeString(fieldNumber: number, str: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(str, 'utf8'))
}

function encodeBool(fieldNumber: number, value: boolean): Buffer {
  const tag = (fieldNumber << 3) | 0 // wire type 0 = varint
  return Buffer.concat([encodeVarint(tag), encodeVarint(value ? 1 : 0)])
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  const tag = (fieldNumber << 3) | 0
  return Buffer.concat([encodeVarint(tag), encodeVarint(value)])
}

// ─── Protobuf decoding helpers ──────────────────────────────────────────────

function decodeVarint(data: Buffer, offset: number): { value: number; bytesRead: number } {
  let result = 0
  let shift = 0
  let bytesRead = 0
  while (offset < data.length) {
    const byte = data[offset++]
    result |= (byte & 0x7f) << shift
    shift += 7
    bytesRead++
    if ((byte & 0x80) === 0) break
  }
  return { value: result, bytesRead }
}

function skipField(data: Buffer, offset: number, wireType: number): number {
  switch (wireType) {
    case 0: { // varint
      while (offset < data.length && (data[offset++] & 0x80) !== 0) {}
      return offset
    }
    case 1: return offset + 8 // 64-bit
    case 2: { // length-delimited
      const { value: len, bytesRead } = decodeVarint(data, offset)
      return offset + bytesRead + len
    }
    case 5: return offset + 4 // 32-bit
    default:
      return -1
  }
}

function parseStringField(data: Buffer, fieldNumber: number): string | null {
  const parts = collectStringField(data, fieldNumber)
  return parts.length > 0 ? parts.join('') : null
}

function collectStringField(data: Buffer, fieldNumber: number): string[] {
  const parts: string[] = []
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    offset += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 2) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      parts.push(data.subarray(offset, offset + len).toString('utf8'))
      continue
    }
    offset = skipField(data, offset, wt)
    if (offset < 0) break
  }
  return parts
}

function parseBoolField(data: Buffer, fieldNumber: number): boolean | null {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    offset += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 0) {
      const { value } = decodeVarint(data, offset)
      return value !== 0
    }
    offset = skipField(data, offset, wt)
    if (offset < 0) return null
  }
  return null
}

function parseUint32Field(data: Buffer, fieldNumber: number): number | null {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    offset += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 0) {
      const { value } = decodeVarint(data, offset)
      return value
    }
    offset = skipField(data, offset, wt)
    if (offset < 0) return null
  }
  return null
}

function parseDoubleField(data: Buffer, fieldNumber: number): number | null {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    offset += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 1) {
      // wire type 1 = 64-bit fixed
      if (offset + 8 > data.length) return null
      return data.readDoubleLE(offset)
    }
    offset = skipField(data, offset, wt)
    if (offset < 0) return null
  }
  return null
}

// ─── Discovery ──────────────────────────────────────────────────────────────

interface LanguageServerInfo {
  pid: number
  port: number
  csrfToken: string
  apiKey: string
  installationId: string
  modelConfigs: Array<{
    label: string
    modelUid: string
    disabled: boolean
    isPremium: boolean
    maxTokens: number
    creditMultiplier: number
    pricing?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }
  }>
}

/**
 * Find Windsurf log directories (most recent first), returns multiple for fallback.
 */
function findLogDirs(): string[] {
  const logsDir = join(homedir(), 'AppData', 'Roaming', 'Windsurf', 'logs')
  if (!existsSync(logsDir)) return []
  const entries = spawnSync('cmd', ['/c', 'dir', '/b', '/ad', '/o-n', logsDir], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (entries.status !== 0 || !entries.stdout) return []
  return entries.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).map((d) => join(logsDir, d))
}

/**
 * Parse Windsurf.log to find the most recent language server port.
 */
function findLanguageServerPort(logDirs: string[]): number | null {
  for (const logDir of logDirs) {
    const result = spawnSync('cmd', ['/c', 'findstr', '/s', '/i', 'random port at', logDir + '\\*.log'], {
      encoding: 'utf8',
      timeout: 10000,
    })
    if (result.status === 0 && result.stdout) {
      const matches = result.stdout.matchAll(/Language server listening on random port at (\d+)/g)
      const ports: number[] = []
      for (const m of matches) {
        ports.push(parseInt(m[1], 10))
      }
      if (ports.length > 0) return ports[ports.length - 1]
    }
  }
  return null
}

/**
 * Find the language server PID for the Instatic workspace (or any if not found).
 */
function findLanguageServerPid(): number | null {
  const isWindows = process.platform === 'win32'
  const binaryPattern = isWindows
    ? 'language_server_windows'
    : process.platform === 'darwin'
      ? 'language_server_macos'
      : 'language_server_linux'

  try {
    const pids: Array<{ pid: number; cmdline: string }> = []
    if (isWindows) {
      // Try wmic first, fall back to PowerShell
      const result = spawnSync('wmic', [
        'process', 'where',
        `name like '%${binaryPattern}%'`,
        'get', 'processid,commandline',
      ], { encoding: 'utf8', timeout: 10000 })

      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.trim().split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || 'CommandLine'.toLowerCase().includes(trimmed.toLowerCase())) continue
          const match = trimmed.match(/(\d+)\s*$/)
          if (match) {
            pids.push({ pid: parseInt(match[1], 10), cmdline: trimmed })
          }
        }
      }

      // Fallback: PowerShell
      if (pids.length === 0) {
        const psResult = spawnSync('powershell', [
          '-NoProfile', '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*${binaryPattern}*' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }`,
        ], { encoding: 'utf8', timeout: 10000 })
        if (psResult.status === 0 && psResult.stdout) {
          for (const line of psResult.stdout.trim().split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const match = trimmed.match(/^(\d+)\s+(.*)/)
            if (match) {
              pids.push({ pid: parseInt(match[1], 10), cmdline: match[2] })
            }
          }
        }
      }
    } else {
      const result = spawnSync('pgrep', ['-f', binaryPattern], {
        encoding: 'utf8',
        timeout: 5000,
      })
      if (result.status !== 0 || !result.stdout) return null
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        pids.push({ pid: parseInt(line.trim(), 10), cmdline: '' })
      }
    }

    if (pids.length === 0) return null

    // Prefer the Instatic workspace process
    const instatic = pids.find((p) => p.cmdline.includes('Instatic'))
    return (instatic ?? pids[0]).pid
  } catch {
    return null
  }
}

/**
 * Read the WINDSURF_CSRF_TOKEN environment variable from a running process
 * by reading its Process Environment Block (PEB) via the Windows API.
 *
 * Uses Python ctypes (no C# compiler needed) on Windows, /proc on Linux.
 */
function readProcessEnvVar(pid: number, varName: string): string | null {
  if (process.platform === 'win32') {
    const pyScript = `import ctypes,ctypes.wintypes as w,sys
k=ctypes.WinDLL('kernel32',use_last_error=True)
n=ctypes.WinDLL('ntdll',use_last_error=True)
P=ctypes.c_size_t
class PBI(ctypes.Structure):
 _fields_=[("ExitStatus",w.LONG),("PebBaseAddress",ctypes.c_void_p),("AffinityMask",P),("BasePriority",w.LONG),("UniqueProcessId",P),("InheritedFromUniqueProcessId",P)]
h=k.OpenProcess(0x410,False,${pid})
if not h:sys.exit(1)
p=PBI()
n.NtQueryInformationProcess(h,0,ctypes.byref(p),ctypes.sizeof(p),None)
b=ctypes.c_void_p();br=ctypes.c_size_t()
k.ReadProcessMemory(h,ctypes.c_void_p(p.PebBaseAddress+0x20),ctypes.byref(b),ctypes.sizeof(b),ctypes.byref(br))
e=ctypes.c_void_p()
k.ReadProcessMemory(h,ctypes.c_void_p(b.value+0x80),ctypes.byref(e),ctypes.sizeof(e),ctypes.byref(br))
d=b''
o=0
while len(d)<262144:
 c=(ctypes.c_ubyte*4096)()
 if not k.ReadProcessMemory(h,ctypes.c_void_p(e.value+o),c,4096,ctypes.byref(br)) or br.value==0:break
 d+=bytes(c[:br.value]);o+=br.value
 if b'\\x00\\x00\\x00\\x00' in d[-4096:]:break
k.CloseHandle(h)
try:
 s=d.decode('utf-16-le',errors='replace')
 for ent in s.split('\\x00'):
  if '=' in ent:
   k2,_,v=ent.partition('=')
   if k2=='${varName}':print(v);sys.exit(0)
except Exception:pass
sys.exit(2)`
    const pyPaths = [
      'python',
      'python3',
      'C:\\Users\\karol\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
      'C:\\Users\\karol\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
      'C:\\Users\\karol\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
    ]
    for (const py of pyPaths) {
      try {
        const result = spawnSync(py, ['-c', pyScript], {
          encoding: 'utf8',
          timeout: 15000,
        })
        if (result.stdout) {
          const val = result.stdout.trim()
          if (val && val !== 'NOT_FOUND') return val
        }
        if (result.status === 1) {
          continue
        }
        break
      } catch {
        continue
      }
    }
    return null
  } else {
    try {
      const envData = readFileSync(`/proc/${pid}/environ`, 'utf8')
      for (const entry of envData.split('\0')) {
        const eqIdx = entry.indexOf('=')
        if (eqIdx > 0 && entry.substring(0, eqIdx) === varName) {
          return entry.substring(eqIdx + 1)
        }
      }
    } catch {
      // Not on Linux or no permission
    }
    return null
  }
}

interface AuthStatus {
  apiKey: string | null
  modelConfigsBase64: string | null
}

/**
 * Extract auth status from the Windsurf global state database (state.vscdb).
 * Returns both the API key and the base64-encoded model configs protobuf.
 */
function readAuthStatus(): AuthStatus {
  const dbPath = join(homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'state.vscdb')
  if (!existsSync(dbPath)) return { apiKey: null, modelConfigsBase64: null }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Database = (globalThis as any).Bun?.SQLite
    let value: string | null = null

    if (!Database) {
      const result = spawnSync('sqlite3', [dbPath, "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'"], {
        encoding: 'utf8',
        timeout: 5000,
      })
      if (result.status === 0 && result.stdout) {
        value = result.stdout.trim()
      }
    } else {
      const db = Database.open(dbPath)
      const row = db.query("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").get()
      db.close()
      value = row?.value ?? null
    }

    if (value) {
      const data = JSON.parse(value)
      return {
        apiKey: data.apiKey ?? null,
        modelConfigsBase64: data.allowedCommandModelConfigsProtoBinaryBase64 ?? null,
      }
    }
  } catch (err) {
    log('[WindsurfClient] Failed to read auth status:', err)
  }
  return { apiKey: null, modelConfigsBase64: null }
}

/**
 * Read the installation ID from ~/.codeium/windsurf/installation_id.
 */
function findInstallationId(): string {
  const p = join(homedir(), '.codeium', 'windsurf', 'installation_id')
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Discover the running Windsurf language server and all connection info.
 */
function discoverLanguageServer(): LanguageServerInfo | null {
  const pid = findLanguageServerPid()
  if (!pid) {
    log('[WindsurfClient] No language server process found')
    return null
  }

  const logDirs = findLogDirs()
  if (logDirs.length === 0) {
    log('[WindsurfClient] No Windsurf log directory found')
    return null
  }

  const port = findLanguageServerPort(logDirs)
  if (!port) {
    log('[WindsurfClient] Could not find language server port in logs')
    return null
  }

  const csrfToken = readProcessEnvVar(pid, 'WINDSURF_CSRF_TOKEN')
  if (!csrfToken) {
    log('[WindsurfClient] Could not extract WINDSURF_CSRF_TOKEN from process')
    return null
  }

  const auth = readAuthStatus()
  const apiKey = auth.apiKey ?? ''
  const installationId = findInstallationId()

  // Parse model configs from the base64 protobuf stored in auth status
  let modelConfigs: LanguageServerInfo['modelConfigs'] = []
  if (auth.modelConfigsBase64) {
    try {
      const buf = Buffer.from(auth.modelConfigsBase64, 'base64')
      modelConfigs = parseModelConfigsResponse(buf)
    } catch (err) {
      log('[WindsurfClient] Failed to parse model configs:', err)
    }
  }

  log(`[WindsurfClient] Found language server PID ${pid}, port ${port}`)
  log(`[WindsurfClient] CSRF token: ${csrfToken.slice(0, 8)}...`)
  log(`[WindsurfClient] API key: ${apiKey.slice(0, 20)}...`)
  log(`[WindsurfClient] Model configs: ${modelConfigs.length}`)
  if (modelConfigs.length > 0) {
    log(`[WindsurfClient] Models: ${modelConfigs.map((c) => `${c.label} (${c.modelUid})`).join(', ')}`)
  }

  return { pid, port, csrfToken, apiKey, installationId, modelConfigs }
}

// ─── Connect-RPC client ─────────────────────────────────────────────────────

const SERVICE = 'exa.language_server_pb.LanguageServerService'

export interface CascadeResponse {
  text?: string
  thinking?: string
  toolCalls?: Array<{ toolName: string; input: unknown; result?: unknown }>
  searchCalls?: Array<{ toolName: string; input: unknown }>
  done: boolean
}

export class WindsurfClient {
  private info: LanguageServerInfo | null = null
  private initialized = false
  /** Per-conversation cascade session id and step offset. */
  private conversationCascadeIds = new Map<string, string>()
  private conversationStepOffsets = new Map<string, number>()
  private conversationHasFullPrompt = new Map<string, boolean>()
  private conversationModelUids = new Map<string, string>()

  // Serialize sendAndAwait calls so two concurrent messages never corrupt the
  // shared session state or misroute tool requests.
  private sendQueue: Promise<unknown> = Promise.resolve()

  // Abort controller for the currently in-flight turn. Used to cancel the
  // active polling loop when the user presses stop in the CMS panel.
  private currentAbortController: AbortController | null = null

  /**
   * Discover and connect to the running Windsurf language server.
   */
  async connect(): Promise<boolean> {
    this.info = discoverLanguageServer()
    if (!this.info) {
      return false
    }

    try {
      await this.initializeCascade()
    } catch (err) {
      log('[WindsurfClient] InitializeCascadePanelState failed:', err)
    }

    return true
  }

  /**
   * Make a Connect-RPC call via HTTP POST with binary protobuf.
   *
   * Uses node:http instead of fetch because Bun's fetch + response.arrayBuffer()
   * blocks the JavaScript event loop on Windows when the server holds the TCP
   * body stream open (e.g. while waiting for a tool result).  node:http is
   * callback-driven and never blocks the event loop.
   */
  private async rpcCall(method: string, payload: Buffer, timeoutMs = 15000, signal?: AbortSignal): Promise<Buffer> {
    if (!this.info) throw new Error('Not connected')

    const url = `http://127.0.0.1:${this.info.port}/${SERVICE}/${method}`
    const csrfToken = this.info.csrfToken

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`RPC ${method} aborted`))
        return
      }

      const req = request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/proto',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrfToken,
          'Content-Length': payload.length,
        },
        timeout: timeoutMs,
        // agent: false prevents connection-pool reuse.  Bun's node:http
        // compatibility layer on Windows silently hangs when reusing a
        // connection that the remote server has closed.
        agent: false,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          cleanup()
          const buf = Buffer.concat(chunks)
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf)
          } else {
            const body = buf.toString('utf-8').slice(0, 500)
            reject(new Error(`RPC ${method} failed: HTTP ${res.statusCode}: ${body}`))
          }
        })
        res.on('error', (err) => {
          cleanup()
          reject(err)
        })
      })

      const onAbort = () => {
        req.destroy()
        cleanup()
        reject(new Error(`RPC ${method} aborted`))
      }
      let abortHandler: (() => void) | null = null
      const cleanup = () => {
        clearTimeout(safetyTimer)
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
      }
      if (signal) {
        abortHandler = onAbort
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      req.on('error', (err) => {
        cleanup()
        reject(err)
      })
      req.on('timeout', () => {
        req.destroy()
        cleanup()
        reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`))
      })

      // Safety net in case Bun's node:http layer doesn't fire the timeout event.
      const safetyTimer = setTimeout(() => {
        req.destroy()
        cleanup()
        reject(new Error(`RPC ${method} safety timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      req.write(payload)
      req.end()
    })
  }

  /**
   * Build the Metadata protobuf message.
   *
   * Fields (exa.codeium_common_pb.Metadata):
   *   1: ide_name, 2: extension_version, 3: api_key, 4: locale,
   *   5: os, 7: ide_version, 10: session_id, 12: extension_name
   */
  private sessionId: string = randomUUID()
  private requestId: number = 0

  private buildMetadata(): Buffer {
    if (!this.info) throw new Error('Not connected')
    this.requestId++
    // Metadata proto fields (exa.codeium_common_pb.Metadata):
    //   1: ide_name, 2: extension_version, 3: api_key, 4: locale,
    //   5: os, 7: ide_version, 9: request_id, 10: session_id, 12: extension_name,
    //   17: extension_path, 24: device_fingerprint, 28: ide_type
    const parts: Buffer[] = [
      encodeString(1, 'windsurf'),              // ide_name
      encodeString(2, '1.9600.41'),             // extension_version
      encodeString(4, 'en-US'),                 // locale
      encodeString(5, 'Windows'),             // os
      encodeString(7, '1.9600.41'),             // ide_version
      encodeString(12, 'windsurf'),             // extension_name
      encodeString(17, ''),                    // extension_path (empty ok)
      encodeString(28, 'VSCode'),               // ide_type
      encodeString(26, 'Unset'),               // plan_name (extension defaults to "Unset")
      encodeVarintField(9, this.requestId),    // request_id
    ]
    if (this.info.apiKey) {
      // The extension sends the FULL key including the "devin-session-token$" prefix
      parts.push(encodeString(3, this.info.apiKey))  // api_key
    }
    // session_id must be a UUIDv4 (generated at runtime by the extension)
    parts.push(encodeString(10, this.sessionId))
    return Buffer.concat(parts)
  }

  /**
   * Initialize the Cascade panel state (step 1).
   *
   * InitializeCascadePanelStateRequest:
   *   field 1: metadata (Metadata)
   *   field 3: workspace_trusted (bool)
   */
  async initializeCascade(): Promise<void> {
    if (this.initialized || !this.info) return

    const metadata = this.buildMetadata()
    const payload = Buffer.concat([
      encodeLengthDelimited(1, metadata),
      encodeBool(3, true),
    ])

    await this.rpcCall('InitializeCascadePanelState', payload)
    this.initialized = true
    log('[WindsurfClient] Cascade panel state initialized')
  }

  /**
   * Start a new Cascade session (step 2).
   *
   * StartCascadeRequest:
   *   field 1: metadata (Metadata)
   *   field 4: source (enum: CASCADE_CLIENT = 1)
   *
   * StartCascadeResponse:
   *   field 1: cascade_id (string)
   */
  async startCascade(conversationId: string, attachToActive = true, signal?: AbortSignal): Promise<string> {
    if (!this.info) throw new Error('Not connected')
    await this.initializeCascade()

    const existing = this.conversationCascadeIds.get(conversationId)
    // Reuse existing session when attachToActive is true
    if (attachToActive && existing) {
      log(`[WindsurfClient] Reusing cascade session for ${conversationId}: ${existing}`)
      return existing
    }

    const metadata = this.buildMetadata()
    const payload = Buffer.concat([
      encodeLengthDelimited(1, metadata),
      encodeVarintField(4, 1),
    ])

    const response = await this.rpcCall('StartCascade', payload, 15_000, signal)
    const cascadeId = parseStringField(response, 1)
    if (!cascadeId) throw new Error('StartCascade did not return a cascade_id')
    this.conversationCascadeIds.set(conversationId, cascadeId)
    this.conversationStepOffsets.set(conversationId, 0)
    log(`[WindsurfClient] Cascade started for ${conversationId}: ${cascadeId}`)
    return cascadeId
  }

  /**
   * Send a user message to Cascade (step 3).
   *
   * SendUserCascadeMessageRequest:
   *   field 1: cascade_id (string)
   *   field 2: items (repeated TextOrScopeItem)
   *   field 3: metadata (Metadata)
   *   field 5: cascade_config (CascadeConfig)
   *
   * TextOrScopeItem:
   *   field 1: text (string, oneof "chunk")
   *
   * CascadeConfig:
   *   field 1: planner_config (CascadePlannerConfig)
   *
   * CascadePlannerConfig:
   *   field 2: conversational (CascadeConversationalPlannerConfig, oneof)
   *   field 35: requested_model_uid (string)
   */
  async sendMessage(
    cascadeId: string,
    message: string,
    modelUid?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadata = this.buildMetadata()

    const item = encodeString(1, message)

    const plannerParts: Buffer[] = [encodeLengthDelimited(2, Buffer.alloc(0))]
    if (modelUid) {
      plannerParts.push(encodeString(35, modelUid))
    }
    const plannerConfig = Buffer.concat(plannerParts)

    const cascadeConfig = encodeLengthDelimited(1, plannerConfig)

    const payload = Buffer.concat([
      encodeString(1, cascadeId),
      encodeLengthDelimited(2, item),
      encodeLengthDelimited(3, metadata),
      encodeLengthDelimited(5, cascadeConfig),
    ])

    await this.rpcCall('SendUserCascadeMessage', payload, 15_000, signal)
    log(`[WindsurfClient] Message sent to cascade ${cascadeId}`)
  }

  /**
   * Poll for Cascade trajectory steps (step 4).
   *
   * GetCascadeTrajectoryStepsRequest:
   *   field 1: cascade_id (string)
   *   field 2: step_offset (uint32)
   *
   * GetCascadeTrajectoryStepsResponse:
   *   field 1: steps (repeated CortexTrajectoryStep)
   */
  async pollTranscript(
    cascadeId: string,
    stepOffset = 0,
    signal?: AbortSignal,
  ): Promise<{
    steps: ParsedStep[]
    done: boolean
    nextOffset: number
    hasToolSteps: boolean
    stepTypes: number[]
    statuses: number[]
    lastStepType: number
    lastStatus: number
  }> {
    const payload = Buffer.concat([
      encodeString(1, cascadeId),
      encodeVarintField(2, stepOffset),
    ])

    const response = await this.rpcCall('GetCascadeTrajectorySteps', payload, 15_000, signal)
    const result = parseTrajectoryStepsResponse(response, stepOffset)

    const nextOffset = stepOffset + result.totalSteps

    return {
      steps: result.steps,
      done: result.completed,
      nextOffset,
      hasToolSteps: result.hasToolSteps,
      stepTypes: result.stepTypes,
      statuses: result.statuses,
      lastStepType: result.lastStepType,
      lastStatus: result.lastStatus,
    }
  }

  /**
   * Archive/cleanup a Cascade trajectory (step 5).
   */
  async archiveCascade(conversationId: string): Promise<void> {
    // No archive method exists in the language server API.
    // Cascade sessions are ephemeral and cleaned up by the server.
    this.conversationCascadeIds.delete(conversationId)
    this.conversationStepOffsets.delete(conversationId)
    this.conversationHasFullPrompt.delete(conversationId)
    this.conversationModelUids.delete(conversationId)
  }

  /**
   * Fetch generator metadata for a Cascade session (step 4b).
   *
   * GetCascadeTrajectoryGeneratorMetadataRequest:
   *   field 1: cascade_id (string)
   *   field 2: generator_metadata_offset (uint32)
   *
   * GetCascadeTrajectoryGeneratorMetadataResponse:
   *   field 1: generator_metadata (repeated CortexStepGeneratorMetadata)
   *
   * CortexStepGeneratorMetadata:
   *   field 1: chat_model (oneof "metadata", ChatModelMetadata)
   *
   * ChatModelMetadata:
   *   field 4: usage (ModelUsageStats)
   *   field 13: credit_cost (int32)
   *
   * ModelUsageStats:
   *   field 2: input_tokens (uint64)
   *   field 3: output_tokens (uint64)
   *
   * Returns the input_tokens, output_tokens, and credit_cost from the most
   * recent ChatModelMetadata, which is the actual context token count
   * Windsurf displays in its UI.
   */
  async getGeneratorMetadata(
    cascadeId: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<{ inputTokens: number; outputTokens: number; creditCost: number; nextOffset: number }> {
    const payload = Buffer.concat([
      encodeString(1, cascadeId),
      encodeVarintField(2, offset),
    ])

    const response = await this.rpcCall('GetCascadeTrajectoryGeneratorMetadata', payload, 15_000, signal)
    const result = parseGeneratorMetadataResponse(response, offset)
    return result
  }

  /**
   * Reset the session so the next message starts a fresh cascade.
   * Pass a conversationId to reset a single thread, or omit to reset all.
   */
  resetSession(conversationId?: string): void {
    if (conversationId) {
      this.conversationCascadeIds.delete(conversationId)
      this.conversationStepOffsets.delete(conversationId)
      this.conversationHasFullPrompt.delete(conversationId)
      this.conversationModelUids.delete(conversationId)
      log(`[WindsurfClient] Session reset for ${conversationId}`)
    } else {
      this.conversationCascadeIds.clear()
      this.conversationStepOffsets.clear()
      this.conversationHasFullPrompt.clear()
      this.conversationModelUids.clear()
      log('[WindsurfClient] All sessions reset')
    }
  }

  /**
   * Full flow: send a message and wait for the complete response.
   * Polls the trajectory steps until Cascade signals completion.
   *
   * Calls are queued internally so two concurrent messages never race on the
   * shared cascadeId / lastStepOffset state.
   */
  sendAndAwait(
    conversationId: string,
    message: string,
    options?: {
      modelUid?: string
      attachToActive?: boolean
      pollIntervalMs?: number
      maxWaitMs?: number
      idleTimeoutMs?: number
      onEntry?: (entry: CascadeResponse) => void
      onContextTokens?: (inputTokens: number, outputTokens: number, creditCost: number) => void
      /** Return true while there is work (e.g. a browser tool) in flight that
       *  the language server is waiting for. Prevents premature idle timeout. */
      hasPendingWork?: () => boolean
    },
  ): Promise<{ entries: CascadeResponse[]; completed: boolean; cascadeId: string | null }> {
    const promise = this.sendQueue.then(() => this._doSendAndAwait(conversationId, message, options))
    // Absorb errors so a failed message doesn't block the queue forever
    this.sendQueue = promise.catch(() => {})
    return promise
  }

  private async _doSendAndAwait(
    conversationId: string,
    message: string,
    options?: {
      modelUid?: string
      attachToActive?: boolean
      pollIntervalMs?: number
      maxWaitMs?: number
      idleTimeoutMs?: number
      onEntry?: (entry: CascadeResponse) => void
      onContextTokens?: (inputTokens: number, outputTokens: number, creditCost: number) => void
      hasPendingWork?: () => boolean
    },
  ): Promise<{ entries: CascadeResponse[]; completed: boolean; cascadeId: string | null }> {
    const pollInterval = options?.pollIntervalMs ?? 2000
    const maxWait = options?.maxWaitMs ?? 300_000
    const idleTimeout = options?.idleTimeoutMs ?? 45_000
    const modelUid = options?.modelUid ?? 'glm-5-2'
    const attachToActive = options?.attachToActive ?? true

    // Abort controller for this turn; lets the relay stop the polling loop
    // when the user presses the stop button in the CMS panel.
    const abortController = new AbortController()
    this.currentAbortController = abortController
    const signal = abortController.signal

    // Reuse existing cascade session if attachToActive is true and we have one.
    // This keeps conversation context across CMS chat messages.
    // However, if the model UID changed since the session was started, we must
    // start a new cascade — the language server only honors requested_model_uid
    // at session creation, not on subsequent sendMessage calls.
    let cascadeId: string | null = null
    try {
      const existingCascadeId = attachToActive ? this.conversationCascadeIds.get(conversationId) ?? null : null
      const existingModelUid = this.conversationModelUids.get(conversationId) ?? null
      if (existingCascadeId && existingModelUid === modelUid) {
        cascadeId = existingCascadeId
      } else {
        if (existingCascadeId) {
          log(`[WindsurfClient] Model changed from ${existingModelUid} to ${modelUid} for ${conversationId} — starting new cascade session`)
        }
        cascadeId = await this.startCascade(conversationId, true, signal)
        this.conversationStepOffsets.set(conversationId, 0)
        this.conversationHasFullPrompt.set(conversationId, false)
        this.conversationModelUids.set(conversationId, modelUid)
      }
      await this.sendMessage(cascadeId, message, modelUid, signal)

      const reader = new TrajectoryReader()
      const allEntries: CascadeResponse[] = []
      const startTime = Date.now()
      let lastActivityTime = startTime
      let lastToolStepTime = 0 // when we last saw a tool call step
      let lastPlannerResponseTime = 0 // when we last saw a PLANNER_RESPONSE (thinking/text/tool)
      let stepOffset = this.conversationStepOffsets.get(conversationId) ?? 0
      let consecutiveErrors = 0
      let consecutiveEmptyPolls = 0
      let hasSeenSteps = false
      let completed = false
      let completionReason: 'native-done' | 'idle-timeout' | 'max-wait' | 'abort' | 'errors' | 'unknown' = 'unknown'
      let lastStepType = -1
      let lastStatus = -1
      let lastNextOffset = stepOffset
      let genMetadataOffset = 0

      while (Date.now() - startTime < maxWait) {
        await new Promise((r) => setTimeout(r, pollInterval))
        let steps: ParsedStep[]
        let done: boolean
        let nextOffset: number
        let stepTypes: number[]
        let statuses: number[]
        let hasToolSteps: boolean
        try {
          const result = await this.pollTranscript(cascadeId, stepOffset, signal)
          steps = result.steps
          done = result.done
          nextOffset = result.nextOffset
          stepTypes = result.stepTypes
          statuses = result.statuses
          hasToolSteps = result.hasToolSteps
          lastNextOffset = nextOffset
          if (stepTypes.length > 0) {
            lastStepType = stepTypes[stepTypes.length - 1]
            lastStatus = statuses[statuses.length - 1]
          }
          consecutiveErrors = 0
        } catch (err) {
          consecutiveErrors++
          const errMsg = err instanceof Error ? err.message : String(err)
          if (errMsg.includes('aborted')) {
            log('[WindsurfClient] Poll aborted by user — stopping current turn')
            completionReason = 'abort'
            break
          }
          const isTimeout = err instanceof Error && (err.name === 'AbortError' || errMsg.includes('abort') || errMsg.includes('timeout'))
          if (isTimeout) {
            log(`[WindsurfClient] Poll timeout (attempt ${consecutiveErrors}) after ${pollInterval}ms — language server may be waiting for a tool result`)
          } else {
            log(`[WindsurfClient] Poll error (attempt ${consecutiveErrors}): ${errMsg}`)
          }
          if (consecutiveErrors >= 5) {
            log('[WindsurfClient] Too many consecutive poll errors, giving up')
            completionReason = 'errors'
            break
          }
          continue
        }

        const stepsInThisPoll = nextOffset - stepOffset
        if (stepsInThisPoll > 0) {
          hasSeenSteps = true
          consecutiveEmptyPolls = 0
          lastActivityTime = Date.now()
        } else {
          consecutiveEmptyPolls++
        }

        const entriesBefore = allEntries.length
        const onEntry = (entry: CascadeResponse) => {
          allEntries.push(entry)
          options?.onEntry?.(entry)
        }
        const { committedCount } = reader.ingest(steps, done, onEntry)
        stepOffset = committedCount

        const entries = reader.getAllEntries()
        const entriesInThisPoll = entries.length - entriesBefore
        if (entries.length > 0) {
          // Any PLANNER_RESPONSE (thinking, text, or internal tool call) means
          // the AI is actively working. Reset the empty-poll counter so the
          // idle timeout is evaluated from the latest activity, not from a
          // previous text chunk.
          consecutiveEmptyPolls = 0
          lastActivityTime = Date.now()
          lastPlannerResponseTime = Date.now()
        }
        if (hasToolSteps) {
          lastToolStepTime = Date.now()
        }

        log(`[WindsurfClient] Poll summary: stepsInPoll=${stepsInThisPoll}, newEntries=${entriesInThisPoll}, totalEntries=${entries.length}, stepOffset=${stepOffset}, stepTypes=[${stepTypes.join(',')}], statuses=[${statuses.join(',')}], emptyPolls=${consecutiveEmptyPolls}`)

        // Poll generator metadata for real context token usage. This is the
        // same data Windsurf's UI uses to show "63% (125K / 200K)".
        if (options?.onContextTokens) {
          try {
            const genMeta = await this.getGeneratorMetadata(cascadeId, genMetadataOffset, signal)
            if (genMeta.nextOffset > genMetadataOffset) {
              genMetadataOffset = genMeta.nextOffset
            }
            // Always emit the latest known token count (even if no new
            // metadata entries arrived this poll) so the meter stays live.
            if (genMeta.inputTokens > 0) {
              options.onContextTokens(genMeta.inputTokens, genMeta.outputTokens, genMeta.creditCost)
            }
          } catch (err) {
            // Non-fatal — don't let metadata polling break the chat loop
            const msg = err instanceof Error ? err.message : String(err)
            log(`[WindsurfClient] Generator metadata poll failed (non-fatal): ${msg}`)
          }
        }

        // Guard against stale done=true: when reusing a cascade session, the
        // first poll may return the previous turn's completion state before
        // the language server has processed the new message. Only trust done
        // after we've seen at least one new step or new content in this turn.
        if (done && (stepsInThisPoll > 0 || entriesInThisPoll > 0 || hasSeenSteps)) {
          completed = true
          completionReason = 'native-done'
          break
        }
        if (done && !hasSeenSteps && consecutiveEmptyPolls <= 1) {
          log(`[WindsurfClient] Ignoring stale done=true (no steps seen yet in this turn) — waiting for new activity`)
        }

        const hasPending = options?.hasPendingWork?.() ?? false

        const msSinceToolStep = Date.now() - lastToolStepTime
        // The post-tool guard stays active until the AI produces a new
        // PLANNER_RESPONSE after the last tool step. This prevents the relay
        // from declaring completion while the AI is re-thinking between tool
        // calls, which can take 30-60s+ for large tool results.
        const aiRespondedAfterTool = lastPlannerResponseTime > lastToolStepTime
        const recentlyUsedTools = lastToolStepTime > 0 && msSinceToolStep < 60_000 && !aiRespondedAfterTool
        if (recentlyUsedTools && consecutiveEmptyPolls > 0) {
          consecutiveEmptyPolls = 0
        }

        if (recentlyUsedTools && consecutiveEmptyPolls > 0 && consecutiveEmptyPolls % 5 === 0) {
          log(`[WindsurfClient] Post-tool guard active — ${Math.round(msSinceToolStep / 1000)}s since last tool, waiting for AI to re-think...`)
        }

        // Idle timeout: dynamic based on whether we've seen output.
        // After text/thinking/tool entries → 15s grace period for trailing steps,
        // 20s for thinking-only responses, 45s before any output, 60s when a tool is
        // pending or the post-tool guard is active.
        let effectiveTimeout = idleTimeout
        if (hasPending || recentlyUsedTools) {
          effectiveTimeout = Math.max(idleTimeout, 60_000)
        } else if (entries.length > 0) {
          effectiveTimeout = 15_000
        } else if (hasSeenSteps) {
          effectiveTimeout = 20_000
        }
        if (Date.now() - lastActivityTime > effectiveTimeout) {
          log(`[WindsurfClient] Idle timeout (${effectiveTimeout}ms) — no new entries since last activity, treating as complete`)
          completed = true
          completionReason = 'idle-timeout'
          break
        }
      }

      if (!completed) {
        completionReason = 'max-wait'
        log(`[WindsurfClient] Polling ended after ${Math.round((Date.now() - startTime) / 1000)}s without completion (timeout or too many errors)`)
      }

      log(`[WindsurfClient] Turn completed=${completed} reason=${completionReason} duration=${Math.round((Date.now() - startTime) / 1000)}s lastStepType=${lastStepType} lastStatus=${lastStatus} lastEntries=${allEntries.length}`)

      // Save offset for next message in the same conversation. On abort we keep
      // the current offset so the next message can resume the unfinished turn.
      if (completionReason !== 'abort') {
        stepOffset = lastNextOffset
      }
      this.conversationStepOffsets.set(conversationId, stepOffset)
      return { entries: allEntries, completed, cascadeId }
    } finally {
      this.currentAbortController = null
    }
  }

  /**
   * Abort the currently in-flight turn. This cancels the active RPC poll and
   * clears the send queue so the next CMS message starts immediately instead of
   * waiting behind the aborted turn.
   */
  abortCurrentTurn(): void {
    this.currentAbortController?.abort()
    this.currentAbortController = null
    this.sendQueue = Promise.resolve()
    log('[WindsurfClient] Current turn aborted; send queue reset')
  }

  isConnected(): boolean {
    return this.info !== null
  }

  getCurrentCascadeId(conversationId?: string): string | null {
    return conversationId ? this.conversationCascadeIds.get(conversationId) ?? null : null
  }

  hasInjectedFullPrompt(conversationId: string): boolean {
    return this.conversationHasFullPrompt.get(conversationId) ?? false
  }

  markInjectedFullPrompt(conversationId: string): void {
    this.conversationHasFullPrompt.set(conversationId, true)
  }

  /** List available model configs from the Windsurf auth state (only valid after connect). */
  getModelConfigs(): Array<{
    label: string
    modelUid: string
    disabled: boolean
    isPremium: boolean
    maxTokens: number
    creditMultiplier: number
    pricing?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }
  }> {
    if (!this.info) return []
    return this.info.modelConfigs
  }

  /**
   * Fetch live model configs from GetUserStatus RPC.
   *
   * GetUserStatusRequest:
   *   field 1: metadata (Metadata)
   *
   * GetUserStatusResponse:
   *   field 1: user_status (UserStatus)
   *
   * UserStatus:
   *   field 33: cascade_model_config_data (CascadeModelConfigData)
   *
   * CascadeModelConfigData:
   *   field 1: client_model_configs (repeated ClientModelConfig)
   *
   * Updates the cached modelConfigs with live data including maxTokens
   * (context window) and creditMultiplier.
   */
  async fetchUserStatus(): Promise<void> {
    if (!this.info) return
    const metadata = this.buildMetadata()
    const payload = encodeLengthDelimited(1, metadata)
    const response = await this.rpcCall('GetUserStatus', payload, 15_000)
    // Parse UserStatus from response field 1
    const userStatus = extractLengthDelimitedField(response, 1)
    if (!userStatus) {
      log('[WindsurfClient] GetUserStatus: no user_status in response')
      return
    }
    // Parse CascadeModelConfigData from UserStatus field 33
    const configData = extractLengthDelimitedField(userStatus, 33)
    if (!configData) {
      log('[WindsurfClient] GetUserStatus: no cascade_model_config_data')
      return
    }
    // Parse client_model_configs (repeated ClientModelConfig, field 1)
    const configs = parseModelConfigsResponse(configData)
    if (configs.length > 0) {
      this.info.modelConfigs = configs
      log(`[WindsurfClient] GetUserStatus: ${configs.length} model configs fetched`)
      log(`[WindsurfClient] Models: ${configs.map((c) => `${c.label} (${c.modelUid}) ctx=${c.maxTokens} cr=${c.creditMultiplier}`).join(', ')}`)
    } else {
      log('[WindsurfClient] GetUserStatus: 0 model configs in response')
    }
  }
}

// ─── Trajectory step parsing ────────────────────────────────────────────────

/**
 * Parse GetCascadeTrajectoryStepsResponse.
 *
 * Response field 1 contains repeated CortexTrajectoryStep messages.
 * Each step has:
 *   field 1: type (enum — see CortexStepType)
 *   field 4: status (enum)
 *   field 5: metadata (message)
 *   and a oneof "step" with step-specific data.
 *
 * We only extract content from PLANNER_RESPONSE steps (type 15). Every other
 * step type is metadata/tooling that carries no user-facing text — the
 * assistant's reply always lands in the planner step's `response` field once
 * that step reaches a terminal status.
 *
 * IMPORTANT: parsing is now a pure, stateless snapshot. A PLANNER_RESPONSE
 * step MUTATES IN PLACE as it streams (thinking → response → tool calls), so
 * we return the full current content of each step and let the stateful
 * `TrajectoryReader` diff successive snapshots and emit only new content. The
 * old design advanced a step offset past a still-streaming step and lost the
 * final response text — see the module reassessment (2026-07).
 */

/** One trajectory step's current content snapshot. Index is absolute. */
interface ParsedStep {
  /** Absolute index of the step within the whole trajectory. */
  index: number
  type: number
  status: number
  thinking: string | null
  response: string | null
  toolCalls: Array<{ toolName: string; input: unknown }>
  searchCalls: Array<{ toolName: string; input: unknown }>
}

interface TrajectoryParseResult {
  /** Steps returned by this poll, absolute-indexed via the request's stepOffset. */
  steps: ParsedStep[]
  totalSteps: number
  completed: boolean
  hasToolSteps: boolean
  stepTypes: number[]
  statuses: number[]
  lastStepType: number
  lastStatus: number
}

function isTerminalStep(step: ParsedStep): boolean {
  // Type 7/5 are explicit completion steps; status 2 is a completion marker.
  if (step.type === 7 || step.type === 5) return true
  if (step.status === 2) return true
  return false
}

function parseTrajectoryStepsResponse(data: Buffer, stepOffset = 0): TrajectoryParseResult {
  const steps: ParsedStep[] = []
  const stepTypes: number[] = []
  const statuses: number[] = []
  let offset = 0
  let stepCount = 0
  let completed = false
  let hasToolSteps = false
  let lastStepType = -1
  let lastStatus = -1

  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const wireType = tag & 0x7
    const fieldNum = tag >>> 3

    if (wireType === 2 && fieldNum === 1) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const stepData = data.subarray(offset, offset + len)
      offset += len
      stepCount++
      const absoluteIndex = stepOffset + stepCount - 1

      const stepType = getStepType(stepData)
      const status = getStepStatus(stepData)
      stepTypes.push(stepType)
      statuses.push(status)
      lastStepType = stepType
      lastStatus = status

      if (stepType === 38 || stepType === 8 || stepType === 9) {
        hasToolSteps = true
      }

      if (stepType === 7 || stepType === 5) {
        completed = true
        log(`[WindsurfClient] Step ${absoluteIndex}: type=${stepType} status=${status} (DONE)`)
      } else if (status === 2 || status === 3) {
        if (status === 2) {
          completed = true
          log(`[WindsurfClient] Step ${absoluteIndex}: type=${stepType} status=${status} (DONE-by-status)`)
        } else {
          log(`[WindsurfClient] Step ${absoluteIndex}: type=${stepType} status=${status} (terminal-status)`)
        }
      }

      if (stepType === 15) {
        const { thinking, response, toolCalls, searchCalls } = extractPlannerResponse(stepData)
        const hasContent = thinking || response || toolCalls.length > 0 || searchCalls.length > 0
        if (hasContent) {
          log(`[WindsurfClient] Step ${absoluteIndex}: PLANNER_RESPONSE thinking=${thinking?.slice(0, 60) ?? 'none'} response=${response?.slice(0, 60) ?? 'none'} tools=${toolCalls.length} search=${searchCalls.length}`)
          // Reverse-engineering aid: log all protobuf fields of PLANNER_RESPONSE steps.
          // The Windsurf IDE shows a context-usage percentage (e.g. 63% 125K/200K).
          // That data must be present in one of these fields; correlate with UI.
          log(`[WindsurfClient] Step ${absoluteIndex} fields: ${dumpProtobufFields(stepData)}`)
        }
        if (toolCalls.length > 0 || searchCalls.length > 0) {
          hasToolSteps = true
        }
        steps.push({
          index: absoluteIndex,
          type: stepType,
          status,
          thinking,
          response,
          toolCalls,
          searchCalls,
        })
      } else if (stepType === 17) {
        const err = extractErrorText(stepData)
        if (err) {
          log('[WindsurfClient] Cascade error step:', err.slice(0, 200))
        }
      } else {
        log(`[WindsurfClient] Step ${absoluteIndex}: type=${stepType} status=${status} (skipped)`)
      }
    } else {
      offset = skipField(data, offset, wireType)
      if (offset < 0) break
    }
  }

  log(`[WindsurfClient] Parsed ${steps.length} PLANNER_RESPONSE steps from ${stepCount} total steps, completed=${completed}, stepTypes=[${stepTypes.join(',')}], statuses=[${statuses.join(',')}]`)
  if (data.length > 0) {
    log(`[WindsurfClient] Response-level fields: ${dumpProtobufFields(data)}`)
  }
  if (stepCount === 0 && data.length > 0) {
    log(`[WindsurfClient] Empty step count but ${data.length} bytes in response — raw hex: ${data.subarray(0, 128).toString('hex')}`)
  } else if (stepCount === 0) {
    log(`[WindsurfClient] Empty response (0 bytes) from language server for stepOffset=${stepOffset}`)
  }
  return { steps, totalSteps: stepCount, completed, hasToolSteps, stepTypes, statuses, lastStepType, lastStatus }
}

/** Per-step state used to compute content deltas between trajectory snapshots. */
interface StepReaderState {
  thinkingEmitted: number
  responseEmitted: number
  toolCallKeys: Set<string>
  searchCallKeys: Set<string>
}

/** Stable key for a tool/search call so re-reads of the same step don't duplicate. */
function callKey(toolName: string, input: unknown): string {
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort() : undefined
  return `${toolName}::${JSON.stringify(input, keys)}`
}

/**
 * Stateful diff reader. Given a sequence of full trajectory snapshots, it emits
 * only the new content that has appeared since the last snapshot.
 *
 * The reader keeps the last step open for re-reading until it is terminal; all
 * earlier steps are considered committed and never re-read. This prevents the
 * relay from advancing past a streaming PLANNER_RESPONSE step and losing its
 * final response text.
 */
class TrajectoryReader {
  private stepState = new Map<number, StepReaderState>()
  private committedStepCount = 0
  private emittedAllEntries: CascadeResponse[] = []

  /**
   * Ingest a new snapshot and call `onEntry` for each new content delta.
   * Returns the number of terminal steps seen, which determines the safe offset
   * for the next poll.
   */
  ingest(
    steps: ParsedStep[],
    completed: boolean,
    onEntry: (entry: CascadeResponse) => void,
  ): { committedCount: number } {
    let newMaxCommitted = this.committedStepCount

    for (const step of steps) {
      if (step.index < this.committedStepCount) {
        // Already committed; should not happen because the caller always polls
        // from committedStepCount, but defensively skip.
        continue
      }

      const state = this.stepState.get(step.index) ?? {
        thinkingEmitted: 0,
        responseEmitted: 0,
        toolCallKeys: new Set<string>(),
        searchCallKeys: new Set<string>(),
      }

      // Thinking delta: new suffix.
      if (step.thinking && step.thinking.length > state.thinkingEmitted) {
        const newThinking = step.thinking.slice(state.thinkingEmitted)
        state.thinkingEmitted = step.thinking.length
        const entry: CascadeResponse = { thinking: newThinking, done: false }
        this.emittedAllEntries.push(entry)
        onEntry(entry)
      }

      // Search calls: new calls only.
      const newSearchCalls = step.searchCalls.filter((c) => {
        const key = callKey(c.toolName, c.input)
        if (state.searchCallKeys.has(key)) return false
        state.searchCallKeys.add(key)
        return true
      })
      if (newSearchCalls.length > 0) {
        const entry: CascadeResponse = { searchCalls: newSearchCalls, done: false }
        this.emittedAllEntries.push(entry)
        onEntry(entry)
      }

      // Tool calls: new calls only.
      const newToolCalls = step.toolCalls.filter((c) => {
        const key = callKey(c.toolName, c.input)
        if (state.toolCallKeys.has(key)) return false
        state.toolCallKeys.add(key)
        return true
      })
      if (newToolCalls.length > 0) {
        const entry: CascadeResponse = {
          toolCalls: newToolCalls.map((tc) => ({ ...tc, result: undefined })),
          done: false,
        }
        this.emittedAllEntries.push(entry)
        onEntry(entry)
      }

      // Response text delta: new suffix.
      if (step.response && step.response.length > state.responseEmitted) {
        const newResponse = step.response.slice(state.responseEmitted)
        state.responseEmitted = step.response.length
        const entry: CascadeResponse = { text: newResponse, done: false }
        this.emittedAllEntries.push(entry)
        onEntry(entry)
      }

      this.stepState.set(step.index, state)

      // Commit every step that is fully behind the current (streaming) tail.
      if (isTerminalStep(step) || step.index < this.committedStepCount + steps.length - 1) {
        newMaxCommitted = Math.max(newMaxCommitted, step.index + 1)
      }
    }

    if (completed) {
      // If the trajectory is complete, commit everything we've seen so the
      // next message in this conversation starts from the correct offset.
      const maxSeen = steps.length > 0 ? steps[steps.length - 1].index + 1 : this.committedStepCount
      newMaxCommitted = Math.max(newMaxCommitted, maxSeen)
    }

    this.committedStepCount = newMaxCommitted
    return { committedCount: this.committedStepCount }
  }

  getAllEntries(): CascadeResponse[] {
    return this.emittedAllEntries
  }
}

/**
 * Read the step type enum value from a CortexTrajectoryStep message.
 * Field 1 is the type enum (varint).
 */
function getStepType(data: Buffer): number {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (fieldNum === 1 && wireType === 0) {
      const { value } = decodeVarint(data, offset)
      return value
    }
    offset = skipField(data, offset, wireType)
    if (offset < 0) break
  }
  return -1
}

/**
 * Read the step status enum value from a CortexTrajectoryStep message.
 * Field 4 is the status enum (varint).
 */
function getStepStatus(data: Buffer): number {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (fieldNum === 4 && wireType === 0) {
      const { value } = decodeVarint(data, offset)
      return value
    }
    offset = skipField(data, offset, wireType)
    if (offset < 0) break
  }
  return -1
}

/**
 * Debug helper: dump all field numbers found in a protobuf message.
 */
function dumpProtobufFields(data: Buffer): string {
  const fields: string[] = []
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7
    let preview = ''
    if (wireType === 2) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const slice = data.subarray(offset, Math.min(offset + 20, offset + len))
      preview = `=${slice.toString('hex').slice(0, 16)}...(${len})`
      offset += len
    } else if (wireType === 0) {
      const { value } = decodeVarint(data, offset)
      preview = `=${value}`
      while (offset < data.length && (data[offset++] & 0x80) !== 0) {}
    } else {
      offset = skipField(data, offset, wireType)
    }
    fields.push(`${fieldNum}(${wireType})${preview}`)
    if (offset < 0) break
  }
  return fields.join(', ')
}

/**
 * Extract thinking, response text, and internal tool calls from a
 * PLANNER_RESPONSE step.
 *
 * The oneof field for planner_response is field 20 in CortexTrajectoryStep.
 * Inside CortexStepPlannerResponse:
 *   field 1: response (the actual assistant text)
 *   field 3: thinking (internal reasoning)
 *   field 6: message_id (bot-UUID noise — skip!)
 *   field 7: tool_calls (repeated) {f1: tool_id, f2: tool_name, f3: params_json}
 *   field 8: modified_response (alternative text)
 */
function extractPlannerResponse(data: Buffer): {
  thinking: string | null
  response: string | null
  toolCalls: Array<{ toolName: string; input: unknown }>
  searchCalls: Array<{ toolName: string; input: unknown }>
} {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2 && fieldNum === 20) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const plannerData = data.subarray(offset, offset + len)
      const thinking = parseStringField(plannerData, 3)
      const response = parseStringField(plannerData, 1)
      const modified = parseStringField(plannerData, 8)
      const { toolCalls, searchCalls } = extractPlannerToolCalls(plannerData)
      if (!thinking && !response && !modified && toolCalls.length === 0 && searchCalls.length === 0) {
        log(`[WindsurfClient] PlannerResponse fields: ${dumpProtobufFields(plannerData)}`)
      }
      return { thinking, response: response || modified || null, toolCalls, searchCalls }
    }
    offset = skipField(data, offset, wireType)
    if (offset < 0) break
  }
  log(`[WindsurfClient] Step fields: ${dumpProtobufFields(data)}`)
  return { thinking: null, response: null, toolCalls: [], searchCalls: [] }
}

function isSearchTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('grep') || lower.includes('search') || lower === 'read_file' || lower === 'readfile'
}

function extractPlannerToolCalls(data: Buffer): {
  toolCalls: Array<{ toolName: string; input: unknown }>
  searchCalls: Array<{ toolName: string; input: unknown }>
} {
  const toolCalls: Array<{ toolName: string; input: unknown }> = []
  const searchCalls: Array<{ toolName: string; input: unknown }> = []

  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2 && fieldNum === 7) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const toolData = data.subarray(offset, offset + len)
      offset += len
      const toolName = parseStringField(toolData, 2)
      const paramsJson = parseStringField(toolData, 3)
      if (toolName) {
        let input: unknown = {}
        if (paramsJson) {
          try {
            input = JSON.parse(paramsJson)
          } catch {
            input = { raw: paramsJson }
          }
        }
        const call = { toolName, input }
        if (isSearchTool(toolName)) {
          searchCalls.push(call)
        } else {
          toolCalls.push(call)
        }
      }
      continue
    }
    offset = skipField(data, offset, wireType)
    if (offset < 0) break
  }

  return { toolCalls, searchCalls }
}

/**
 * Extract error text from an ERROR_MESSAGE step.
 * The oneof field for error_message is field 24 in CortexTrajectoryStep.
 */
function extractErrorText(data: Buffer): string | null {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2 && fieldNum === 24) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const msgData = data.subarray(offset, offset + len)
      return extractTextFromNestedMessage(msgData)
    }
    offset = skipField(data, offset, wireType)
    if (offset < 0) break
  }
  return null
}


/**
 * Parse a single ModelDimension message.
 * Fields: label(1), value(2), denominator(3), kind(6).
 */
function parseModelDimension(data: Buffer): { label: string; value: number; denominator: string; kind: number } | null {
  const label = parseStringField(data, 1) ?? ''
  const value = parseDoubleField(data, 2) ?? 0
  const denominator = parseStringField(data, 3) ?? ''
  const kind = parseUint32Field(data, 6) ?? 0
  if (!label) return null
  return { label, value, denominator, kind }
}

/**
 * Parse a repeated model_dimensions field (field 32) from a ClientModelConfig
 * and build a pricing object from dimensions labeled Input, Output, and
 * Cached input.
 */
function parseModelPricing(configData: Buffer): { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number } | undefined {
  let inputPerMTok: number | null = null
  let outputPerMTok: number | null = null
  let cachedInputPerMTok: number | null = null

  let offset = 0
  while (offset < configData.length) {
    const { value: tag, bytesRead } = decodeVarint(configData, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2 && fieldNum === 32) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(configData, offset)
      offset += lenBytes
      const dimData = configData.subarray(offset, offset + len)
      offset += len
      const dim = parseModelDimension(dimData)
      if (dim && dim.value > 0) {
        const normalized = dim.denominator.toLowerCase() === '1m' ? dim.value : dim.value
        const label = dim.label.toLowerCase()
        if (label === 'input') inputPerMTok = normalized
        else if (label === 'output') outputPerMTok = normalized
        else if (label.includes('cached') && label.includes('input')) cachedInputPerMTok = normalized
      }
    } else {
      offset = skipField(configData, offset, wireType)
      if (offset < 0) break
    }
  }

  if (inputPerMTok === null && outputPerMTok === null) return undefined
  return {
    inputPerMTok: inputPerMTok ?? 0,
    outputPerMTok: outputPerMTok ?? 0,
    ...(cachedInputPerMTok != null ? { cachedInputPerMTok } : {}),
  }
}

/**
 * Parse GetCascadeModelConfigsResponse.
 *
 * Response field 1 contains repeated ClientModelConfig messages.
 * For each config we extract:
 *   label(1), model_uid(22), disabled(4), is_premium(7),
 *   max_tokens(18) — context window for this model
 *   credit_multiplier(3) — cost multiplier
 *   model_info(23) → ModelInfo.max_tokens(4) — fallback context window
 *   model_dimensions(32) → ModelDimension — per-token pricing
 */
function parseModelConfigsResponse(data: Buffer): Array<{
  label: string
  modelUid: string
  disabled: boolean
  isPremium: boolean
  maxTokens: number
  creditMultiplier: number
  pricing?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }
}> {
  const configs: Array<{
    label: string
    modelUid: string
    disabled: boolean
    isPremium: boolean
    maxTokens: number
    creditMultiplier: number
    pricing?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }
  }> = []
  let offset = 0

  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2 && fieldNum === 1) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const configData = data.subarray(offset, offset + len)
      offset += len

      const label = parseStringField(configData, 1) ?? ''
      const modelUid = parseStringField(configData, 22) ?? ''
      const disabled = parseBoolField(configData, 4) ?? false
      const isPremium = parseBoolField(configData, 7) ?? false
      const creditMultiplier = parseDoubleField(configData, 3) ?? 0

      // max_tokens (field 18) on ClientModelConfig is the context window.
      // Fall back to model_info.max_tokens (field 23 → field 4) if field 18 is 0.
      let maxTokens = parseUint32Field(configData, 18) ?? 0
      if (maxTokens === 0) {
        const modelInfo = extractLengthDelimitedField(configData, 23)
        if (modelInfo) {
          maxTokens = parseUint32Field(modelInfo, 4) ?? 0
        }
      }

      const pricing = parseModelPricing(configData)

      if (label && modelUid) {
        configs.push({ label, modelUid, disabled, isPremium, maxTokens, creditMultiplier, pricing })
      }
    } else {
      offset = skipField(data, offset, wireType)
      if (offset < 0) break
    }
  }

  return configs
}

/**
 * Extract readable text from a nested protobuf message.
 * Looks for string fields that look like natural language text.
 */
function extractTextFromNestedMessage(data: Buffer): string | null {
  const texts: string[] = []
  let offset = 0

  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const wireType = tag & 0x7

    if (wireType === 2) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      const fieldData = data.subarray(offset, offset + len)
      offset += len

      try {
        const text = fieldData.toString('utf8')
        // Only include if it looks like readable assistant text
        if (fieldData.length > 2 && isPrintable(text) && isLikelyNaturalLanguage(text)) {
          texts.push(text)
        }
      } catch { /* ignore */ }
    } else {
      offset = skipField(data, offset, wireType)
      if (offset < 0) break
    }
  }

  return texts.length > 0 ? texts.join('\n') : null
}

function isPrintable(str: string): boolean {
  if (str.length === 0) return false
  const printable = str.replace(/[\x20-\x7E\n\r\t]/g, '')
  return (str.length - printable.length) / str.length > 0.8
}

/**
 * Filter out strings that are clearly not natural language assistant text.
 */
function isLikelyNaturalLanguage(text: string): boolean {
  // Reject system memory markers
  if (text.includes('<SYSTEM-RETRIEVED-MEMORY')) return false
  if (text.includes('</SYSTEM-RETRIEVED-MEMORY>')) return false
  // Reject file paths
  if (text.startsWith('file:///')) return false
  // Reject markdown artifacts
  if (text.startsWith('markdown(')) return false
  if (text.startsWith('Bb:')) return false
  // Reject UUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) return false
  // Reject very short strings
  if (text.length < 3) return false
  // Reject strings that are mostly non-alphanumeric (binary data)
  const alnum = text.replace(/[^a-zA-Z0-9\s]/g, '').length
  if (alnum / text.length < 0.3) return false
  return true
}

/**
 * Parse GetCascadeTrajectoryGeneratorMetadataResponse.
 *
 * Response field 1 contains repeated CortexStepGeneratorMetadata messages.
 * Inside each CortexStepGeneratorMetadata:
 *   field 1: chat_model (oneof "metadata", ChatModelMetadata) — length-delimited
 *
 * Inside ChatModelMetadata:
 *   field 4: usage (ModelUsageStats) — length-delimited
 *   field 13: credit_cost (int32, varint)
 *
 * Inside ModelUsageStats:
 *   field 2: input_tokens (uint64, varint)
 *   field 3: output_tokens (uint64, varint)
 *
 * We return the input/output tokens and credit_cost from the most recent
 * ChatModelMetadata entry, which represents the latest LLM call's usage.
 */
function parseGeneratorMetadataResponse(
  data: Buffer,
  offset: number,
): { inputTokens: number; outputTokens: number; creditCost: number; nextOffset: number } {
  let pos = 0
  let count = 0
  let lastInputTokens = 0
  let lastOutputTokens = 0
  let lastCreditCost = 0

  while (pos < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, pos)
    if (bytesRead === 0) break
    pos += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2 && fieldNum === 1) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, pos)
      pos += lenBytes
      const genMeta = data.subarray(pos, pos + len)
      pos += len
      count++

      // Extract chat_model (field 1) from CortexStepGeneratorMetadata
      const chatModel = extractLengthDelimitedField(genMeta, 1)
      if (chatModel) {
        // Extract usage (field 4) from ChatModelMetadata
        const usage = extractLengthDelimitedField(chatModel, 4)
        if (usage) {
          // Extract input_tokens (field 2) and output_tokens (field 3) from ModelUsageStats
          const inputTokens = extractVarintField(usage, 2)
          const outputTokens = extractVarintField(usage, 3)
          // Extract credit_cost (field 13) from ChatModelMetadata
          const creditCost = extractVarintField(chatModel, 13)
          if (inputTokens > 0) {
            lastInputTokens = inputTokens
            lastOutputTokens = outputTokens
            lastCreditCost = creditCost
            log(`[WindsurfClient] GeneratorMetadata #${count}: input_tokens=${inputTokens} output_tokens=${outputTokens} credit_cost=${creditCost}`)
          }
        }
      }
    } else {
      pos = skipField(data, pos, wireType)
      if (pos < 0) break
    }
  }

  return {
    inputTokens: lastInputTokens,
    outputTokens: lastOutputTokens,
    creditCost: lastCreditCost,
    nextOffset: offset + count,
  }
}

/**
 * Extract a length-delimited field (wire type 2) from a protobuf message.
 * Returns the inner bytes, or null if the field is not present.
 */
function extractLengthDelimitedField(data: Buffer, fieldNumber: number): Buffer | null {
  let pos = 0
  while (pos < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, pos)
    if (bytesRead === 0) break
    pos += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 2) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, pos)
      pos += lenBytes
      return data.subarray(pos, pos + len)
    }
    pos = skipField(data, pos, wt)
    if (pos < 0) break
  }
  return null
}

/**
 * Extract a varint field (wire type 0) from a protobuf message.
 * Returns the value, or 0 if the field is not present.
 */
function extractVarintField(data: Buffer, fieldNumber: number): number {
  let pos = 0
  while (pos < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, pos)
    if (bytesRead === 0) break
    pos += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 0) {
      const { value } = decodeVarint(data, pos)
      return value
    }
    pos = skipField(data, pos, wt)
    if (pos < 0) break
  }
  return 0
}
