---
id: ide-cms-workflow
title: IDE CMS Workflow
keywords: ide cms workflow import export class design html style container text button link
summary: Rules for the IDE AI agent working with the Instatic CMS via the MCP HTTP API tools
---

# IDE CMS Workflow — Always Active

You are operating the Instatic CMS from inside an IDE-based AI agent (Windsurf Cascade). The MCP tools you can use are:

- `cms_export_html` — read the current draft HTML of a page
- `cms_import_html` — replace or merge a page with new HTML + CSS
- `cms_get_pages` — (optional) list all pages with slug and title when you are unsure which page to work on
- `cms_get_site` — (optional) read the site catalog: design tokens, registered modules, breakpoints, and page slugs
- `cms_get_components` — (optional) list reusable visual components
- `cms_get_layouts` — (optional) list saved page layouts
- `cms_get_data_tables` — (optional) list data collections for dynamic loops
- `cms_get_class` — (fallback only) inspect a single class by name or id if the static registry is unclear

The class registry is read from the static file `scripts/mcp/injections/cms-classes.md`.

## 0. Check MCP tool reachability first — abort if tools are unreachable

Before doing anything, verify that the MCP tools are actually reachable. Call `cms_export_html` as a health check.

- If `cms_export_html` returns successfully, you may proceed.
- If it returns a transport error, timeout, "transport closed", or any other failure that indicates the MCP server or relay is not connected, **stop immediately**. Do not attempt alternative methods, fallbacks, direct HTTP calls, or workarounds. Tell the user: *"The MCP tools are not reachable right now. The CMS workflow cannot continue until the connection is restored."* and explain the specific error you saw.
- Do not freestyle, guess, or bypass the tools to accomplish the goal. The workflow relies on these tools for safety and consistency.

## 1. Always start by reading the current state

Before designing or editing anything, gather **both** pieces of context:

1. `cms_export_html(slug)` — understand the current page structure, content, and classes.
2. Read the static class registry file: `scripts/mcp/injections/cms-classes.md`. This file contains every class in the CMS with its CSS and intended purpose. Use it to discover the existing class vocabulary, spacing, colors, typography, and naming conventions.

You may only proceed after you have the export HTML and have read the class registry file.

## 1.1 Optional catalog tools

Use these tools when you need broader context before exporting or designing:

- `cms_get_pages` — when you do not know the page slug or want to confirm the page exists.
- `cms_get_site` — when you need the design system (tokens, breakpoints, modules) before designing. This is the best source for `var(--token)` values and module names.
- `cms_get_components` — when the user asks to reuse or reference an existing visual component.
- `cms_get_layouts` — when the user asks to apply or reference an existing saved layout.
- `cms_get_data_tables` — when you need to build a dynamic loop or reference a collection.

## 2. Reuse existing classes — do not invent your own

The CMS already has a class registry. Every visual decision (font-size, color, spacing, border-radius, shadow, etc.) should be expressed through an existing class when possible.

- Check the static registry file `scripts/mcp/injections/cms-classes.md` first for classes that already provide the style you need.
- If a class exists with the right CSS, use it. Do not create a duplicate.
- If you need a small tweak, prefer editing an existing class via the CMS UI rather than minting a new one.
- Only create a new class when no existing class provides the required style.

## 3. Class naming conventions for new classes

When you must create a new class, follow CMS conventions:

- Use lowercase, kebab-case names: `.hero-title`, `.badge-primary`, `.button-lg`.
- Make names generic and reusable, not tied to a specific page or campaign.
- Prefer functional names: `.text-center`, `.stack-md`, `.radius-lg`.
- Avoid page-specific names like `.oasis-hero-title` or `.landing-section-3` unless the style truly is one-off.
- Group related concepts: `.button-primary`, `.button-secondary`, `.button-ghost` instead of `.btn-1`, `.btn-2`.

## 4. Use the CMS module naming conventions in the layers panel

Imported HTML is mapped to CMS modules. The DOM tree panel uses these names:

- `<div>`, `<section>`, `<article>`, `<header>`, `<footer>`, `<nav>`, `<aside>`, `<ul>`, `<ol>` → **Container**
- `<p>`, `<h1>`–`<h6>`, `<span>`, `<small>`, `<strong>`, `<em>` → **Text**
- `<a>` → **Link**
- `<button>` or button-styled `<a>` → **Button**

Write semantic HTML (`<nav>`, `<section>`, `<button>`, `<a>`) so the importer can attach the correct module overlays.

## 5. Send CSS in `<style>` blocks — never inline styles

When you call `cms_import_html`, include a `<style>` block in the HTML with the CSS for any new classes you need.

- Do NOT use `style="..."` attributes on elements.
- Do NOT use `style` tags inside the page body for ad-hoc styling.
- Put one `<style>` block at the top of the HTML with all required class rules.
- Use real CSS selectors: `.my-class { ... }`, `@media (max-width: 768px) { ... }`.
- The CMS will parse these rules into the global class registry, where they can be edited later.

## 6. Keep the page structure flat and intentional

- Avoid unnecessary wrapper divs. Each element should have a purpose.
- Use a `<section>` per major page block, not nested `<div>` soup.
- Put shared layout classes on the container, not on every child.
- If a section needs a unique background, use a class (e.g., `.hero-section`) instead of inline styles.

## 7. Replace vs merge

- Use `mode: 'replace'` when you are redesigning an entire page or section.
- Use `mode: 'merge'` only when you are appending a small fragment and you are certain the existing content should stay.
- When replacing, first export the page so you know what you are removing.

## 8. Verify after import

After calling `cms_import_html`, do the following:

1. Call `cms_export_html(slug)` again to confirm the HTML matches your intent.
2. Inspect the exported HTML for unexpected new class names or duplicates. If you see unexpected new classes, fix the import by editing the CSS and re-importing.

**Server restarts:** Do not restart the dev server, relay, or MCP server on your own. If a server error appears in the logs, verify whether the process is actually unreachable (e.g., a timeout or refused connection). Only ask the user to restart a service if it has genuinely crashed and is not accepting connections.

## 9. Typography and spacing

- Before hardcoding font sizes or padding, check the class list for typography/spacing utilities.
- If the site has design tokens (colors, fonts, type scales, spacing scales), reference them via `var(--token)` in your CSS.
- Prefer consistent spacing scales (e.g., `.stack-sm`, `.stack-md`, `.stack-lg`) over magic numbers.

## 10. Icons and media

- For icons, use inline SVG or simple text symbols. Do not rely on external icon fonts unless they are already loaded by the site.
- For images, use `<img>` with a placeholder `src` or `alt` text; the user can replace the source in the CMS.

## 11. The node/HTML hybrid model

The CMS is a hybrid: internally it stores a tree of PageNodes, but the only interface you use is clean HTML + CSS sent via `cms_import_html`.

- **Think in CMS node concepts** when structuring the page: a `<section>` becomes a **Container**, a `<p>` or `<h1>` becomes a **Text**, an `<a>` becomes a **Link**, and a `<button>` becomes a **Button**. The importer uses the HTML tag and CSS classes to attach the correct module overlays.
- **Do not emit CMS internals** in the HTML you send. Never hardcode `data-node-id`, `moduleId`, `classId`, or other implementation-specific attributes.
- The HTML you send should be clean, portable, and renderable outside the CMS. The CMS will map it to its own module and class system automatically.

## 12. Tool and JSON handling rules

When building the `html` payload for `cms_import_html` or doing any other tool interaction:

- **Use the MCP tools only** — `cms_export_html` and `cms_import_html`. Do not fall back to `curl`, direct HTTP requests, `fetch`, or shell scripts if the MCP tools fail.
- **Do not use `ConvertTo-Json`** — PowerShell's `ConvertTo-Json` does not serialize long HTML strings correctly; it can wrap the string as `"html":{"value":"..."}` instead of `"html":"..."`, which causes the CMS to reject the import with `Invalid request body`.
- **Prefer Bun/JavaScript for JSON** — use `JSON.stringify({ slug, html, mode })` in a `.ts` or `.js` script, or write the payload with a proper JSON library. If you must use shell, write the payload to a file with a tool that preserves the string shape.
- **Do not mutate the file system unnecessarily** — do not create extra temporary scripts, log files, or helper files beyond what is needed for a single verification step. Clean up temporary files after use.
- **Do not restart services** — do not restart the dev server, relay, or MCP server unless the process is genuinely unreachable. Error messages in logs are not enough to justify a restart.

## 13. Summary checklist

Before every `cms_import_html` call, confirm:

- [ ] `cms_export_html` was called to read the current page.
- [ ] The static class registry `scripts/mcp/injections/cms-classes.md` was read to discover existing classes.
- [ ] The MCP tools were confirmed reachable (or the session was aborted if they were not).
- [ ] Existing classes are reused wherever possible.
- [ ] New class names are generic, kebab-case, and reusable.
- [ ] CSS is in a `<style>` block at the top of the HTML.
- [ ] No inline `style="..."` attributes are used.
- [ ] Semantic HTML is used so the importer attaches correct module overlays.
- [ ] The import mode is intentional (`replace` or `merge`).

Follow these rules so the CMS stays clean, maintainable, and consistent with the user's existing design system.
