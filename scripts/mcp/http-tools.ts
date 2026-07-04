/**
 * HTTP API tool dispatcher — maps tool names to CMS REST API calls.
 */

import type { CmsClient } from './cms-client'

export async function executeHttpApiTool(
  toolName: string,
  input: Record<string, unknown>,
  client: CmsClient,
  traceId: string = 'http-api',
): Promise<unknown> {
  switch (toolName) {
    case 'cms_import_html':
      return client.importHtml(
        input.slug as string,
        input.html as string,
        input.title as string | undefined,
        input.mode as 'replace' | 'merge' | undefined,
        traceId,
      )
    case 'cms_export_html':
      return client.exportHtml(input.slug as string, traceId)
    case 'cms_get_pages':
      return client.listPages(traceId)
    case 'cms_get_class':
      return client.getClass(
        (input.name as string) || (input.id as string) || '',
        traceId,
      )
    default:
      return { error: `Unknown HTTP API tool: ${toolName}` }
  }
}
