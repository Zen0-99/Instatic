---
id: publishing
title: Publishing & Deployment
keywords: publish, deploy, live, draft, production, snapshot, status, push, release, public
summary: Draft vs. publish, cms_publish, cms_publish_status, when to publish.
---

# Publishing Guidance

## Draft vs. Published

Instatic maintains a **draft** state (what you see in the editor) and a **published** state (what visitors see on the live site). Changes you make with tools like `insertHtml`, `applyCss`, `set_color_tokens` etc. modify the draft. They are NOT live until you publish.

### Key tools

- `cms_publish` — push the entire draft as a new published snapshot. This makes all draft changes live.
- `cms_publish_status` — check if the draft has unpublished changes (compare draft freshness vs. last published snapshot).
- `cms_publish_data_row` — publish a single data row (push draft to live) without publishing the whole site.

## When to Publish

- **Publish when**: the user asks for changes to go live, or when all requested work is complete and verified.
- **Don't publish when**: the user is still iterating, or you're mid-way through a multi-step change.
- **Check first**: use `cms_publish_status` to confirm there are unpublished changes before calling `cms_publish`.

## Workflow

1. Make all requested changes (content, styling, structure).
2. `render_snapshot` — verify the result looks correct.
3. `cms_publish_status` — confirm there are draft changes to publish.
4. `cms_publish` — push to live.
5. Confirm to the user that changes are published.

## Tips

- Publishing creates a snapshot — you can't partially publish the site shell. All draft changes go live at once.
- Data rows can be published individually with `cms_publish_data_row` if only content changed.
- After publishing, the draft and published states are in sync until the next change.
