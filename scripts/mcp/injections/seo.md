---
id: seo
title: SEO & Meta
keywords: seo, meta, title, slug, description, og, open graph, search, google, semantic, headings, hierarchy, index
summary: Titles, slugs, meta, semantic HTML, headings hierarchy for search visibility.
---

# SEO Guidance

## Page Metadata

- **Title**: Set via `renamePage` (the page title is used as the document title). Keep it under 60 characters. Include the primary keyword and brand name.
- **Slug**: Set via `renamePage`. Use lowercase, hyphens, no trailing slashes. E.g., `about-us`, not `About_Us`.
- **Homepage**: Use slug `index` to make a page the homepage.

## Heading Hierarchy

- One `<h1>` per page — the main headline.
- `<h2>` for section headings.
- `<h3>` for sub-sections within an `<h2>`.
- Don't skip levels (no `<h4>` directly under an `<h1>`).
- Search engines use heading hierarchy to understand page structure.

## Semantic HTML

Use proper elements — they carry SEO weight:
- `<main>` for primary content
- `<article>` for self-contained content
- `<section>` for thematic groupings
- `<nav>` for navigation
- `<header>` / `<footer>` for site-wide elements
- `<figure>` + `<figcaption>` for images with captions

## Clean URLs

- Use `renamePage` to set descriptive slugs: `services`, `pricing`, `contact`.
- Avoid query parameters in slugs.
- Keep slugs short and readable.

## Tips

- Write descriptive `alt` text on images (via `updateNodeProps` on `<img>` nodes).
- Ensure the page has a clear `<h1>` that matches the user's search intent.
- Use `cms_publish` to make SEO-relevant changes live — search engines only see published content.
- Check `cms_publish_status` before publishing to confirm there are draft changes.
