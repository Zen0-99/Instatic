/**
 * Pages read endpoint backed by `data_rows` (table_id = 'pages').
 *
 *   GET /admin/api/cms/pages — list all non-deleted page rows as DataRow[]
 *                              (gated by `site.read`). The client adapter
 *                              converts these to Page[] via pageFromRow.
 *
 * The response intentionally returns raw DataRow objects (not Page objects)
 * so the client adapter can reconstruct Pages via pageFromRow without a
 * round-trip through a second validation layer on the server. The adapter
 * validates pages via validatePages immediately after conversion.
 *
 * Writes go through the transactional site-document save
 * (PUT /admin/api/cms/site-document — see ./siteDocument.ts), which persists
 * shell + pages + components + layouts atomically.
 */
import type { DbClient } from '../../db/client'
import { requireAnyCapabilityOrApiKey } from '../../auth/authz'
import type { CoreCapability } from '../../auth/capabilities'
import { listDataRows, applyDataRowChangesInTx } from '../../repositories/data'
import { saveDraftSite, stampDraftSiteSeq } from '../../repositories/site'
import { allocateSiteSeq } from '../../repositories/syncSequence'
import { loadFullDraftSiteDocument } from '../../repositories/siteDocument'
import { pageFromRow, pageToCells } from '../../../src/core/data/pageFromRow'
import { addPage, deletePage, renamePage, duplicatePage } from '@core/page-tree'
import { validateSite, validatePages } from '@core/persistence/validate'
import { jsonResponse, methodNotAllowed, badRequest } from '../../http'
import { CMS_API_PREFIX } from './shared'
import { bumpPublishVersionSerialized } from '../../publish/publishState'

// API keys used by the IDE agent typically have pages.import/pages.export, not site.read.
const PAGE_READ_CAPABILITIES: readonly CoreCapability[] = ['site.read', 'pages.export', 'pages.import', 'site.structure.edit']

const PAGE_MUTATE_CAPABILITIES: readonly CoreCapability[] = ['site.structure.edit']

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/pages`) {
    if (req.method !== 'GET') return methodNotAllowed()

    const user = await requireAnyCapabilityOrApiKey(req, db, PAGE_READ_CAPABILITIES)
    if (user instanceof Response) return user

    const rows = await listDataRows(db, 'pages')
    return jsonResponse({ rows })
  }

  if (url.pathname === `${CMS_API_PREFIX}/pages/mutate`) {
    if (req.method !== 'POST') return methodNotAllowed()

    const user = await requireAnyCapabilityOrApiKey(req, db, PAGE_MUTATE_CAPABILITIES)
    if (user instanceof Response) return user

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    if (!body || typeof body !== 'object') return badRequest('Invalid request body')
    const { action, pageId, title, slug } = body as Record<string, unknown>

    const site = await loadFullDraftSiteDocument(db)
    if (!site) return badRequest('No draft site found')

    let changedPage: typeof site.pages[number] | null = null
    let deletedPageId: string | null = null

    try {
      if (action === 'add') {
        if (typeof title !== 'string' || title.length === 0) return badRequest('title is required')
        const slugValue = typeof slug === 'string' ? slug : title
        changedPage = addPage(site, title, slugValue)
      } else if (action === 'delete') {
        if (typeof pageId !== 'string' || pageId.length === 0) return badRequest('pageId is required')
        if (site.pages.length <= 1) return badRequest('Cannot delete the last page')
        deletePage(site, pageId)
        deletedPageId = pageId
      } else if (action === 'rename') {
        if (typeof pageId !== 'string' || pageId.length === 0) return badRequest('pageId is required')
        if (typeof title !== 'string' || title.length === 0) return badRequest('title is required')
        const slugValue = typeof slug === 'string' ? slug : undefined
        renamePage(site, pageId, title, slugValue)
        changedPage = site.pages.find((p) => p.id === pageId) ?? null
      } else if (action === 'duplicate') {
        if (typeof pageId !== 'string' || pageId.length === 0) return badRequest('pageId is required')
        if (typeof title !== 'string' || title.length === 0) return badRequest('title is required')
        const slugValue = typeof slug === 'string' ? slug : undefined
        changedPage = duplicatePage(site, pageId, title, slugValue)
      } else {
        return badRequest(`Unknown action: ${String(action)}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return badRequest(message)
    }

    // Validate the mutated site shell and pages.
    validateSite(site)
    const pagesForValidation = site.pages.map((p) => pageFromRow({ id: p.id, slug: p.slug, cells: pageToCells(p) } as any))
    const validatedPages = validatePages(site, pagesForValidation, site.visualComponents, { tolerant: true })
    if (validatedPages.length !== site.pages.length) {
      return badRequest('Page validation failed after mutation')
    }

    // Persist the shell and page changes.
    const seq = await allocateSiteSeq(db)
    let deletedPublished = false
    await db.transaction(async (tx) => {
      await saveDraftSite(tx, site, user.id)
      await stampDraftSiteSeq(tx, seq)

      const writes = changedPage
        ? [{
            id: changedPage.id,
            cells: pageToCells(changedPage),
            slug: changedPage.slug,
          }]
        : []
      const deleteIds = deletedPageId ? new Set([deletedPageId]) : new Set<string>()

      const result = await applyDataRowChangesInTx(tx, {
        tableId: 'pages',
        writes,
        deleteIds,
        actorUserId: user.id,
        seq,
      })
      deletedPublished = result.deletedPublished
    })

    if (deletedPublished) await bumpPublishVersionSerialized()

    return jsonResponse({
      ok: true,
      page: changedPage ? { id: changedPage.id, title: changedPage.title, slug: changedPage.slug } : null,
      deletedPageId,
    })
  }

  return null
}
