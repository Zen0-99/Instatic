/**
 * MCP tool registry — IDE tools for the Cascade → CMS workflow.
 *
 * Two execution categories, kept separate for debugging:
 *   - 'http-api'       → direct CMS REST API calls (page-level, no editor needed)
 *   - 'browser-bridge'  → relayed to the open Instatic editor via
 *                         POST /admin/api/ai/execute-tool (node-level edits,
 *                         CSS authoring, design tokens, code assets, render
 *                         snapshots, content writes, …). Requires the site
 *                         editor to be open in a browser.
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
  UpdateDomNodeInputSchema,
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
} from '../../src/core/ai'

export type ToolExecution = 'http-api' | 'browser-bridge' | 'server'

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
  {
    name: 'cms_add_page',
    description: 'Create a new page in the CMS. Provide a title and optionally a slug. The slug is made unique automatically.',
    inputSchema: json(Type.Object({
      title: Type.String({ minLength: 1 }),
      slug: Type.Optional(Type.String()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_delete_page',
    description: 'Delete a CMS page by its id. The last page in a site cannot be deleted.',
    inputSchema: json(Type.Object({
      pageId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_rename_page',
    description: 'Rename a CMS page and optionally change its slug.',
    inputSchema: json(Type.Object({
      pageId: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      slug: Type.Optional(Type.String()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_duplicate_page',
    description: 'Duplicate a CMS page under a new title and optional slug.',
    inputSchema: json(Type.Object({
      pageId: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      slug: Type.Optional(Type.String()),
    })),
    execution: 'http-api',
  },

  // ── Publishing ──────────────────────────────────────────────────────────

  {
    name: 'cms_publish',
    description: 'Push the current draft site as a new published snapshot. This makes all draft changes live.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },

  // ── Data Tables CRUD ─────────────────────────────────────────────────────

  {
    name: 'cms_create_data_table',
    description: 'Create a new data table (collection). Provide a name; optionally a slug, kind, routeBase, labels, and fields schema.',
    inputSchema: json(Type.Object({
      name: Type.String({ minLength: 1 }),
      slug: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      routeBase: Type.Optional(Type.String()),
      singularLabel: Type.Optional(Type.String()),
      pluralLabel: Type.Optional(Type.String()),
      primaryFieldId: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Unknown()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_get_data_table',
    description: 'Read a single data table by its id, including its field schema and metadata.',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_update_data_table',
    description: 'Partially update a data table. Pass only the fields you want to change (name, slug, routeBase, labels, primaryFieldId, fields).',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String()),
      slug: Type.Optional(Type.String()),
      routeBase: Type.Optional(Type.String()),
      singularLabel: Type.Optional(Type.String()),
      pluralLabel: Type.Optional(Type.String()),
      primaryFieldId: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Unknown()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_delete_data_table',
    description: 'Soft delete a data table by its id. Rows in the table are preserved but hidden.',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },

  // ── Data Rows CRUD ───────────────────────────────────────────────────────

  {
    name: 'cms_list_data_rows',
    description: 'List all data rows in a specific data table. Returns row cells, slug, status, and metadata.',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_create_data_row',
    description: 'Create a new draft data row in a table. Pass a cells object mapping field ids to values.',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
      cells: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_get_data_row',
    description: 'Read a single data row by its id, including all cell values.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_save_data_row',
    description: 'Save draft cell values for an existing data row. Pass a cells object mapping field ids to values.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
      cells: Type.Record(Type.String(), Type.Unknown()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_delete_data_row',
    description: 'Soft delete a data row by its id.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_publish_data_row',
    description: 'Publish a data row, making its content live on the site.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_update_data_row_status',
    description: 'Flip a data row between draft and unpublished status.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
      status: Type.Union([Type.Literal('draft'), Type.Literal('unpublished')]),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_update_data_row_author',
    description: 'Reassign a data row to a different author by user id.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
      authorUserId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_move_data_row',
    description: 'Move a data row to a different data table. This changes the row\'s URL base.',
    inputSchema: json(Type.Object({
      rowId: Type.String({ minLength: 1 }),
      tableId: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },

  // ── Data Search & Authors ────────────────────────────────────────────────

  {
    name: 'cms_search_data',
    description: 'Search across all data rows by query string. Returns lightweight matches (slug, table info, status) without full cell content.',
    inputSchema: json(Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Number()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_list_data_authors',
    description: 'List all users that can be assigned as authors of data rows.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },

  // ── Fonts ────────────────────────────────────────────────────────────────

  {
    name: 'cms_list_google_fonts',
    description: 'List the bundled Google Fonts directory (no CDN hit). Use this to discover available font families, variants, and subsets before installing.',
    inputSchema: json(Type.Object({})),
    execution: 'http-api',
  },
  {
    name: 'cms_install_google_font',
    description: 'Download and install a Google Font family. The font files are saved on-disk and a FontEntry is returned for merging into site settings.',
    inputSchema: json(Type.Object({
      family: Type.String({ minLength: 1 }),
      variants: Type.Array(Type.String()),
      subsets: Type.Array(Type.String()),
    })),
    execution: 'http-api',
  },
  {
    name: 'cms_uninstall_font_family',
    description: 'Remove on-disk font files for a font family. The font metadata in site settings is not modified — remove it separately via site settings.',
    inputSchema: json(Type.Object({
      family: Type.String({ minLength: 1 }),
    })),
    execution: 'http-api',
  },

  // ==========================================================================
  // Browser-bridge tools — relayed to the open Instatic editor via
  // POST /admin/api/ai/execute-tool. Requires the site editor to be open.
  // ==========================================================================

  // ── HTML-native write tools ────────────────────────────────────────────────

  {
    name: 'site_insert_html',
    description:
      'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML (<section>, <h1>, <a>, <button>, <img>, <ul>, ...) and style it with CSS in the same call: put a <style> block in the HTML and/or class= attributes. Custom importer markers: <instatic-loop data-source-id="…" ...> creates a real Loop node (call site_list_loop_sources first for source/table ids and {currentEntry.*} tokens); <instatic-outlet> creates a template content outlet. The importer parses every rule — a bare `.foo {}` selector becomes a reusable Selectors-panel class bound to class="foo"; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule. Inline style= attributes land on the node\'s inline styles. To author or edit CSS on its own — pseudo/hover/descendant selectors, or restyling existing rules — use the dedicated site_apply_css tool instead (site_insert_html is for inserting structure). Returns `nodeIds` (the inserted roots) and `created` — every inserted node as { id, moduleId, classes } — so you can target a nested node (e.g. the wrapper you just added) without re-reading the whole tree.',
    inputSchema: json(InsertHtmlInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_get_node_html',
    description:
      'Return the current HTML the published page would emit for a node subtree. Use before site_replace_node_html to read existing structure.',
    inputSchema: json(GetNodeHtmlInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_read_document',
    description:
      'Read any editable document as annotated HTML + relevant CSS without switching the visible canvas. Pass a document ref from site_list_documents; omit document to read the current document. If pageInfo.nextPart is not null, call site_read_document again with the same document and part.',
    inputSchema: json(ReadDocumentInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_open_document',
    description:
      'Visibly open a page/template/visual component document in the editor. Use before site_render_snapshot or when the user asks to navigate. For background inspection, prefer site_read_document because it does not move the canvas.',
    inputSchema: json(OpenDocumentInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_replace_node_html',
    description:
      "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML. Style with CSS exactly as in site_insert_html: a <style> block and/or class= attributes; bare `.foo` selectors become reusable classes, other selectors become ambient rules. Custom importer markers work here too: <instatic-loop data-source-id=\"…\" ...> creates a real Loop node and <instatic-outlet> creates a template content outlet. To author or edit CSS on its own (without rebuilding children), use the dedicated site_apply_css tool instead.",
    inputSchema: json(ReplaceNodeHtmlInputSchema),
    execution: 'browser-bridge',
  },

  // ── Node-level write tools ──────────────────────────────────────────────────

  {
    name: 'site_delete_node',
    description:
      'Remove a node and its descendants. Not undoable from inside the loop (user can Cmd+Z after).',
    inputSchema: json(DeleteNodeInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_update_node_props',
    description:
      'Shallow-merge a patch onto an existing node\'s props. `breakpointId` is only valid for props marked `breakpointOverridable` in the schema (rejected for content props like text/tag/src). For per-breakpoint visual variation use site_apply_css with an `@media` query, not this. Richtext props are auto-sanitised.',
    inputSchema: json(UpdateNodePropsInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_update_dom_node',
    description:
      'Update a DOM-native node (a raw HTML element with no module — e.g. <figure>, <blockquote>, <li>, <mark>). Pass `tag` to change the element type, `attributes` to replace all HTML attributes (pass null to clear), or `textContent` to set/clear leaf text (pass null to clear). Use site_update_node_props for module-based nodes instead.',
    inputSchema: json(UpdateDomNodeInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_move_node',
    description:
      "Move a node to a different parent and/or position. `newIndex` is 0-based among the destination's children.",
    inputSchema: json(MoveNodeInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_rename_node',
    description:
      "Set the node's display label in the DOM tree panel. Editor-only; doesn't affect rendered HTML.",
    inputSchema: json(RenameNodeInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_duplicate_node',
    description:
      "Deep-clone a node + subtree (props, classIds, breakpoint overrides) right after the original. `count` (1-50, default 1) produces N clones in one call. Success data includes the first new node id as `nodeId` and all new ids as `nodeIds`.",
    inputSchema: json(DuplicateNodeInputSchema),
    execution: 'browser-bridge',
  },

  // ── CSS + class-assignment write tools ───────────────────────────────────────

  {
    name: 'site_apply_css',
    description:
      'Author or edit CSS — the single tool for ALL styling that isn\'t attached inline. Pass real CSS text and it is parsed and UPSERTED into the site: a bare `.foo { … }` selector creates or edits a reusable class (bound to class="foo"); ANY other selector — descendant (`.hero a`), child (`nav > li`), pseudo-class/element (`a:hover`, `.card::before`), attribute, element (`h1`) — creates or edits an ambient rule that attaches by matching, no class attribute needed. `@media` queries fold into per-breakpoint overrides (matched against the site breakpoints); other `@media`/`@supports`/`@container` round-trip as reusable conditions. Re-applying a selector MERGES onto the existing rule, so this both creates new styles and edits existing ones (e.g. `.hero a:hover { color: var(--primary) }` to restyle an existing descendant rule). Reference design tokens — `var(--primary)`, `var(--text-l)`, `var(--space-m)` — not raw hex/px. A reusable class is just a bare `.name` selector (a CSS identifier, no spaces). Success data: `{ cssRulesCreated, cssRulesUpdated }`.',
    inputSchema: json(ApplyCssInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_assign_class',
    description:
      "Attach an existing CSS class to a node. `classId` accepts id or name.",
    inputSchema: json(AssignClassInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_remove_class',
    description:
      'Detach a class from a node (the class itself is not deleted). `classId` accepts id or name.',
    inputSchema: json(RemoveClassInputSchema),
    execution: 'browser-bridge',
  },

  // ── Code asset tools ─────────────────────────────────────────────────────────

  {
    name: 'site_list_code_assets',
    description:
      'List user-authored runtime code assets stored in the site file layer. Optional `type` filters to scripts or styles. Returns file ids, paths, content hashes, size metadata, and current runtime config. Use before site_read_code_asset / site_patch_code_asset when modifying existing scripts or stylesheets.',
    inputSchema: json(ListCodeAssetsInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_read_code_asset',
    description:
      'Read one script or stylesheet by fileId or path. Returns the exact content slice, full-file SHA-256 hash, runtime config, and pageInfo for pagination. If pageInfo.nextPart is not null, call site_read_code_asset again with the same asset and part.',
    inputSchema: json(ReadCodeAssetInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_write_code_asset',
    description:
      'Create or replace a runtime script/style file in site.files and attach normalized site.runtime config. Use `type:"script"` for behavior such as theme toggles, menus, tabs, analytics hooks, and DOM-ready interactions; use `type:"style"` for global user stylesheets that should load as files. `path` is a safe site-relative path such as src/scripts/theme-toggle.js or src/styles/theme.css. `runtime` is optional and merges with existing/default config. For module scripts that import npm packages, use bare package imports in `content` and declare them in `dependencies` (package name → semver/range) so they are added to the site dependency manifest; do not use npm CDN URLs for npm packages.',
    inputSchema: json(WriteCodeAssetInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_patch_code_asset',
    description:
      'Patch an existing script or stylesheet by exact text replacement. Requires the latest `expectedHash` from site_read_code_asset/site_list_code_assets to prevent stale edits. Each replacement must match exactly; if oldText occurs multiple times, either make oldText more specific or set replaceAll:true.',
    inputSchema: json(PatchCodeAssetInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_inspect_code_runtime',
    description:
      'Inspect which runtime scripts and user stylesheets apply to the current page/template, or to a supplied page/template document ref. Returns each asset path, enabled state, scope applicability, priority, and script placement/timing. Use after site_write_code_asset to confirm a script/style is targeted correctly.',
    inputSchema: json(InspectCodeRuntimeInputSchema),
    execution: 'browser-bridge',
  },

  // ── Page-level write tools ───────────────────────────────────────────────────

  {
    name: 'site_add_page',
    description:
      'Add an EMPTY page and make it the active page. `slug` defaults to a slugified title and is auto-uniqued (a repeat add becomes `-2`, `-3`) — so never call site_add_page twice for the same page. Success data: `pageId` and `rootNodeId`. To build into the new page, pass `rootNodeId` as site_insert_html\'s `parentId` — a pageId is NOT a node id. The page is already active, so just start inserting; no need to site_read_document/site_list_documents first. For copying an existing page use site_duplicate_page.',
    inputSchema: json(AddPageInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_delete_page',
    description:
      'Permanently delete a page. Fails if it would leave the site with zero pages.',
    inputSchema: json(DeletePageInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_rename_page',
    description:
      "Change a page's title and/or slug. `slug=\"index\"` makes this page the homepage. Omit slug to keep it.",
    inputSchema: json(RenamePageInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_duplicate_page',
    description:
      'Deep-clone an existing page (every node, prop, class assignment, breakpoint override) under a new title/slug. Node ids are regenerated; class assignments preserved. Success data includes the new id as `pageId`.',
    inputSchema: json(DuplicatePageInputSchema),
    execution: 'browser-bridge',
  },

  // ── Template write tools ─────────────────────────────────────────────────────

  {
    name: 'site_set_page_template',
    description:
      'Turn a page INTO a template (or update an existing template\'s target/priority). `target` is `{kind:"everywhere"}` for a site-wide layout that wraps every page+entry, `{kind:"postTypes", tableSlugs:[…]}` to wrap entries of those post types (slugs from site_list_post_types), or `{kind:"notFound"}` for the page served on public 404s (status 404, wrapped by the everywhere layout; needs no outlet). `priority` (default 100) breaks ties when several templates match at the same breadth level — higher wins. An everywhere/postTypes template needs exactly one `<instatic-outlet>` (insert it via site_insert_html) marking where matched content flows; a wrapper template with no outlet simply doesn\'t apply. Pass a real page id from the suffix / site_list_documents.',
    inputSchema: json(SetPageTemplateInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_clear_page_template',
    description:
      'Revert a template back to an ordinary page: drops its template target and any dynamic bindings. The `<instatic-outlet>` node (if any) stays — delete it separately if unwanted. No-op error if the page is not a template.',
    inputSchema: json(ClearPageTemplateInputSchema),
    execution: 'browser-bridge',
  },

  // ── Design-system token write tools ──────────────────────────────────────────

  {
    name: 'site_set_color_tokens',
    description:
      'Create or update framework COLOR tokens — the source of truth for color. Each `{ slug, lightValue }` becomes `var(--<slug>)` plus generated utility classes (text-/bg-/border-) and shade/tint variants. Create-or-update is keyed by `slug`: an existing slug is patched, a new one is created. `lightValue` is any CSS color (hex/rgb/hsl); omit `darkValue` to auto-generate it. Establish color tokens before styling and reference them as `var(--<slug>)` instead of raw hex.',
    inputSchema: json(SetColorTokensInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_set_font_tokens',
    description:
      'Create or update FONT tokens — named typefaces referenced as `var(--<variable>)`. Pass `googleFamily` (e.g. "Inter") to install a new Google web font (downloads the files, then binds the token to it); `variants` defaults to ["400","700"] and `subsets` to ["latin"]. Pass `familyId` to reference an already-installed family. Pass neither for a fallback-only/system token. Create-or-update is keyed by `variable` (defaults from `name`). Prefer exactly one of `googleFamily` or `familyId`; if both are sent, `googleFamily` wins and the stale `familyId` is ignored.',
    inputSchema: json(SetFontTokensInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_set_type_scale',
    description:
      'Configure the TYPOGRAPHY scale — the fluid type ramp generating `--text-*` variables (default prefix "text"). A scale is a config: `min`/`max` give the base `fontSize` (px) and `scaleRatio` at the small/large screen anchors; `steps` is the comma-separated step list (e.g. "xs,s,m,l,xl,2xl,3xl,4xl") and `baseScaleIndex` picks which step equals the base size. Creates the group if none exists, else updates it. Only pass `groupId` when you have a real existing group id; use `namingConvention:"text"` for the prefix. Reference sizes as `var(--text-l)` rather than raw px.',
    inputSchema: json(SetTypeScaleInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'site_set_spacing_scale',
    description:
      'Configure the SPACING scale — the fluid spacing ramp generating `--space-*` variables (default prefix "space"). Same shape as site_set_type_scale but `min`/`max` carry `size` (px) instead of `fontSize`; `steps` defaults to an 11-step scale and `baseScaleIndex` to 5 ("m"). Creates the group if none exists, else updates it. Only pass `groupId` when you have a real existing group id; use `namingConvention:"space"` for the prefix. Reference gaps/padding as `var(--space-l)` rather than raw px.',
    inputSchema: json(SetSpacingScaleInputSchema),
    execution: 'browser-bridge',
  },

  // ── Render snapshot ──────────────────────────────────────────────────────────

  {
    name: 'site_render_snapshot',
    description:
      "Inspect the rendered canvas. Returns a layout report: viewport size, per-node bounding boxes, image-load status, and warnings (overflow / broken-image / invisible-node) — enough to catch most layout bugs in text. On a vision-capable model a screenshot is also attached as an image. Pass `breakpointId` to choose which breakpoint frame (defaults to active). Pass `nodeId` to capture just that node's subtree — a sharper, cheaper image than the whole page, and a report scoped to that section with coordinates relative to the node; omit `nodeId` to capture the full page.",
    inputSchema: json(RenderSnapshotInputSchema),
    execution: 'browser-bridge',
  },
  {
    name: 'cms_render_snapshot',
    description:
      'Headless render snapshot for API-based agents. Returns the current draft HTML of a page plus a structured layout summary (sections, classes, text) WITHOUT requiring the Instatic editor to be open. This is the API-safe counterpart to site_render_snapshot, which only works when the IDE has a live browser editor. Use this tool when you cannot rely on a browser bridge.',
    inputSchema: json(RenderSnapshotInputSchema),
    execution: 'server',
  },

  // ── Content write tools (browser-bridged) ────────────────────────────────────

  {
    name: 'content_create_document',
    description:
      "Create a new document in `tableId`. `fields` is a Record<fieldId, value> per the collection's schema; omit to create an empty draft. `status` defaults to 'draft'. Success data includes the new id as `documentId`; the bridge auto-switches the user's editor to the new doc so they can see what you built.",
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
      fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      status: Type.Optional(Type.Union([
        Type.Literal('draft'),
        Type.Literal('unpublished'),
        Type.Literal('published'),
        Type.Literal('scheduled'),
      ])),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_delete_document',
    description:
      'Soft-delete a document. User can restore via the Trash UI.',
    inputSchema: json(Type.Object({
      documentId: Type.String({ minLength: 1 }),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_set_document_status',
    description:
      "Set the document's lifecycle status. `status='scheduled'` requires `scheduledAt` (ISO datetime). Publishing requires the user to hold content.publish.own (own docs) or content.publish.any (any doc).",
    inputSchema: json(Type.Object({
      documentId: Type.String({ minLength: 1 }),
      status: Type.Union([
        Type.Literal('draft'),
        Type.Literal('unpublished'),
        Type.Literal('published'),
        Type.Literal('scheduled'),
      ]),
      scheduledAt: Type.Optional(Type.String({ minLength: 1 })),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_set_document_field',
    description:
      "Write one field on a document. `value` shape depends on the field type (read content_get_collection_schema first if unsure): text/longText/richText/url/email → string; number → number; boolean → boolean; date/dateTime → ISO string; select → option id; multiSelect → option id[]; media → { id } or { id }[]; relation → { rowId } or { rowId }[]; body → markdown string. Bridge converts markdown ↔ Tiptap automatically for body.",
    inputSchema: json(Type.Object({
      documentId: Type.String({ minLength: 1 }),
      fieldId: Type.String({ minLength: 1 }),
      value: Type.Unknown(),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_set_document_fields',
    description:
      'Batch-write multiple fields on one document. `fields` is Record<fieldId, value>; same per-type shapes as content_set_document_field. Prefer this when generating a whole post (title + slug + body + seo* in one call).',
    inputSchema: json(Type.Object({
      documentId: Type.String({ minLength: 1 }),
      fields: Type.Record(Type.String(), Type.Unknown()),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_set_document_author',
    description:
      'Reassign the document author to another user. Requires the caller to hold content.edit.any. Use content_list_users to find the right user id.',
    inputSchema: json(Type.Object({
      documentId: Type.String({ minLength: 1 }),
      userId: Type.String({ minLength: 1 }),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_set_active_document',
    description:
      "Switch the user's editor to this document so they can watch you work. Call BEFORE editing a doc that isn't already open — the user only sees the active doc, so content_set_document_field on a non-active doc happens invisibly.",
    inputSchema: json(Type.Object({
      documentId: Type.String({ minLength: 1 }),
    })),
    execution: 'browser-bridge',
  },
  {
    name: 'content_set_active_collection',
    description:
      'Switch the workspace sidebar focus to this collection. Use when working across collection-level actions (browsing, bulk reviews).',
    inputSchema: json(Type.Object({
      tableId: Type.String({ minLength: 1 }),
    })),
    execution: 'browser-bridge',
  },
]

export const toolByName = new Map<string, McpToolDef>(
  allTools.map((t) => [t.name, t]),
)
