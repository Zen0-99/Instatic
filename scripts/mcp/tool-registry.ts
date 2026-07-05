/**
 * MCP tool registry — IDE-only HTTP API tools for the Cascade → CMS workflow.
 *
 * Browser-bridged tools, chat-relay tools, and local tools are intentionally
 * excluded. The IDE MCP server only needs direct HTTP API calls to the CMS
 * REST endpoints for import/export and class discovery.
 */

import { Type } from '../../src/core/utils/typeboxHelpers'

export type ToolExecution = 'http-api'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: object
  execution: ToolExecution
}

function json(schema: object): object {
  return JSON.parse(JSON.stringify(schema))
}

// ---------------------------------------------------------------------------
// HTTP API tools — direct CMS REST API calls
// ---------------------------------------------------------------------------

export const allTools: McpToolDef[] = [
  {
    name: 'cms_import_html',
    description: 'Send clean HTML to the CMS to create or update a page. The CMS parses the HTML, maps it to PageNodes, saves the page, and registers any class names found in the HTML. Include a <style> block so the CSS is parsed into editable style rules.',
    inputSchema: json(Type.Object({
      slug: Type.String(),
      title: Type.Optional(Type.String()),
      html: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal('replace'), Type.Literal('merge')])),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_export_html',
    description: 'Fetch the current draft HTML of a CMS page as clean, id-less HTML so the IDE AI can see the latest state before designing.',
    inputSchema: json(Type.Object({
      slug: Type.String(),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_get_pages',
    description: 'List all pages in the CMS with their slug, title, and id. Use this when you need to discover which pages exist or confirm a page slug before exporting or importing.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_get_site',
    description: 'Read the site catalog: design tokens (colors, typography, spacing, fonts), registered modules, breakpoints, and page slugs. Use this before designing so you know which tokens and modules are available.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_get_components',
    description: 'List all reusable visual components in the CMS with their id, name, and metadata. Use this when you want to know which components already exist before designing.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_get_layouts',
    description: 'List all saved layouts in the CMS with their id, name, and metadata. Use this when you want to know which page layouts already exist.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_get_data_tables',
    description: 'List all data tables (collections) in the CMS with their slug, label, and kind. Use this when you need to build dynamic loops or reference collection data.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_get_class',
    description: 'Get a single class-style rule by name or id. Returns its CSS properties, context overrides, and metadata. Use when you need to inspect an existing class before modifying it.',
    inputSchema: json(Type.Object({
      name: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_list_classes',
    description: 'List all CSS class-style rules in the site catalog. Returns each class with its selector, CSS properties, and order. Use this to discover the available CSS vocabulary before designing.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_get_page',
    description: 'Get a single page by its slug. Returns the page row including title, id, and body nodes. Use this when you only need one specific page rather than the full page list.',
    inputSchema: json(Type.Object({
      slug: Type.String(),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_get_publish_status',
    description: 'Check whether the current draft site has unpublished changes compared to the last published snapshot.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
]

export const toolByName = new Map<string, McpToolDef>(
  allTools.map((t) => [t.name, t]),
)
