/**
 * Saved-layout read endpoint backed by `data_rows` (table_id = 'layouts').
 *
 *   GET /admin/api/cms/layouts — list all non-deleted layout rows as
 *                                DataRow[] (gated by `site.read`). The client
 *                                adapter converts these to SavedLayout[]
 *                                via savedLayoutFromRow + validateSavedLayouts.
 *
 * The response returns raw DataRow objects (not SavedLayout objects) so the
 * client adapter can reconstruct layouts via savedLayoutFromRow without a
 * second validation layer on the server.
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
const IDE_CATALOG_CAPABILITIES: readonly CoreCapability[] = ['site.read', 'pages.export', 'pages.import', 'site.structure.edit']

export async function handleLayoutsRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/layouts`) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireAnyCapabilityOrApiKey(req, db, IDE_CATALOG_CAPABILITIES)
  if (user instanceof Response) return user

  const rows = await listDataRows(db, 'layouts')
  return jsonResponse({ rows })
}
