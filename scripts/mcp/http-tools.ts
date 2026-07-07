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
    case 'cms_get_site':
      return client.getSiteCatalog(traceId)
    case 'cms_get_components':
      return client.getComponents(traceId)
    case 'cms_get_layouts':
      return client.getLayouts(traceId)
    case 'cms_get_data_tables':
      return client.listDataTables(traceId)
    case 'cms_get_class':
      return client.getClass(
        (input.name as string) || (input.id as string) || '',
        traceId,
      )
    case 'cms_list_classes':
      return client.listClasses(traceId)
    case 'cms_get_page':
      return client.getPageBySlug(input.slug as string, traceId)
    case 'cms_get_publish_status':
      return client.publishStatus(traceId)
    case 'cms_add_page':
      return client.addPage(
        input.title as string,
        input.slug as string | undefined,
        traceId,
      )
    case 'cms_delete_page':
      return client.deletePage(input.pageId as string, traceId)
    case 'cms_rename_page':
      return client.renamePage(
        input.pageId as string,
        input.title as string,
        input.slug as string | undefined,
        traceId,
      )
    case 'cms_duplicate_page':
      return client.duplicatePage(
        input.pageId as string,
        input.title as string,
        input.slug as string | undefined,
        traceId,
      )
    case 'cms_publish':
      return client.publish(traceId)
    case 'cms_create_data_table':
      return client.createDataTable(
        {
          name: input.name as string,
          slug: input.slug as string | undefined,
          kind: input.kind as string | undefined,
          routeBase: input.routeBase as string | undefined,
          singularLabel: input.singularLabel as string | undefined,
          pluralLabel: input.pluralLabel as string | undefined,
          primaryFieldId: input.primaryFieldId as string | undefined,
          fields: input.fields,
        },
        traceId,
      )
    case 'cms_get_data_table':
      return client.getDataTable(input.tableId as string, traceId)
    case 'cms_update_data_table': {
      const { tableId, ...patch } = input
      return client.updateDataTable(tableId as string, patch, traceId)
    }
    case 'cms_delete_data_table':
      return client.deleteDataTable(input.tableId as string, traceId)
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
    case 'cms_update_data_row_status':
      return client.updateDataRowStatus(
        input.rowId as string,
        input.status as 'draft' | 'unpublished',
        traceId,
      )
    case 'cms_update_data_row_author':
      return client.updateDataRowAuthor(
        input.rowId as string,
        input.authorUserId as string,
        traceId,
      )
    case 'cms_move_data_row':
      return client.moveDataRow(
        input.rowId as string,
        input.tableId as string,
        traceId,
      )
    case 'cms_search_data':
      return client.searchDataRows(
        input.query as string,
        input.limit as number | undefined,
        traceId,
      )
    case 'cms_list_data_authors':
      return client.listDataAuthors(traceId)
    case 'cms_list_google_fonts':
      return client.listGoogleFonts(traceId)
    case 'cms_install_google_font':
      return client.installGoogleFont(
        input.family as string,
        input.variants as string[],
        input.subsets as string[],
        traceId,
      )
    case 'cms_uninstall_font_family':
      return client.uninstallFontFamily(input.family as string, traceId)
    default:
      return { error: `Unknown HTTP API tool: ${toolName}` }
  }
}
