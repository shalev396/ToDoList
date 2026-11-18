---
name: todolist-tasks
description: Use whenever the user wants to add, create, change, finish, reopen or delete a to-do or task in TodoList. Carries the task methodology - search before creating, verb-first titles, topic and due date, idempotencyKey, never edit mirrored items, complete instead of delete, confirm destructive calls. Uses search_items, create_todo, update_todo, complete_todo, delete_todo, set_overlay.
---

# TodoList: the task methodology

A plugin hook enforces rules 1 to 5 below before `create_todo` runs and tells you what is missing. Follow them up front.

## Creating a to-do

1. **Search before creating.** Call `search_items` with the key words (and `topic` if known) first. If a matching open item exists, update it or tell the user; do not duplicate.
2. **Title**: verb-first and 120 characters or fewer ("Send the invoice to Dana", "Review PR 42"). Put detail in `note`, not the title.
3. **Topic**: always set `topic`: a topic slug, as `workspace_get` lists them (`work`, `college`, `personal` or one the user added), or `null` for Unsorted. Ask if it is not obvious.
4. **Due date**: always set `dueAt` (ISO 8601 with offset). If the task truly has no date, say so explicitly by passing `dueAt: null` (someday). Never leave `dueAt` out.
5. **`idempotencyKey`**: always pass one, stable for this intent (for example `todo-<topic>-<short-slug>-<date>`). A retry with the same key returns the same item (`created: false`) instead of a duplicate.
6. Optional: `containerId`, `priority` (0 to 4).

## Changing and finishing

- `update_todo` patches title, `dueAt`, priority, topic, container, note or status. Re-check the verb-first rule when you retitle.
- `complete_todo` is how finished work is closed. Use it instead of deleting (`done: false` reopens).
- **Time blocks, areas and travel legs are not to-dos.** They have kind `block` or `travel` and show in `list_today.scheduled[]` and `get_calendar`. They are never completed, have no status or due date, and `search_items` leaves them out unless you pass `kind`. `complete_todo` and `update_todo` refuse them.
- **Mirrored items are never edited.** Items with a `source.provider` other than `local` (Jira, ClickUp, Linear, Moodle, GitHub, Google) belong to their provider. Give the user the `openIn.url` as "Open in <provider>". To pin, hide or annotate a mirrored item locally, use `set_overlay`; that never touches the provider.

## Destructive tools

`delete_todo` (and any tool taking `confirm`) first answers with a preview, not a change. Show the user what would be deleted, get an explicit yes, and only then call again with `confirm: true`. Never set `confirm: true` on your own initiative. Prefer `complete_todo`.

## Never

- Never put tokens, passwords or keys in titles or notes.
- Never create many to-dos in one go without telling the user the list first.
