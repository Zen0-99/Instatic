/**
 * get_context — orientation for an MCP agent in one call.
 *
 * Surfaces the two things that silently tripped up live use:
 *   1. whether a live editor is connected (browser tools need it), and
 *   2. which "everywhere" / post-type templates wrap pages (so the agent isn't
 *      surprised by a nav/footer it didn't author).
 *
 * Headless: editor presence comes from the bridge registry; templates + author
 * come straight from the DB. No browser snapshot.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool, ToolContext } from '../../runtime/types'
import { getDraftSite } from '../../../repositories/site'
import { hasEditorBridge } from '../editorBridge'
import { loadFullDraftSiteDocument } from '../../../repositories/siteDocument'
import { serializeNodeHtml } from '@core/publisher'
import { registry } from '@core/module-engine'

const CONTEXT_READ_CAPS: readonly CoreCapability[] = [
  'site.read',
  'content.manage',
  'data.system.tables.read',
  'data.custom.tables.read',
  'pages.edit',
]

const GetContextInput = Type.Object(
  {
    entryId: Type.Optional(
      Type.String({ description: 'Optional page/post entry id — also reports whether a template wraps it.' }),
    ),
  },
  { additionalProperties: false },
)

const RenderSnapshotInput = Type.Object(
  {
    slug: Type.String({ description: 'Page slug to render.' }),
  },
  { additionalProperties: false },
)

interface PageCells {
  title?: string
  templateEnabled?: boolean
  templateTarget?: { kind?: string; tableSlugs?: string[] }
  templatePriority?: number
}

interface PageRow {
  id: string
  table_id: string
  cells_json: PageCells
}

export const contextMcpTools: AiTool[] = [
  {
    name: 'get_context',
    description:
      'Orient yourself before editing: reports whether a live Instatic editor is connected (browser tools like site_insert_html / site_render_snapshot require it), and which templates wrap pages — an "everywhere" template applies a nav/footer/etc. to every page, so anything you author is in addition to it. Pass entryId to also learn whether a template wraps that specific page. Headless — no editor needed. Call this first if a browser tool returns an "open the editor" error.',
    scope: 'site',
    execution: 'server',
    inputSchema: GetContextInput,
    requiredCapabilities: CONTEXT_READ_CAPS,
    handler: async (input, ctx: ToolContext) => {
      const { entryId } = input as { entryId?: string }
      const site = await getDraftSite(ctx.db)

      const { rows } = await ctx.db<PageRow>`
        select id, table_id, cells_json
        from data_rows
        where table_id = 'pages' and deleted_at is null
      `
      const templates = rows
        .filter((r) => r.cells_json?.templateEnabled)
        .map((r) => ({
          id: r.id,
          title: r.cells_json.title ?? r.id,
          target: r.cells_json.templateTarget?.kind ?? 'unknown',
          tableSlugs: r.cells_json.templateTarget?.tableSlugs,
          priority: r.cells_json.templatePriority ?? 100,
        }))
        .sort((a, b) => a.priority - b.priority)

      const result: Record<string, unknown> = {
        site: site ? { name: site.name } : null,
        editor: { connected: hasEditorBridge(ctx.userId) },
        templates,
      }

      if (entryId) {
        const entry = rows.find((r) => r.id === entryId)
        // `everywhere` templates wrap every page; that's the common surprise.
        const wrapping = templates.filter((t) => t.target === 'everywhere')
        result.page = {
          found: Boolean(entry),
          title: entry?.cells_json.title ?? null,
          wrappedByTemplates: wrapping.map((t) => t.title),
        }
      }

      return result
    },
  },
  {
    name: 'cms_render_snapshot',
    description:
      'Headless render snapshot for API-based agents. Returns the current draft HTML of a page plus a structured layout summary (sections, classes, text) WITHOUT requiring the Instatic editor to be open. This is the API-safe counterpart to site_render_snapshot, which only works when the IDE has a live browser editor. Use cms_render_snapshot when you cannot rely on a browser bridge.',
    scope: 'site',
    execution: 'server',
    inputSchema: RenderSnapshotInput,
    requiredCapabilities: CONTEXT_READ_CAPS,
    handler: async (input, ctx: ToolContext) => {
      const { slug } = input as { slug: string }
      const site = await loadFullDraftSiteDocument(ctx.db)
      if (!site) throw new Error('Site not found')

      const page = site.pages.find((p) => p.slug === slug)
      if (!page) throw new Error(`Page "${slug}" not found`)

      const html = serializeNodeHtml(page.rootNodeId, page, site, registry)

      // Build a lightweight, text-only layout summary so API models can reason
      // about the page structure without a live browser screenshot.
      const sections = []
      const nodeQueue = [page.nodes[page.rootNodeId]]
      while (nodeQueue.length > 0) {
        const node = nodeQueue.shift()
        if (!node) continue
        if (node.tag === 'section' || node.tag === 'div') {
          const text = (node.props?.textContent ?? '') as string
          const title = text?.slice(0, 80) ?? ''
          sections.push({
            id: node.id,
            tag: node.tag,
            moduleId: node.moduleId ?? null,
            classes: node.classIds ?? [],
            textPreview: title,
          })
        }
        if (node.children) {
          for (const childId of node.children) {
            const child = page.nodes[childId]
            if (child) nodeQueue.push(child)
          }
        }
      }

      return {
        pageId: page.id,
        slug: page.slug,
        title: page.title,
        html,
        sections,
      }
    },
  },
]
