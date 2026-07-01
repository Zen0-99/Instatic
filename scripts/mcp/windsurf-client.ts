/**
 * Windsurf Connect-RPC client — communicates with the local Windsurf language
 * server via HTTP Connect-RPC (Buf Connect protocol) to send/receive Cascade
 * chat messages and discover available models.
 *
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
  let offset = 0
  while (offset < data.length) {
    const { value: tag, bytesRead } = decodeVarint(data, offset)
    offset += bytesRead
    const fn = tag >>> 3
    const wt = tag & 0x7

    if (fn === fieldNumber && wt === 2) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(data, offset)
      offset += lenBytes
      return data.subarray(offset, offset + len).toString('utf8')
    }
    offset = skipField(data, offset, wt)
    if (offset < 0) return null
  }
  return null
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

// ─── Discovery ──────────────────────────────────────────────────────────────

interface LanguageServerInfo {
  pid: number
  port: number
  csrfToken: string
  apiKey: string
  installationId: string
  modelConfigs: Array<{ label: string; modelUid: string; disabled: boolean; isPremium: boolean }>
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
    let pids: Array<{ pid: number; cmdline: string }> = []
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

  return { pid, port, csrfToken, apiKey, installationId, modelConfigs }
}

// ─── Connect-RPC client ─────────────────────────────────────────────────────

const SERVICE = 'exa.language_server_pb.LanguageServerService'

export interface CascadeResponse {
  text?: string
  thinking?: string
  toolCalls?: Array<{ toolName: string; input: unknown; result: unknown }>
  done: boolean
}

export class WindsurfClient {
  private info: LanguageServerInfo | null = null
  private cascadeId: string | null = null
  private initialized = false
  private lastStepOffset = 0
  /** Whether the current cascade session has already received the full prompt injection. */
  hasInjectedFullPrompt = false

  // Serialize sendAndAwait calls so two concurrent messages never corrupt the
  // shared cascadeId / lastStepOffset state or misroute tool requests.
  private sendQueue: Promise<unknown> = Promise.resolve()

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
  private async rpcCall(method: string, payload: Buffer, timeoutMs = 15000): Promise<Buffer> {
    if (!this.info) throw new Error('Not connected')

    const url = `http://127.0.0.1:${this.info.port}/${SERVICE}/${method}`
    const csrfToken = this.info.csrfToken

    return new Promise((resolve, reject) => {
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
          const buf = Buffer.concat(chunks)
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf)
          } else {
            const body = buf.toString('utf-8').slice(0, 500)
            reject(new Error(`RPC ${method} failed: HTTP ${res.statusCode}: ${body}`))
          }
        })
        res.on('error', (err) => reject(err))
      })

      req.on('error', (err) => reject(err))
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`))
      })

      // Safety net in case Bun's node:http layer doesn't fire the timeout event.
      const safetyTimer = setTimeout(() => {
        req.destroy()
        reject(new Error(`RPC ${method} safety timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      req.on('response', () => clearTimeout(safetyTimer))
      req.on('error', () => clearTimeout(safetyTimer))
      req.on('timeout', () => clearTimeout(safetyTimer))

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
  async startCascade(attachToActive = true): Promise<string> {
    if (!this.info) throw new Error('Not connected')
    await this.initializeCascade()

    // Reuse existing session when attachToActive is true
    if (attachToActive && this.cascadeId) {
      log(`[WindsurfClient] Reusing cascade session: ${this.cascadeId}`)
      return this.cascadeId
    }

    const metadata = this.buildMetadata()
    const payload = Buffer.concat([
      encodeLengthDelimited(1, metadata),
      encodeVarintField(4, 1),
    ])

    const response = await this.rpcCall('StartCascade', payload)
    this.cascadeId = parseStringField(response, 1)
    if (!this.cascadeId) throw new Error('StartCascade did not return a cascade_id')
    log(`[WindsurfClient] Cascade started: ${this.cascadeId}`)
    return this.cascadeId
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

    await this.rpcCall('SendUserCascadeMessage', payload)
    log(`[WindsurfClient] Message sent to cascade ${cascadeId}`)
  }

  /**
   * Return cached model configs read from Windsurf's state.vscdb during connect.
   * The GetCascadeModelConfigs RPC is unimplemented by the language server,
   * so we decode the protobuf stored in allowedCommandModelConfigsProtoBinaryBase64.
   */
  getModelConfigs(): Array<{ label: string; modelUid: string; disabled: boolean; isPremium: boolean }> {
    if (!this.info) throw new Error('Not connected')
    return this.info.modelConfigs
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
  ): Promise<{ entries: CascadeResponse[]; done: boolean; nextOffset: number; hasToolSteps: boolean }> {
    const payload = Buffer.concat([
      encodeString(1, cascadeId),
      encodeVarintField(2, stepOffset),
    ])

    const response = await this.rpcCall('GetCascadeTrajectorySteps', payload)
    const result = parseTrajectoryStepsResponse(response)

    const nextOffset = stepOffset + result.totalSteps

    return { entries: result.entries, done: result.completed, nextOffset, hasToolSteps: result.hasToolSteps }
  }

  /**
   * Archive/cleanup a Cascade trajectory (step 5).
   */
  async archiveCascade(_cascadeId: string): Promise<void> {
    // No archive method exists in the language server API.
    // Cascade sessions are ephemeral and cleaned up by the server.
    this.cascadeId = null
  }

  /**
   * Reset the session so the next message starts a fresh cascade.
   */
  resetSession(): void {
    this.cascadeId = null
    this.lastStepOffset = 0
    log('[WindsurfClient] Session reset')
  }

  /**
   * Full flow: send a message and wait for the complete response.
   * Polls the trajectory steps until Cascade signals completion.
   *
   * Calls are queued internally so two concurrent messages never race on the
   * shared cascadeId / lastStepOffset state.
   */
  sendAndAwait(
    message: string,
    options?: {
      modelUid?: string
      attachToActive?: boolean
      pollIntervalMs?: number
      maxWaitMs?: number
      idleTimeoutMs?: number
      onEntry?: (entry: CascadeResponse) => void
      /** Return true while there is work (e.g. a browser tool) in flight that
       *  the language server is waiting for. Prevents premature idle timeout. */
      hasPendingWork?: () => boolean
    },
  ): Promise<{ entries: CascadeResponse[]; completed: boolean }> {
    const promise = this.sendQueue.then(() => this._doSendAndAwait(message, options))
    // Absorb errors so a failed message doesn't block the queue forever
    this.sendQueue = promise.catch(() => {})
    return promise
  }

  private async _doSendAndAwait(
    message: string,
    options?: {
      modelUid?: string
      attachToActive?: boolean
      pollIntervalMs?: number
      maxWaitMs?: number
      idleTimeoutMs?: number
      onEntry?: (entry: CascadeResponse) => void
      hasPendingWork?: () => boolean
    },
  ): Promise<{ entries: CascadeResponse[]; completed: boolean }> {
    const pollInterval = options?.pollIntervalMs ?? 2000
    const maxWait = options?.maxWaitMs ?? 300_000
    const idleTimeout = options?.idleTimeoutMs ?? 45_000
    const modelUid = options?.modelUid ?? 'kimi-k2-6'
    const attachToActive = options?.attachToActive ?? true

    // Reuse existing cascade session if attachToActive is true and we have one.
    // This keeps conversation context across CMS chat messages.
    let cascadeId = attachToActive ? this.cascadeId : null
    if (!cascadeId) {
      cascadeId = await this.startCascade(true)
      this.lastStepOffset = 0
      this.hasInjectedFullPrompt = false
    }
    await this.sendMessage(cascadeId, message, modelUid)

    const allEntries: CascadeResponse[] = []
    const startTime = Date.now()
    let lastActivityTime = startTime
    let lastToolStepTime = 0   // when we last saw a tool call step; disables fast-completion
    let lastPlannerResponseTime = 0  // when we last saw a PLANNER_RESPONSE (thinking or text)
    let stepOffset = this.lastStepOffset
    let consecutiveErrors = 0
    let consecutiveEmptyPolls = 0
    let hasSeenText = false
    let hasSeenSteps = false
    let completed = false
    let completedByHeuristic = false

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval))
      let entries: CascadeResponse[]
      let done: boolean
      let nextOffset: number
      try {
        const result = await this.pollTranscript(cascadeId, stepOffset)
        entries = result.entries
        done = result.done
        nextOffset = result.nextOffset
        // Set planner response time BEFORE tool step time.  When both appear
        // in the same poll, the PLANNER_RESPONSE came before the new tool call
        // (not after the tool result), so aiRespondedAfterTool must be false
        // and the post-tool guard must stay active for the new tool.
        if (entries.length > 0) lastPlannerResponseTime = Date.now()
        if (result.hasToolSteps) lastToolStepTime = Date.now()
        consecutiveErrors = 0
      } catch (err) {
        consecutiveErrors++
        const errMsg = err instanceof Error ? err.message : String(err)
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || errMsg.includes('abort') || errMsg.includes('timeout'))
        if (isTimeout) {
          log(`[WindsurfClient] Poll timeout (attempt ${consecutiveErrors}) after ${pollInterval}ms — language server may be waiting for a tool result`)
        } else {
          log(`[WindsurfClient] Poll error (attempt ${consecutiveErrors}): ${errMsg}`)
        }
        if (consecutiveErrors >= 5) {
          log('[WindsurfClient] Too many consecutive poll errors, giving up')
          break
        }
        continue
      }

      const stepsInThisPoll = nextOffset - stepOffset
      if (stepsInThisPoll > 0) {
        hasSeenSteps = true
        consecutiveEmptyPolls = 0
        // Tool-only steps (type 38) produce no text entries but still
        // represent activity — the AI is executing tools and will re-think.
        // Without this, the idle timeout fires from the last TEXT entry,
        // killing the session while the AI is between tool calls.
        lastActivityTime = Date.now()
      } else {
        consecutiveEmptyPolls++
      }

      for (const entry of entries) {
        allEntries.push(entry)
        options?.onEntry?.(entry)
        if (entry.text) hasSeenText = true
      }
      stepOffset = nextOffset
      if (done) {
        completed = true
        break
      }

      const hasPending = options?.hasPendingWork?.() ?? false

      // Completion heuristics — safety-net ONLY. The primary signal is the
      // native done step (type 7/5). These fire only when the AI is genuinely
      // silent for an extended period.
      //
      // CRITICAL: after a tool step the AI re-thinks before its next action.
      // That re-thinking window can be 30-60s+ for large tool results (e.g.
      // 4KB CSS). We disable fast-completion entirely for 60s after any tool
      // step so the turn is never killed while the AI is deciding what to do.
      const msSinceToolStep = Date.now() - lastToolStepTime
      // The post-tool guard protects the re-thinking window — the time between
      // a tool result arriving and the AI producing its next PLANNER_RESPONSE.
      // Once the AI HAS responded after the tool, the re-thinking is done and
      // the guard is no longer needed.  Without this, the guard keeps the
      // idle timeout at 60s for a full minute after the tool step, even when
      // the AI already finished thinking and went silent.
      const aiRespondedAfterTool = lastPlannerResponseTime > lastToolStepTime
      const recentlyUsedTools = lastToolStepTime > 0 && msSinceToolStep < 60_000 && !aiRespondedAfterTool
      if (recentlyUsedTools && consecutiveEmptyPolls > 0) {
        // Reset the counter so the heuristic threshold is evaluated fresh
        // after the guard expires, not with accumulated polls from inside it.
        consecutiveEmptyPolls = 0
      }

      if (recentlyUsedTools) {
        // Emit a heartbeat log every ~10s so operators can see the guard is active
        if (consecutiveEmptyPolls > 0 && consecutiveEmptyPolls % 5 === 0) {
          log(`[WindsurfClient] Post-tool guard active — ${Math.round(msSinceToolStep / 1000)}s since last tool, waiting for AI to re-think...`)
        }
      }

      if (!hasPending && !recentlyUsedTools && hasSeenText && consecutiveEmptyPolls >= 5) {
        log(`[WindsurfClient] No new steps for ${consecutiveEmptyPolls * pollInterval}ms after text response — treating as complete`)
        completed = true
        completedByHeuristic = true
        break
      }

      if (!hasPending && !recentlyUsedTools && hasSeenSteps && consecutiveEmptyPolls >= 8) {
        log(`[WindsurfClient] No new steps for ${consecutiveEmptyPolls * pollInterval}ms after activity — treating as complete`)
        completed = true
        completedByHeuristic = true
        break
      }

      // Idle timeout: dynamic based on whether we've seen output.
      // After text → 15s (gives tool execution + re-thinking time).
      // After thinking-only (no response text) → 20s (AI likely finished).
      // Before any output → 45s (gives AI time to start generating).
      // When a tool is pending or post-tool guard is active → 60s.
      let effectiveTimeout = idleTimeout
      if (hasPending || recentlyUsedTools) {
        effectiveTimeout = Math.max(idleTimeout, 60_000)
      } else if (hasSeenText) {
        effectiveTimeout = 15_000
      } else if (hasSeenSteps) {
        effectiveTimeout = 20_000
      }
      if (Date.now() - lastActivityTime > effectiveTimeout) {
        log(`[WindsurfClient] Idle timeout (${effectiveTimeout}ms) — no new entries since last activity, treating as complete`)
        completed = true
        completedByHeuristic = true
        break
      }
    }

    if (!completed) {
      log(`[WindsurfClient] Polling ended after ${Math.round((Date.now() - startTime) / 1000)}s without completion (timeout or too many errors)`)
    }

    if (completedByHeuristic) {
      log(`[WindsurfClient] Turn ended by heuristic safety-net. Resetting cascade session to avoid stale-state on next message.`)
      this.cascadeId = null
      this.lastStepOffset = 0
    } else {
      // Save offset for next message in same session
      this.lastStepOffset = stepOffset
    }
    return { entries: allEntries, completed }
  }

  isConnected(): boolean {
    return this.info !== null
  }

  getCurrentCascadeId(): string | null {
    return this.cascadeId
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
 * We only extract text from PLANNER_RESPONSE steps (type 15).
 * We skip USER_INPUT (14), ERROR_MESSAGE (17), MEMORY (29),
 * RETRIEVE_MEMORY (34), and all other non-response steps.
 */
interface TrajectoryParseResult {
  entries: CascadeResponse[]
  totalSteps: number
  completed: boolean
  hasToolSteps: boolean
}

function parseTrajectoryStepsResponse(data: Buffer): TrajectoryParseResult {
  const entries: CascadeResponse[] = []
  let offset = 0
  let stepCount = 0
  let completed = false
  let hasToolSteps = false

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

      const stepType = getStepType(stepData)
      if (stepType === 15) {
        // PLANNER_RESPONSE — contains both thinking (field 3) and response (field 1)
        const { thinking, response } = extractPlannerResponseText(stepData)
        if (thinking || response) {
          log(`[WindsurfClient] Step ${stepCount}: PLANNER_RESPONSE thinking=${thinking?.slice(0, 60) ?? 'none'} response=${response?.slice(0, 60) ?? 'none'}...`)
          if (thinking) {
            entries.push({ thinking, done: false })
          }
          if (response) {
            entries.push({ text: response, done: false })
          }
        } else {
          log(`[WindsurfClient] Step ${stepCount}: PLANNER_RESPONSE but no text extracted`)
        }
      } else if (stepType === 17) {
        // ERROR_MESSAGE — extract error text for logging
        const err = extractErrorText(stepData)
        if (err) {
          log('[WindsurfClient] Cascade error step:', err.slice(0, 200))
        }
      } else if (stepType === 7 || stepType === 5) {
        // Type 7/5 = completion/done step
        completed = true
        log(`[WindsurfClient] Step ${stepCount}: type=${stepType} (DONE)`)
      } else if (stepType === 38 || stepType === 8 || stepType === 9) {
        // Likely tool-related steps — dump fields for debugging
        const fields = dumpProtobufFields(stepData)
        log(`[WindsurfClient] Step ${stepCount}: type=${stepType} (tool?) fields: ${fields.slice(0, 300)}`)
        // Try to extract nested message contents for fields that look like they
        // carry the tool name / args (commonly field 5 or 47 in observed dumps).
        try {
          const nestedInfo = extractNestedToolInfo(stepData)
          if (nestedInfo) {
            hasToolSteps = true
            log(`[WindsurfClient] Step ${stepCount}: parsed tool info: ${JSON.stringify(nestedInfo)}`)
          }
        } catch (e) {
          // ignore parse errors
        }
      } else if (stepType === 23) {
        // Type 23 often appears after PLANNER_RESPONSE on simple text replies.
        // It may carry the final response text or a completion signal.
        const fields = dumpProtobufFields(stepData)
        log(`[WindsurfClient] Step ${stepCount}: type=23 fields: ${fields.slice(0, 300)}`)
        const text = parseStringField(stepData, 1) || parseStringField(stepData, 3)
        if (text) {
          log(`[WindsurfClient] Step ${stepCount}: type=23 text=${text.slice(0, 80)}...`)
          entries.push({ text, done: false })
        }
      } else {
        log(`[WindsurfClient] Step ${stepCount}: type=${stepType} (skipped)`)
      }
    } else {
      offset = skipField(data, offset, wireType)
      if (offset < 0) break
    }
  }

  if (entries.length > 0) {
    entries[entries.length - 1].done = completed
  }

  log(`[WindsurfClient] Parsed ${entries.length} text entries from ${stepCount} steps, completed=${completed}`)
  return { entries, totalSteps: stepCount, completed, hasToolSteps }
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
 * Extract nested message info from a tool-related (type 38) trajectory step.
 * Looks for common field patterns that carry the MCP tool name and arguments.
 * This is best-effort reverse-engineering from observed dumps.
 */
function extractNestedToolInfo(stepData: Buffer): { server?: string; toolName?: string; args?: string } | null {
  let offset = 0
  let server: string | undefined
  let toolName: string | undefined
  let args: string | undefined

  while (offset < stepData.length) {
    const { value: tag, bytesRead } = decodeVarint(stepData, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    const fieldNum = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 2) {
      const { value: len, bytesRead: lenBytes } = decodeVarint(stepData, offset)
      offset += lenBytes
      const payload = stepData.subarray(offset, offset + len)
      offset += len

      // Field 5 often carries a nested message with tool details
      if (fieldNum === 5) {
        // Try to parse inner protobuf for tool name / args
        let innerOff = 0
        while (innerOff < payload.length) {
          const { value: itag, bytesRead: ibr } = decodeVarint(payload, innerOff)
          if (ibr === 0) break
          innerOff += ibr
          const ifn = itag >>> 3
          const iwt = itag & 0x7
          if (iwt === 2) {
            const { value: ilen, bytesRead: ilbr } = decodeVarint(payload, innerOff)
            innerOff += ilbr
            const iv = payload.subarray(innerOff, innerOff + ilen)
            innerOff += ilen
            if (ifn === 1 && !server) {
              server = iv.toString('utf8')
            } else if (ifn === 2 && !toolName) {
              toolName = iv.toString('utf8')
            } else if ((ifn === 3 || ifn === 4) && !args) {
              args = iv.toString('utf8')
            }
          } else {
            innerOff = skipField(payload, innerOff, iwt)
            if (innerOff < 0) break
          }
        }
      }

      // Field 47 often carries a nested message with server/tool info
      if (fieldNum === 47) {
        let innerOff = 0
        while (innerOff < payload.length) {
          const { value: itag, bytesRead: ibr } = decodeVarint(payload, innerOff)
          if (ibr === 0) break
          innerOff += ibr
          const ifn = itag >>> 3
          const iwt = itag & 0x7
          if (iwt === 2) {
            const { value: ilen, bytesRead: ilbr } = decodeVarint(payload, innerOff)
            innerOff += ilbr
            const iv = payload.subarray(innerOff, innerOff + ilen)
            innerOff += ilen
            if (ifn === 1 && !server) {
              server = iv.toString('utf8')
            } else if (ifn === 2 && !toolName) {
              toolName = iv.toString('utf8')
            } else if ((ifn === 3 || ifn === 4) && !args) {
              args = iv.toString('utf8')
            }
          } else {
            innerOff = skipField(payload, innerOff, iwt)
            if (innerOff < 0) break
          }
        }
      }
    } else {
      offset = skipField(stepData, offset, wireType)
      if (offset < 0) break
    }
  }

  if (!server && !toolName && !args) return null
  return { server, toolName, args }
}

/**
 * Extract thinking and response text from a PLANNER_RESPONSE step.
 *
 * The oneof field for planner_response is field 20 in CortexTrajectoryStep.
 * Inside CortexStepPlannerResponse:
 *   field 1: response (the actual assistant text)
 *   field 3: thinking (internal reasoning)
 *   field 6: message_id (bot-UUID noise — skip!)
 *   field 8: modified_response (alternative text)
 */
function extractPlannerResponseText(data: Buffer): { thinking: string | null; response: string | null } {
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
      if (!thinking && !response && !modified) {
        log(`[WindsurfClient] PlannerResponse fields: ${dumpProtobufFields(plannerData)}`)
      }
      return { thinking, response: response || modified || null }
    }
    offset = skipField(data, offset, wireType)
    if (offset < 0) break
  }
  log(`[WindsurfClient] Step fields: ${dumpProtobufFields(data)}`)
  return { thinking: null, response: null }
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
 * Parse GetCascadeModelConfigsResponse.
 *
 * Response field 1 contains repeated ClientModelConfig messages.
 * For each config we extract: label(1), model_uid(22), disabled(4), is_premium(7).
 */
function parseModelConfigsResponse(data: Buffer): Array<{ label: string; modelUid: string; disabled: boolean; isPremium: boolean }> {
  const configs: Array<{ label: string; modelUid: string; disabled: boolean; isPremium: boolean }> = []
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

      if (label && modelUid) {
        configs.push({ label, modelUid, disabled, isPremium })
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
