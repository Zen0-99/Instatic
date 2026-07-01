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
    case 'cms_get_site':
      return client.getSite(traceId)
    case 'cms_save_site':
      return client.saveSite(input.site as object, traceId)
    case 'cms_list_pages':
      return client.listPages(traceId)
    case 'cms_save_pages':
      return client.savePages({
        changedPages: (input.changedPages as object[]) ?? [],
        pageIds: (input.pageIds as string[]) ?? [],
        baselinePageIds: input.baselinePageIds as string[] | undefined,
      }, traceId)
    case 'cms_publish':
      return client.publish(traceId)
    case 'cms_publish_status':
      return client.publishStatus(traceId)
    case 'cms_list_data_tables':
      return client.listDataTables(traceId)
    case 'cms_list_data_rows':
      return client.listDataRows(input.tableId as string, traceId)
    case 'cms_create_data_row':
      return client.createDataRow(
        input.tableId as string,
        input.cells as Record<string, unknown> | undefined,
        traceId,
      )
    case 'cms_get_data_row':
      return client.getDataRow(input.rowId as string, traceId)
    case 'cms_save_data_row':
      return client.saveDataRow(
        input.rowId as string,
        input.cells as Record<string, unknown>,
        traceId,
      )
    case 'cms_delete_data_row':
      return client.deleteDataRow(input.rowId as string, traceId)
    case 'cms_publish_data_row':
      return client.publishDataRow(input.rowId as string, traceId)
    // ── Design token tools (fast path via HTTP API) ───────────────────────
    case 'set_color_tokens':
      return client.patchSiteField('colorTokens', (input.tokens as object[]) ?? [], traceId)
    case 'set_font_tokens':
      return client.patchSiteField('fontTokens', (input.tokens as object[]) ?? [], traceId)
    case 'set_type_scale':
      return client.patchSiteField('typeScales', buildScalePatch(input), traceId)
    case 'set_spacing_scale':
      return client.patchSiteField('spacingScales', buildScalePatch(input), traceId)
    default:
      return { error: `Unknown HTTP API tool: ${toolName}` }
  }
}

function buildScalePatch(input: Record<string, unknown>): object {
  const groupId = (input.groupId as string) || 'default'
  return {
    [groupId]: {
      namingConvention: input.namingConvention,
      steps: input.steps,
      min: input.min,
      max: input.max,
      baseScaleIndex: input.baseScaleIndex,
    },
  }
}
