/**
 * HTML export endpoint.
 *
 *   GET /admin/api/cms/pages/:slug/export-html
 *
 * Returns the current draft of a page as clean, id-less HTML so an external
 * AI tool can read the latest CMS state. Authentication accepts either a
 * session cookie (browser) or an API key (IDE tools).
 */
import '@modules/base'
import type { DbClient } from '../../db/client'
import { requireAuthenticatedUserOrApiKey } from '../../auth/apiKey'
import { registry } from '@core/module-engine'
import { serializeNodeHtml } from '@core/publisher'
import { loadFullDraftSiteDocument } from '../../repositories/siteDocument'
import { jsonResponse, methodNotAllowed } from '../../http'
import { CMS_API_PREFIX } from './shared'
import type { CoreCapability } from '@core/capabilities'

const EXPORT_CAPABILITIES: readonly CoreCapability[] = ['pages.export', 'site.read']

export async function handleExportHtmlRoute(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  const match = url.pathname.match(new RegExp(`^${CMS_API_PREFIX}/pages/([^/]+)/export-html$`))
  if (!match) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireAuthenticatedUserOrApiKey(req, db)
  if (user instanceof Response) return user

  if (!EXPORT_CAPABILITIES.some((cap) => user.capabilities.includes(cap))) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const slug = decodeURIComponent(match[1])
  const site = await loadFullDraftSiteDocument(db)
  if (!site) return jsonResponse({ error: 'Site not found' }, { status: 404 })

  const page = site.pages.find((p) => p.slug === slug)
  if (!page) return jsonResponse({ error: `Page "${slug}" not found` }, { status: 404 })

  const html = serializeNodeHtml(page.rootNodeId, page, site, registry)

  return jsonResponse({
    ok: true,
    pageId: page.id,
    slug: page.slug,
    title: page.title,
    html,
    exportedAt: new Date().toISOString(),
  })
}
