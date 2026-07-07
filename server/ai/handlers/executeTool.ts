/**
 * POST /admin/api/ai/execute-tool
 *
 * Execute a single AI tool by name. Used by the MCP relay daemon to run
 * browser-bridged tools (node-level edits, CSS authoring, design tokens,
 * code assets, render snapshots, …) through the existing editor bridge.
 *
 * Auth: session cookie only (requireCapability). The relay daemon's CmsClient
 * logs in with email/password and reuses the session cookie.
 *
 * Browser-bridged tools require the Instatic site editor to be open in a
 * browser (signed in as the same user). If no editor bridge is connected,
 * the endpoint returns 503 with an actionable error message.
 */
import { Type } from '@core/utils/typeboxHelpers'
import fs from 'node:fs'
import path from 'node:path'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { executeAiTool } from '../drivers/http/execTool'
import { getEditorBridgeForUser } from '../mcp/editorBridge'
import { siteTools } from '../tools/site'
import { contentTools } from '../tools/content'
import { styleMcpTools } from '../mcp/tools/styleTools'
import { contextMcpTools } from '../mcp/tools/contextTool'
import type { AiTool, AiBrowserBridge } from '../runtime/types'
import type { CoreCapability } from '@core/capabilities'

const PATH = '/admin/api/ai/execute-tool'

const ExecuteToolBodySchema = Type.Object({
  toolName: Type.String({ minLength: 1 }),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

// Build a name → tool lookup from the full toolset (same union the MCP server
// exposes). De-dup by name, first occurrence wins — same ordering semantics
// as `allMcpTools()` in the MCP registry.
const ALL_TOOLS_BY_NAME: Map<string, AiTool> = (() => {
  const ordered = [...contextMcpTools, ...styleMcpTools, ...contentTools, ...siteTools]
  const byName = new Map<string, AiTool>()
  for (const tool of ordered) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return byName
})()

const NO_EDITOR_MESSAGE =
  'This tool runs in the Instatic editor. Open the site editor in a browser (signed in as the connector owner) and try again.'

// Where render snapshots are saved so the IDE can read them as actual image
// files instead of receiving huge base64 strings through the chat text channel.
const SNAPSHOT_DIR = path.resolve(process.cwd(), 'scripts', 'mcp', '.snapshots')

const NOOP_BRIDGE: AiBrowserBridge = {
  callBrowser: async () => {
    throw new Error('[ai:execute-tool] this tool has no server handler and no live editor bridge')
  },
}

export function tryHandleAiExecuteTool(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== PATH) return null
  return handle(req, db)
}

async function handle(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  const userOrResponse = await requireCapability(req, db, 'ai.tools.write')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, ExecuteToolBodySchema)
  if (!body) return badRequest('Invalid request body. Expected { toolName, input? }.')

  const tool = ALL_TOOLS_BY_NAME.get(body.toolName)
  if (!tool) {
    return jsonResponse({ ok: false, error: `Unknown tool: ${body.toolName}` }, { status: 404 })
  }

  // Server-resolved tools can run headless; browser tools need the editor bridge.
  let bridge: AiBrowserBridge = NOOP_BRIDGE
  if (tool.execution === 'browser') {
    const live = getEditorBridgeForUser(userOrResponse.id)
    if (!live) {
      return jsonResponse({ ok: false, error: NO_EDITOR_MESSAGE }, { status: 503 })
    }
    bridge = live
  }

  const controller = new AbortController()
  const capabilities = userOrResponse.capabilities as readonly CoreCapability[]
  const output = await executeAiTool(tool, body.input ?? {}, bridge, controller.signal, {
    db,
    userId: userOrResponse.id,
    capabilities,
    scope: tool.scope === 'shared' ? 'content' : tool.scope,
    conversationId: 'relay:execute-tool',
    snapshot: null,
  })

  if (!output.ok) {
    return jsonResponse({ ok: false, error: output.error ?? 'Tool failed.' }, { status: 200 })
  }

  // Forward image attachments (e.g. render_snapshot PNG). For the IDE workflow
  // we write the image to a workspace file and return its absolute path so
  // Cascade can read the file with the image viewer instead of receiving a
  // truncated base64 string in the chat text channel.
  const data = output.data ?? { ok: true }
  const images = output.images ?? []
  const payload: Record<string, unknown> = { ok: true, data }
  if (images.length > 0) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
    payload.images = images.map((img, index) => {
      const ext = img.mimeType?.split('/')[1] ?? 'png'
      const fileName = `render-snapshot-${Date.now()}-${index}.${ext}`
      const filePath = path.join(SNAPSHOT_DIR, fileName)
      const absolutePath = path.resolve(filePath)
      const base64 = typeof img.data === 'string' ? img.data : Buffer.from(img.data).toString('base64')
      fs.writeFileSync(absolutePath, Buffer.from(base64, 'base64'))
      return {
        mimeType: img.mimeType,
        path: absolutePath,
        // Keep a small base64 preview so non-IDE callers still get something.
        data: base64.slice(0, 200) + (base64.length > 200 ? '…' : ''),
      }
    })
  }
  return jsonResponse(payload)
}
