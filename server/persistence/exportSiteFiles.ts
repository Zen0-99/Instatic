/**
 * Local file-export hook for the CMS auto-save pipeline.
 *
 * When the server is configured with a local project root (INSTATIC_PROJECT_ROOT),
 * every successful site save writes the clean HTML of each changed page to
 * `<projectRoot>/.instatic/pages/<slug>.html`. The AI can then read these files
 * as normal workspace files.
 */
import '@modules/base'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { registry } from '@core/module-engine'
import { serializeNodeHtml } from '@core/publisher'
import type { SiteDocument } from '@core/page-tree'

function slugToFilename(slug: string): string {
  // Slashes are preserved as directory separators; everything else is
  // URL-encoded to keep the filesystem safe.
  return slug
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/%/g, '_'))
    .join('/')
}

export interface ExportSiteFilesOptions {
  /** If provided, only these page ids are exported; otherwise all pages. */
  pageIds?: ReadonlySet<string>
}

/**
 * Export the clean HTML of pages to `.instatic/pages/<slug>.html` under the
 * configured project root. Runs silently when no project root is configured.
 */
export async function exportSiteFiles(
  projectRoot: string | null | undefined,
  site: SiteDocument,
  options: ExportSiteFilesOptions = {},
): Promise<void> {
  if (!projectRoot) return

  const pagesToExport = options.pageIds
    ? site.pages.filter((p) => options.pageIds!.has(p.id))
    : site.pages

  if (pagesToExport.length === 0) return

  const baseDir = join(projectRoot, '.instatic', 'pages')
  await mkdir(baseDir, { recursive: true })

  for (const page of pagesToExport) {
    const html = serializeNodeHtml(page.rootNodeId, page, site, registry)
    const filePath = join(baseDir, `${slugToFilename(page.slug)}.html`)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, html, 'utf-8')
  }
}

/**
 * Remove the on-disk export file for a deleted page slug. Best-effort:
 * failures are ignored.
 */
export async function deleteExportedPageFile(
  projectRoot: string | null | undefined,
  slug: string,
): Promise<void> {
  if (!projectRoot) return
  try {
    const filePath = join(projectRoot, '.instatic', 'pages', `${slugToFilename(slug)}.html`)
    await rm(filePath)
  } catch {
    // File may not exist; ignore.
  }
}
