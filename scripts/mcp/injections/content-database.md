---
id: content-database
title: Content & Data Tables
keywords: data, database, table, collection, rows, content, cms, records, loop, instatic-loop, dynamic, posts, blog
summary: Data tables, collections, loops (instatic-loop), creating and seeding rows.
---

# Content & Database Guidance

## Data Tables (Collections)

Instatic uses data tables as content collections (e.g., "posts", "products", "team members"). Each table has a schema and rows.

### Key tools

- `cms_list_data_tables` — list all tables with schemas and row counts.
- `cms_list_data_rows` — list rows in a table (returns draft rows with cells).
- `cms_create_data_row` — create a new draft row.
- `cms_get_data_row` — get a single row by ID.
- `cms_save_data_row` — update a row's cells.
- `cms_delete_data_row` — soft-delete a row.
- `cms_publish_data_row` — push a draft row to live.

### Workflow

1. `cms_list_data_tables` to see what collections exist.
2. `cms_list_data_rows` to see existing content.
3. `cms_create_data_row` to add new rows (pass `tableId` and `cells`).
4. `cms_publish_data_row` to make rows live individually, or `cms_publish` to publish everything.

## Dynamic Loops

Use `<instatic-loop>` in `insertHtml` to create a Loop node that iterates over a data table:

```html
<instatic-loop data-source-id="posts">
  <article>
    <h2 data-field="title">Post title</h2>
    <p data-field="excerpt">Post excerpt</p>
  </article>
</instatic-loop>
```

- `data-source-id` — the table slug/id to iterate.
- `data-field` — binds a child element to a column in the table.
- The loop renders one instance per row at publish time.

## Tips

- Check the table schema (from `cms_list_data_tables`) before creating rows to know which fields exist.
- Seed a few sample rows so the page doesn't look empty during design.
- Use `render_snapshot` after creating a loop to verify the layout.
- Publish rows with `cms_publish_data_row` after creating them.
