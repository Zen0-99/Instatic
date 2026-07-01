/**
 * MCP tool registry — defines all tools exposed to Cascade via the MCP protocol.
 *
 * Three categories:
 *   1. Browser-bridged tools (25) — tool requests pushed down the chat SSE
 *      stream; the browser runs them via window.__instaticAgent.executeTool()
 *      and POSTs results back to /chat/tool-result.
 *   2. HTTP API tools (13) — direct HTTP calls to the CMS REST API.
 *   3. Chat relay tools (2) — bridge between CMS chat panel and Cascade.
 */

import { Type } from '../../src/core/utils/typeboxHelpers'
import {
  InsertHtmlInputSchema,
  GetNodeHtmlInputSchema,
  ReadDocumentInputSchema,
  OpenDocumentInputSchema,
  ReplaceNodeHtmlInputSchema,
  DeleteNodeInputSchema,
  UpdateNodePropsInputSchema,
  MoveNodeInputSchema,
  RenameNodeInputSchema,
  DuplicateNodeInputSchema,
  ApplyCssInputSchema,
  AssignClassInputSchema,
  RemoveClassInputSchema,
  ListCodeAssetsInputSchema,
  ReadCodeAssetInputSchema,
  WriteCodeAssetInputSchema,
  PatchCodeAssetInputSchema,
  InspectCodeRuntimeInputSchema,
  AddPageInputSchema,
  DeletePageInputSchema,
  RenamePageInputSchema,
  DuplicatePageInputSchema,
  SetPageTemplateInputSchema,
  ClearPageTemplateInputSchema,
  SetColorTokensInputSchema,
  SetFontTokensInputSchema,
  SetTypeScaleInputSchema,
  SetSpacingScaleInputSchema,
  RenderSnapshotInputSchema,
} from '../../src/core/ai/toolSchemas'

export type ToolExecution = 'browser' | 'http-api' | 'chat-relay' | 'local'

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
// Browser-bridged tools — same names/schemas as the in-CMS agent executor.
// Tool requests are pushed down the chat SSE stream; the browser executes
// them via window.__instaticAgent.executeTool() and POSTs results back.
// ---------------------------------------------------------------------------

const BROWSER_TOOL_DEFS: Array<[string, string, object]> = [
  ['insertHtml', 'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML and style it with CSS in the same call: put a <style> block in the HTML and/or class= attributes. Custom importer markers: <instatic-loop data-source-id="…" ...> creates a real Loop node; <instatic-outlet> creates a template content outlet.', InsertHtmlInputSchema],
  ['getNodeHtml', 'Return the current HTML the published page would emit for a node subtree. Use before replaceNodeHtml to read existing structure.', GetNodeHtmlInputSchema],
  ['read_document', 'Read any editable document as annotated HTML + relevant CSS without switching the visible canvas. Pass a document ref from list_documents; omit document to read the current document.', ReadDocumentInputSchema],
  ['open_document', 'Visibly open a page/template/visual component document in the editor. Use before render_snapshot or when the user asks to navigate.', OpenDocumentInputSchema],
  ['replaceNodeHtml', "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML.", ReplaceNodeHtmlInputSchema],
  ['deleteNode', 'Remove a node and its descendants.', DeleteNodeInputSchema],
  ['updateNodeProps', "Shallow-merge a patch onto an existing node's props. breakpointId is only valid for props marked breakpointOverridable in the schema.", UpdateNodePropsInputSchema],
  ['moveNode', "Move a node to a different parent and/or position. newIndex is 0-based among the destination's children.", MoveNodeInputSchema],
  ['renameNode', "Set the node's display label in the DOM tree panel. Editor-only; doesn't affect rendered HTML.", RenameNodeInputSchema],
  ['duplicateNode', 'Deep-clone a node + subtree (props, classIds, breakpoint overrides) right after the original. count (1-50, default 1) produces N clones.', DuplicateNodeInputSchema],
  ['applyCss', 'Author or edit CSS — the single tool for ALL styling. Pass real CSS text: a bare .foo {} selector creates/edits a reusable class; any other selector creates/edits an ambient rule. @media queries fold into per-breakpoint overrides. Reference design tokens as var(--primary) not raw hex.', ApplyCssInputSchema],
  ['assignClass', 'Attach an existing CSS class to a node. classId accepts id or name.', AssignClassInputSchema],
  ['removeClass', 'Detach a class from a node (the class itself is not deleted). classId accepts id or name.', RemoveClassInputSchema],
  ['list_code_assets', 'List user-authored runtime code assets. Optional type filters to scripts or styles.', ListCodeAssetsInputSchema],
  ['read_code_asset', 'Read one script or stylesheet by fileId or path. Returns content, hash, runtime config, and pageInfo for pagination.', ReadCodeAssetInputSchema],
  ['write_code_asset', 'Create or replace a runtime script/style file. Use type:"script" for behavior; type:"style" for global stylesheets.', WriteCodeAssetInputSchema],
  ['patch_code_asset', 'Patch an existing script or stylesheet by exact text replacement. Requires expectedHash from read_code_asset.', PatchCodeAssetInputSchema],
  ['inspect_code_runtime', 'Inspect which runtime scripts and user stylesheets apply to the current page/template.', InspectCodeRuntimeInputSchema],
  ['addPage', 'Add an EMPTY page and make it active. slug defaults to slugified title. Returns pageId and rootNodeId.', AddPageInputSchema],
  ['deletePage', 'Permanently delete a page. Fails if it would leave the site with zero pages.', DeletePageInputSchema],
  ['renamePage', "Change a page's title and/or slug. slug=\"index\" makes this page the homepage.", RenamePageInputSchema],
  ['duplicatePage', 'Deep-clone an existing page under a new title/slug. Returns new pageId.', DuplicatePageInputSchema],
  ['setPageTemplate', 'Turn a page INTO a template. target is {kind:"everywhere"} for site-wide layout, {kind:"postTypes", tableSlugs:[...]} for post types, or {kind:"notFound"} for 404.', SetPageTemplateInputSchema],
  ['clearPageTemplate', 'Revert a template back to an ordinary page.', ClearPageTemplateInputSchema],
  ['render_snapshot', 'Inspect the rendered canvas. Returns a layout report with viewport size, per-node bounding boxes, and warnings. Pass breakpointId to choose breakpoint; pass nodeId to capture a subtree.', RenderSnapshotInputSchema],
]

export const browserTools: McpToolDef[] = BROWSER_TOOL_DEFS.map(
  ([name, description, schema]) => ({
    name,
    description,
    inputSchema: json(schema),
    execution: 'browser' as const,
  }),
)

// ---------------------------------------------------------------------------
// HTTP API tools — direct CMS REST API calls
// ---------------------------------------------------------------------------

export const httpApiTools: McpToolDef[] = [
  {
    name: 'cms_get_site',
    description: 'Get the draft site shell — breakpoints, design tokens, style rules, global config. Excludes pages (use cms_list_pages).',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_save_site',
    description: 'Replace the draft site shell. Send the full site object (not a patch). Excludes pages.',
    inputSchema: json(Type.Object({
      site: Type.Object({}, { additionalProperties: true }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_list_pages',
    description: 'List all pages in the draft site with their IDs, titles, slugs, and rootNodeIds.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_save_pages',
    description: 'Save incremental page changes. Body carries { changedPages, pageIds, baselinePageIds? }. changedPages: the pages actually changed (with id, slug, title, rootNodeId, nodes). pageIds: full roster of page ids. baselinePageIds: optional concurrency token — the ids the client originally loaded.',
    inputSchema: json(Type.Object({
      changedPages: Type.Array(Type.Object({}, { additionalProperties: true })),
      pageIds: Type.Array(Type.String()),
      baselinePageIds: Type.Optional(Type.Array(Type.String())),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_publish',
    description: 'Push the draft site as a new published snapshot. This makes changes live.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_publish_status',
    description: 'Check if the draft has unpublished changes (draft freshness vs last published snapshot).',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_list_data_tables',
    description: 'List all data tables (collections) with their schemas, row counts, and route info.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_list_data_rows',
    description: 'List rows in a data table. Returns draft rows with their cells.',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_create_data_row',
    description: 'Create a new draft row in a data table.',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
      cells: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_get_data_row',
    description: 'Get a single data row by ID.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_save_data_row',
    description: 'Update a data row\'s cells.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
      cells: Type.Record(Type.String(), Type.Unknown()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_delete_data_row',
    description: 'Soft-delete a data row.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_publish_data_row',
    description: 'Publish a data row (push draft to live).',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'set_color_tokens',
    description: 'Create or update framework COLOR tokens. Each {slug, lightValue} becomes var(--<slug>) plus utility classes.',
    inputSchema: json(SetColorTokensInputSchema),
    execution: 'http-api',
  },
  {
    name: 'set_font_tokens',
    description: 'Create or update FONT tokens. Pass googleFamily to install a Google web font.',
    inputSchema: json(SetFontTokensInputSchema),
    execution: 'http-api',
  },
  {
    name: 'set_type_scale',
    description: 'Configure the TYPOGRAPHY scale generating --text-* variables.',
    inputSchema: json(SetTypeScaleInputSchema),
    execution: 'http-api',
  },
  {
    name: 'set_spacing_scale',
    description: 'Configure the SPACING scale generating --space-* variables.',
    inputSchema: json(SetSpacingScaleInputSchema),
    execution: 'http-api',
  },
]

// ---------------------------------------------------------------------------
// Chat relay tools — bridge between CMS chat panel and Cascade
// ---------------------------------------------------------------------------

export const chatRelayTools: McpToolDef[] = [
  {
    name: 'get_cms_chat_messages',
    description: 'Check for pending chat messages from the Instatic CMS chat panel. Returns any messages that users have typed in the CMS "IDE Cascade" mode. Call this periodically (every 5-10 seconds) to check for new messages. When you receive a message, you have access to the full Instatic tool suite — use insertHtml, applyCss, addPage, updateNodeProps, and other tools to make changes directly. Returns {messages: [{id, text, timestamp}]}.',
    inputSchema: json(Type.Object({})),
    execution: 'chat-relay',
  },
  {
    name: 'send_cms_chat_response',
    description: 'Send a response back to the Instatic CMS chat panel. This displays the text in the CMS chat UI. Use after processing a message from get_cms_chat_messages. Include toolCalls to show which tools were executed and their results.',
    inputSchema: json(Type.Object({
      messageId: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1 }),
      toolCalls: Type.Optional(Type.Array(Type.Object({
        toolName: Type.String(),
        input: Type.Unknown(),
        result: Type.Unknown(),
      }))),
    })),
    execution: 'chat-relay',
  },
]

// ---------------------------------------------------------------------------
// Local tools — executed directly by the MCP server (no external calls)
// ---------------------------------------------------------------------------

export const localTools: McpToolDef[] = [
  {
    name: 'get_guidance',
    description: 'Load detailed how-to guidance for a named topic pack. Returns full markdown instructions. Use this when the user request involves an area you need specific guidance for (e.g., design principles, SEO, data tables, publishing). Valid pack ids: design, layout, content-database, copywriting, seo, publishing. You may call this multiple times for different packs.',
    inputSchema: json(Type.Object({
      pack: Type.String({ minLength: 1 }),
    })),
    execution: 'local',
  },
]

// ---------------------------------------------------------------------------
// Combined registry
// ---------------------------------------------------------------------------

export const allTools: McpToolDef[] = [
  ...browserTools,
  ...httpApiTools,
  ...chatRelayTools,
  ...localTools,
]

export const toolByName = new Map<string, McpToolDef>(
  allTools.map((t) => [t.name, t]),
)
