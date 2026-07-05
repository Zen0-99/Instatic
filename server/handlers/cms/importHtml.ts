/**
 * HTML page import endpoint.
 *
 *   POST /admin/api/cms/pages/import-html
 *
 * Accepts clean HTML and creates or updates a page. The HTML is parsed through
 * the same `importHtml` pipeline used by browser-side paste/import, so the
 * same security stripping and module claiming apply.
 */
import '@modules/base'
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { requireApiKeyAuthenticatedUser } from '../../auth/apiKey'
import { importHtml } from '@core/htmlImport'
import {
  createNode,
  reindexNodeParents,
  type Page,
  type PageNode,
  type SiteDocument,
} from '@core/page-tree'
import { pageToCells } from '@core/data/pageFromRow'
import { createDataRow, saveDataRowDraft } from '../../repositories/data'
import { loadFullDraftSiteDocument } from '../../repositories/siteDocument'
import { exportSiteFiles } from '../../persistence/exportSiteFiles'
import { jsonResponse, readValidatedBody } from '../../http'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import { Type } from '@core/utils/typeboxHelpers'
import { broadcastPageEvent } from './pageEventBroadcaster'
import { classKindSelector } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { cssToStyleRules } from '@core/siteImport/cssToStyleRules'
import { saveDraftSite } from '../../repositories/site'
import type { ImportResult } from '@core/htmlImport'

const ImportHtmlBodySchema = Type.Object(
  {
    slug: Type.String(),
    title: Type.Optional(Type.String()),
    html: Type.String(),
    mode: Type.Optional(Type.Union([Type.Literal('replace'), Type.Literal('merge')])),
  },
  { additionalProperties: false },
)

const IMPORT_CAPABILITY = 'pages.import' as const

async function ensureDomParser(): Promise<void> {
  if (typeof globalThis.DOMParser !== 'undefined') return
  // happy-dom is not statically imported to avoid browser-bundle bloat.
  const { GlobalWindow } = await import('happy-dom')
  const happyWindow = new GlobalWindow({
    url: 'http://localhost/',
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  })
  ;(globalThis as Record<string, unknown>).DOMParser = happyWindow.DOMParser
  ;(globalThis as Record<string, unknown>).window = happyWindow
  ;(globalThis as Record<string, unknown>).document = happyWindow.document
  ;(globalThis as Record<string, unknown>).HTMLElement = happyWindow.HTMLElement
  ;(globalThis as Record<string, unknown>).Element = happyWindow.Element
  ;(globalThis as Record<string, unknown>).Node = happyWindow.Node
  if (happyWindow.CSSStyleSheet) {
    ;(globalThis as Record<string, unknown>).CSSStyleSheet = happyWindow.CSSStyleSheet
  }
}

function buildNewPage(
  site: SiteDocument,
  input: {
    slug: string
    title?: string
    importedNodes: Record<string, PageNode>
    importedRootIds: string[]
    userId: string
  },
): Page {
  const bodyNode = createNode('base.body')
  bodyNode.children = [...input.importedRootIds]
  const nodes: Record<string, PageNode> = { [bodyNode.id]: bodyNode }
  for (const [id, node] of Object.entries(input.importedNodes)) {
    nodes[id] = node
  }
  reindexNodeParents(nodes)
  return {
    id: `pg_${nanoid()}`,
    slug: input.slug,
    title: input.title ?? site.name ?? input.slug,
    nodes,
    rootNodeId: bodyNode.id,
    ownerUserId: input.userId,
    createdByUserId: input.userId,
    updatedByUserId: input.userId,
  }
}

function updatePageWithImport(
  page: Page,
  input: {
    title?: string
    importedNodes: Record<string, PageNode>
    importedRootIds: string[]
    mode: 'replace' | 'merge'
  },
): Page {
  const updated: Page = { ...page }
  if (input.title) updated.title = input.title

  const bodyNode = updated.nodes[updated.rootNodeId]
  if (!bodyNode) {
    throw new Error(`Page "${page.slug}" has no body node`)
  }

  if (input.mode === 'replace') {
    // Drop the old body subtree so we don't leave orphaned nodes behind.
    const oldChildren = bodyNode.children ?? []
    const idsToDelete = new Set<string>()
    for (const childId of oldChildren) {
      idsToDelete.add(childId)
      collectDescendantIds(updated.nodes, childId, idsToDelete)
    }
    for (const id of idsToDelete) {
      delete updated.nodes[id]
    }
    bodyNode.children = [...input.importedRootIds]
  } else {
    bodyNode.children = [...(bodyNode.children ?? []), ...input.importedRootIds]
  }

  for (const [id, node] of Object.entries(input.importedNodes)) {
    updated.nodes[id] = node
  }

  reindexNodeParents(updated.nodes)
  return updated
}

function collectDescendantIds(
  nodes: Record<string, PageNode>,
  rootId: string,
  out: Set<string>,
): void {
  const node = nodes[rootId]
  if (!node) return
  for (const childId of node.children ?? []) {
    out.add(childId)
    collectDescendantIds(nodes, childId, out)
  }
}

/**
 * Collect every class name referenced by imported nodes, create bare
 * StyleRules for names that don't already exist in the site's registry,
 * and rewrite node.classIds to use real registry ids. Also parses any
 * <style> block CSS and merges the resulting rules into the registry.
 */
function reconcileImportedClassesAndStyles(
  site: SiteDocument,
  importResult: ImportResult,
): void {
  // 1. Index existing rules by name → id
  const byName = new Map<string, string>()
  for (const cls of Object.values(site.styleRules)) {
    if (!byName.has(cls.name)) byName.set(cls.name, cls.id)
  }

  let maxOrder = -1
  for (const c of Object.values(site.styleRules)) {
    if (typeof c.order === 'number' && c.order > maxOrder) maxOrder = c.order
  }

  // 2. Parse <style> CSS FIRST so classes with authored styles get
  //    real declarations, not empty bare shells.
  if (importResult.styleCss) {
    const parsed = cssToStyleRules(importResult.styleCss, {
      breakpoints: site.breakpoints.map((b) => ({
        id: b.id,
        name: b.label,
        width: b.width,
        query: b.mediaQuery ?? `(max-width: ${b.width}px)`,
      })),
    })

    const ambientSelectors = new Set<string>()
    for (const r of Object.values(site.styleRules)) {
      if (r.kind === 'ambient') ambientSelectors.add(r.selector)
    }

    const now = Date.now()
    for (const rule of parsed.rules) {
      if (rule.kind === 'class') {
        const existingId = byName.get(rule.name)
        if (existingId) {
          const existing = site.styleRules[existingId]
          // Only merge into an existing class if it is empty (bare shell from a
          // prior import or auto-creation). If the user has already authored
          // styles, their work wins.
          const hasStyles =
            Object.keys(existing.styles).length > 0 ||
            Object.keys(existing.contextStyles).length > 0
          if (hasStyles) {
            continue
          }
          // Populate the bare shell with imported CSS.
          existing.styles = rule.styles
          existing.contextStyles = rule.contextStyles
          existing.updatedAt = now
          continue
        }
      } else if (ambientSelectors.has(rule.selector)) {
        continue // identical ambient selector already present
      }

      const id = nanoid()
      const newRule: StyleRule = {
        ...rule,
        id,
        createdAt: now,
        updatedAt: now,
      }
      site.styleRules[id] = newRule
      if (rule.kind === 'class') byName.set(rule.name, id)
      if (typeof newRule.order === 'number' && newRule.order > maxOrder) {
        maxOrder = newRule.order
      }
    }
  }

  // 3. Helper: ensure a class name has a real registry id.
  //    Names already covered by parsed CSS (step 2) or pre-existing registry
  //    entries are returned as-is. Only novel names get a bare shell.
  function ensureClassId(name: string): string | null {
    if (!name || name.length === 0) return null
    let id = byName.get(name)
    if (!id) {
      const now = Date.now()
      const cls: StyleRule = {
        id: nanoid(),
        name,
        kind: 'class',
        selector: classKindSelector(name),
        order: ++maxOrder,
        styles: {},
        contextStyles: {},
        createdAt: now,
        updatedAt: now,
      }
      site.styleRules[cls.id] = cls
      byName.set(name, cls.id)
      id = cls.id
    }
    return id
  }

  // 4. Rewrite classIds on every imported node
  for (const node of Object.values(importResult.nodes)) {
    if (!node.classIds?.length) continue
    const ids: string[] = []
    for (const name of node.classIds) {
      const id = ensureClassId(name)
      if (id && !ids.includes(id)) ids.push(id)
    }
    node.classIds = ids
  }
}

export async function handleImportHtmlRoute(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/pages/import-html`) return null
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })

  const user = await requireApiKeyAuthenticatedUser(req, db)
  if (user instanceof Response) return user

  if (!user.capabilities.includes(IMPORT_CAPABILITY)) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await readValidatedBody(req, ImportHtmlBodySchema)
  if (!body) return jsonResponse({ error: 'Invalid request body' }, { status: 400 })

  const site = await loadFullDraftSiteDocument(db)
  if (!site) return jsonResponse({ error: 'Site not found' }, { status: 404 })

  const existingPage = site.pages.find((p) => p.slug === body.slug)
  const isNewPage = !existingPage

  if (isNewPage && !user.capabilities.includes('site.structure.edit')) {
    return jsonResponse(
      { error: 'Forbidden: creating pages requires site.structure.edit' },
      { status: 403 },
    )
  }

  await ensureDomParser()
  const importResult = importHtml(body.html)
  const mode = body.mode ?? 'replace'

  reconcileImportedClassesAndStyles(site, importResult)

  const page = isNewPage
    ? buildNewPage(site, {
        slug: body.slug,
        title: body.title,
        importedNodes: importResult.nodes,
        importedRootIds: importResult.rootIds,
        userId: user.id,
      })
    : updatePageWithImport(existingPage, {
        title: body.title,
        importedNodes: importResult.nodes,
        importedRootIds: importResult.rootIds,
        mode,
      })

  await saveDraftSite(db, site, user.id)

  const cells = pageToCells(page)
  if (isNewPage) {
    await createDataRow(
      db,
      {
        id: page.id,
        tableId: 'pages',
        cells,
        slug: page.slug,
      },
      user.id,
    )
  } else {
    await saveDataRowDraft(db, page.id, { cells, slug: page.slug }, user.id)
  }

  // Notify all connected editor tabs that this page changed.
  broadcastPageEvent({ kind: 'page.updated', pageId: page.id, slug: page.slug })

  // Local file-export: write the imported page so the IDE AI can read it.
  if (options.projectRoot) {
    try {
      const site = await loadFullDraftSiteDocument(db)
      if (site) {
        await exportSiteFiles(options.projectRoot, site, { pageIds: new Set([page.id]) })
      }
    } catch (err) {
      console.error('[import-html] Local file-export failed:', err)
    }
  }

  return jsonResponse({
    ok: true,
    pageId: page.id,
    slug: page.slug,
    created: isNewPage,
    nodesInserted: importResult.rootIds.length,
    nodesRemoved: mode === 'replace' && existingPage ? (existingPage.nodes[existingPage.rootNodeId]?.children ?? []).length : 0,
    stripped: importResult.stripped,
  })
}
