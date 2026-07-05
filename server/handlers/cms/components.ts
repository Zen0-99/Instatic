/**
 * Visual Components read endpoint backed by `data_rows` (table_id = 'components').
 *
 *   GET /admin/api/cms/components — list all non-deleted component rows as
 *                                   DataRow[] (gated by `site.read`). The client
 *                                   adapter converts these to VisualComponent[]
 *                                   via visualComponentFromRow + validateVisualComponents.
 *
 * The response returns raw DataRow objects (not VisualComponent objects) so
 * the client adapter can reconstruct VCs via visualComponentFromRow without a
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

export async function handleComponentsRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/components`) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireAnyCapabilityOrApiKey(req, db, IDE_CATALOG_CAPABILITIES)
  if (user instanceof Response) return user

  const rows = await listDataRows(db, 'components')
  return jsonResponse({ rows })
}
