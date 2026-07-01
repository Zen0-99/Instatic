---
id: layout
title: Page Layout & Structure
keywords: layout, structure, page, section, header, footer, nav, grid, flexbox, responsive, breakpoint, mobile, hierarchy, nodes, dom
summary: Page structure, sections, responsive breakpoints, node hierarchy via insertHtml/replaceNodeHtml.
---

# Layout Guidance

## Page Structure

Instatic pages are trees of nodes. The root node is the page body. You build structure by inserting HTML under existing parent nodes.

### Key tools

- `insertHtml` — add a subtree under an existing parent. Pass real HTML with `<style>` blocks and/or `class=` attributes.
- `replaceNodeHtml` — replace a node's children with new HTML. The target node stays as the parent.
- `getNodeHtml` — read the current HTML of a node subtree before modifying it.
- `read_document` — read the full current document as annotated HTML.
- `render_snapshot` — inspect rendered layout (bounding boxes, viewport, warnings).

### Building a page

1. `cms_list_pages` to find the page and its `rootNodeId`.
2. `read_document` or `getNodeHtml` on the root to see the current structure.
3. `insertHtml` under the root (or a content wrapper) to add sections.
4. `applyCss` to style the layout.
5. `render_snapshot` to verify.

## Responsive Breakpoints

Instatic supports breakpoints (e.g., `mobile` at 375px). Use `@media` queries in `applyCss`:

```css
.hero {
  padding: var(--space-8) var(--space-4);
}

@media (max-width: 375px) {
  .hero {
    padding: var(--space-6) var(--space-3);
    min-height: 70vh;
  }
}
```

Check `cms_get_site` to see which breakpoints exist before writing media queries.

## Layout Patterns

### Centered hero
```html
<section class="hero">
  <h1>Headline</h1>
  <p>Subtitle</p>
  <a class="cta" href="#">Get started</a>
</section>
```

### Two-column (use sparingly)
```html
<section class="split">
  <div class="split-content">
    <h2>Heading</h2>
    <p>Text</p>
  </div>
  <div class="split-visual">
    <!-- image or visual element -->
  </div>
</section>
```

### Stacked sections
```html
<main>
  <section class="hero">...</section>
  <section class="features">...</section>
  <section class="cta-final">...</section>
</main>
```

## Node Management

- `moveNode` — reorder nodes within or across parents.
- `duplicateNode` — clone a node + subtree (useful for repeated sections).
- `deleteNode` — remove a node and its descendants.
- `updateNodeProps` — patch node props (e.g., change a tag name, add attributes).
- `renameNode` — set the display label in the editor tree (doesn't affect rendered HTML).

## Tips

- Keep the DOM shallow. Avoid deeply nested `<div>` wrappers — use semantic elements.
- Use `class` attributes in `insertHtml` so you can target them in `applyCss`.
- Group related CSS into one `applyCss` call rather than many small ones.
- Always verify with `render_snapshot` after structural changes.
