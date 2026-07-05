/**
 * Site catalog endpoint.
 *
 *   GET /admin/api/cms/site-catalog
 *
 * Returns a compact, agent-friendly catalog of the site: design tokens,
 * registered modules, breakpoints, and the current page slugs. This is the
 * IDE agent's "read the design system" step before exporting/importing pages.
 */

import '@modules/base'
import type { DbClient } from '../../db/client'
import { requireAnyCapabilityOrApiKey } from '../../auth/authz'
import { loadFullDraftSiteDocument } from '../../repositories/siteDocument'
import { jsonResponse, methodNotAllowed } from '../../http'
import { CMS_API_PREFIX } from './shared'
import { describeAgentModules, describeAgentTokens } from '../../ai/tools/site/render'
import type { CoreCapability } from '@core/capabilities'

// IDE API keys typically have pages.import/pages.export, not site.read.
const CATALOG_CAPABILITIES: readonly CoreCapability[] = ['site.read', 'pages.export', 'pages.import', 'site.structure.edit']

export async function handleSiteCatalogRoute(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/site-catalog`) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireAnyCapabilityOrApiKey(req, db, CATALOG_CAPABILITIES)
  if (user instanceof Response) return user

  const site = await loadFullDraftSiteDocument(db)
  if (!site) return jsonResponse({ error: 'Site not found' }, { status: 404 })

  return jsonResponse({
    ok: true,
    tokens: describeAgentTokens(site),
    modules: describeAgentModules(),
    breakpoints: site.breakpoints,
    pages: site.pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title })),
    exportedAt: new Date().toISOString(),
  })
}
