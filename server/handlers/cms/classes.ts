/**
 * GET /admin/api/cms/classes       — list all class-kind style rules
 * GET /admin/api/cms/classes/:ref  — get one class by name or id
 *
 * These endpoints are read-only and used by the IDE MCP tools to discover
 * the site's CSS class vocabulary before designing new sections.
 */

import type { DbClient } from '../../db/client'
import { jsonResponse, methodNotAllowed } from '../../http'
import { loadFullDraftSiteDocument } from '../../repositories/siteDocument'
import { CMS_API_PREFIX } from './shared'

export async function handleClassesRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith(`${CMS_API_PREFIX}/classes`)) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const site = await loadFullDraftSiteDocument(db)
  if (!site) {
    return jsonResponse({ error: 'Site not found' }, { status: 404 })
  }

  // Single-class lookup: /admin/api/cms/classes/:ref
  const singleMatch = url.pathname.match(
    new RegExp(`^${CMS_API_PREFIX.replace('/', '\\/')}\\/classes\\/(.+)$`),
  )
  if (singleMatch) {
    const ref = decodeURIComponent(singleMatch[1])
    // Try id first, then name
    let rule = site.styleRules[ref]
    if (!rule) {
      rule = Object.values(site.styleRules).find((r) => r.name === ref)
    }
    if (!rule || rule.kind !== 'class') {
      return jsonResponse({ error: 'Class not found' }, { status: 404 })
    }
    return jsonResponse({ class: rule })
  }

  // List all class-kind rules
  if (url.pathname === `${CMS_API_PREFIX}/classes`) {
    const classes = Object.values(site.styleRules)
      .filter((r) => r.kind === 'class')
      .sort((a, b) => a.order - b.order)
    return jsonResponse({ classes })
  }

  return null
}
