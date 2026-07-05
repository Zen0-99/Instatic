/**
 * Full SiteDocument loader for server-side rendering and export.
 *
 * Assembles the current draft site shell plus all pages, visual components,
 * and saved layouts. This is the server-side mirror of the client-side
 * `CmsAdapter.loadSite`.
 */
import type { DbClient } from '../db/client'
import { getDraftSite } from './site'
import { listDataRows } from './data'
import { pageFromRow } from '@core/data/pageFromRow'
import { visualComponentFromRow } from '@core/data/componentFromRow'
import { savedLayoutFromRow } from '@core/data/layoutFromRow'
import { reconcileSiteExplorerOrganization, type SiteDocument } from '@core/page-tree'
import {
  validatePages,
  validateVisualComponents,
} from '@core/persistence/validate'
import { validateSavedLayouts } from '@core/persistence/validateLayouts'

export async function loadFullDraftSiteDocument(db: DbClient): Promise<SiteDocument | null> {
  const shell = await getDraftSite(db)
  if (!shell) return null

  const [pageRows, vcRows, layoutRows] = await Promise.all([
    listDataRows(db, 'pages'),
    listDataRows(db, 'components'),
    listDataRows(db, 'layouts'),
  ])

  const visualComponents = validateVisualComponents(
    vcRows.flatMap((r) => {
      const vc = visualComponentFromRow(r)
      return vc ? [vc] : []
    }),
  )

  const layouts = validateSavedLayouts(
    layoutRows.flatMap((r) => {
      const layout = savedLayoutFromRow(r)
      return layout ? [layout] : []
    }),
  )

  const rawPages = pageRows.map(pageFromRow)
  const pages = validatePages(shell, rawPages, visualComponents, { tolerant: true })

  const site: SiteDocument = { ...shell, pages, visualComponents, layouts }
  site.explorer = reconcileSiteExplorerOrganization(site.explorer, site)
  return site
}
