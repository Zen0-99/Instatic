---
id: design
title: Design Principles
keywords: design, landing, page, hero, minimal, modern, aesthetic, style, beautiful, ui, layout, color, typography, spacing, whitespace, clean
summary: 2026 minimal/modern design principles — spacing, typography, color discipline, hero patterns, and what to avoid.
---

# Design Guidance

## Core Principles (2026 Minimal Aesthetic)

1. **Restraint over abundance.** A minimal landing page is one strong headline, one supporting sentence, and one call-to-action. Not five sections of features.
2. **Whitespace is the design.** Generous padding and margins create visual hierarchy. Don't cram content edge-to-edge.
3. **Typography carries the page.** One or two font families. Large, confident headings. Readable body text. Let type do the heavy lifting.
4. **Limited color palette.** 2–3 colors maximum: a neutral base (near-white or near-black), one accent color, and maybe one secondary. Set these as design tokens first.
5. **One focal point per section.** The eye should know exactly where to look. Don't compete for attention.

## Recommended Structure for a Minimal Landing Page

```
<header>     — Logo or wordmark, minimal nav (1-2 links max)
<main>
  <section>  — Hero: large headline, short subtitle, one CTA button
  <section>  — (Optional) One supporting section: a feature, a quote, or an image
  <section>  — (Optional) Final CTA: repeat or rephrase the call to action
</main>
<footer>     — Minimal: copyright, one or two links
```

Do NOT include all sections by default. Start with hero + footer. Add sections only if the request calls for them.

## Design Token Setup

Before inserting HTML, set up tokens:

- **Colors**: `set_color_tokens` — define `--primary` (accent), `--bg` (background), `--text` (body text), `--muted` (subtle text). Use light/dark values.
- **Fonts**: `set_font_tokens` — one display font for headings, one body font. Use Google Fonts via `googleFamily`.
- **Type scale**: `set_type_scale` — define a range from small body to large display. Use a ratio (e.g., 1.25) for consistent steps.
- **Spacing**: `set_spacing_scale` — define a scale with consistent steps. This powers all `var(--space-*)` values.

## CSS Patterns

```css
/* Hero — centered, generous spacing */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80vh;
  text-align: center;
  padding: var(--space-8) var(--space-4);
}

.hero h1 {
  font-size: var(--text-5);
  font-weight: 700;
  line-height: 1.1;
  max-width: 20ch;
  margin: 0 0 var(--space-3);
}

.hero p {
  font-size: var(--text-2);
  color: var(--muted);
  max-width: 40ch;
  margin: 0 0 var(--space-6);
}

.cta-button {
  display: inline-block;
  padding: var(--space-2) var(--space-5);
  background: var(--primary);
  color: var(--bg);
  border: none;
  border-radius: var(--radius, 8px);
  font-size: var(--text-1);
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
```

## What to Avoid

- **Generic SaaS copy.** No "Build faster", "Ship with confidence", "Powerful features". Write something specific to the actual product or purpose.
- **3-column feature grids.** The "icon + title + description" x3 pattern is overused and reads as filler. If you need features, pick ONE and explain it well.
- **Gradient text.** Overused trend. Use solid colors.
- **Stock photo placeholders.** Don't insert `<img>` tags with placeholder URLs unless asked.
- **Excessive sections.** A minimal landing page is minimal. Don't add testimonials, pricing tables, FAQ accordions, or blog previews unless explicitly requested.
- **Centering everything.** Center the hero. Left-align body content for readability.

## Workflow

1. `cms_get_site` + `cms_list_pages` — understand current state
2. Set design tokens (colors, fonts, scales)
3. `insertHtml` or `replaceNodeHtml` — add content with semantic HTML and class names
4. `applyCss` — style with real CSS using the tokens
5. `render_snapshot` — verify the result
6. `cms_publish` — if the user wants it live
