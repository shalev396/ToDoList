---
name: todolist-builder
description: Use when the user wants to create, change, arrange or publish a TodoList dashboard or topic page - add blocks (list, table, kanban, calendar, chart, clock, counter, deadlines, note, filter), wire filters between blocks, or apply a Work, Personal or College template. Follows templates, then builder_preview, then a write with expectedVersion; publishes only when explicitly asked.
---

# TodoList: building dashboards safely

Every builder write is checked by the server (D12) and by a plugin hook: **a write is only accepted after the same change was previewed on the same draft version within the last 10 minutes.** Work in this order.

## The loop

1. **Look first.** `builder_list_dashboards` (topic `null` is the main dashboard; topics by their slug, as `workspace_get` lists them), then `builder_get_dashboard` for its draft and `version`.
2. **Start from a template** when one fits: `builder_list_templates`, then `builder_create_dashboard` with `fromTemplate`, or `builder_apply_template`. Use `builder_list_block_types` for block types and their schemas. Do not hand-build what a template already gives.
3. **Preview.** `builder_preview` with `dashboardId` and the change (`ops`, `patch` or `revertTo`). Read `valid`, `errors`, `warnings`, `diff` and the sample rows. Fix errors and preview again. `builder_validate` checks a config without the preview step.
4. **Write the identical change** with the same `expectedVersion` (the draft version you previewed against): `builder_add_block`, `builder_update_block`, `builder_arrange`, `builder_connect_blocks`, `builder_apply_patch`, and for views `builder_add_view`, `builder_update_view`. If someone else wrote in between, the version moves: re-read, re-preview, retry.
5. **Show the user** the result (and the preview URL if given). Check history with `builder_list_versions`; `builder_undo` reverts your own last changes.
6. **Publish only on the user's explicit request** (`builder_publish`, with the `expectedVersion` they reviewed). Publishing needs an owner's key with `builder:publish` and the workspace's agent-publish setting; if refused, tell the user the draft is saved and an owner can publish it in the app. Never publish as a side effect.

## Destructive builder tools

`builder_remove_block`, `builder_remove_view`, `builder_revert` and `builder_apply_template` with `mode: "replace"` take `confirm`. Without it they preview. Show the user the diff and wait for a yes before `confirm: true`.

## Views and personas

A page has views after its fixed, always-first Summary (the blocks no view names): a rigid view (list, board, timeline, calendar, table, agenda, workload, timesheet) is one full-page block, edited with `builder_update_block` on its `blockIds[0]`; a dashboard view is its own grid (`builder_add_block` with its `viewId`). `builder_add_view` takes a `type` or a view template (`builder_list_templates` `viewTemplates`). A Timesheet view (`type: "timesheet"`, or the `timesheet@1` template) shows a topic page's painted time (its areas, and its time blocks unless `viz.showBlocks` is false) on a week grid with the topic's open to-dos beside it, which the person drags onto the week to plan (`overlay.plannedAt`); its topic is its query's `topic` rule, `$page.topic` on a topic page. `builder_instantiate_persona` creates a persona's topics, pages and views (`personas`), idempotent per topic slug; run it with `dryRun: true` first, because its `shares` names the integrations it would share with the workspace. Limits: 20 views per page (the Summary included) and 40 blocks per grid.

## Rules and logic

- A block's query filters with a `where` group: `combinator` `and` or `or`, holding rules `{field, operator, value}` and nested groups (at most 4 levels). Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `notIn`, `contains`, `beginsWith`, `null`, `notNull`, `within`, `between`.
- Cross-filters: a filter block (or a chart click) sets a `$page.*` variable and other blocks `listen` to it. Wire it with `builder_connect_blocks`, not by hand.
- Display rules (`rules: [{if, then}]`) style rows; keep them few.

## Caps

At most 10 rules per block, 3 group-bys per block, 40 blocks per dashboard, 200 rows per query limit, preview up to 20 rows per block. The server rejects more; plan to stay inside.

## Block types

`list`, `table`, `kanban`, `calendar` (week by default, or month), `chart` (donut, bar, line, number), `clock`, `counter`, `deadlines`, `note`, `filter`, `action`. Each block shows data from the connectors (providers) the workspace has; filter by `provider` in the query when a block should show one source only.
