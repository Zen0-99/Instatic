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
import { listDataRows } from '../../repositories/data'
import { jsonResponse, methodNotAllowed } from '../../http'
import { CMS_API_PREFIX } from './shared'

// API keys used by the IDE agent typically have pages.import/pages.export, not site.read.
const PAGE_READ_CAPABILITIES: readonly CoreCapability[] = ['site.read', 'pages.export', 'pages.import', 'site.structure.edit']

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/pages`) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireAnyCapabilityOrApiKey(req, db, PAGE_READ_CAPABILITIES)
  if (user instanceof Response) return user

  const rows = await listDataRows(db, 'pages')
  return jsonResponse({ rows })
}
