---
name: todolist-tasks
description: Use whenever the user wants to add, create, change, finish, reopen or delete a to-do or task in TodoList, to lay out a study or work week as time blocks and areas, or to set up travel time. Carries the task methodology - search before creating, verb-first titles, topic and due date, idempotencyKey, never edit mirrored items, complete instead of delete, confirm destructive calls. Uses search_items, create_todo, update_todo, complete_todo, delete_todo, set_overlay, create_time_block, edit_time_block and the travel_* tools.
---

# TodoList: the task methodology

A plugin hook enforces rules 1 to 5 below before `create_todo` runs and tells you what is missing. Follow them up front.

## Creating a to-do

1. **Search before creating.** Call `search_items` with the key words (and `topic` if known) first. If a matching open item exists, update it or tell the user; do not duplicate.
2. **Title**: verb-first and 120 characters or fewer ("Send the invoice to Dana", "Review PR 42"). Put detail in `note`, not the title.
3. **Topic**: always set `topic`: a topic slug, as `workspace_get` lists them (`work`, `college`, `personal` or one the user added), or `null` for Unsorted. Ask if it is not obvious.
4. **Due date**: always set `dueAt` (ISO 8601 with offset). If the task truly has no date, say so explicitly by passing `dueAt: null` (someday). Never leave `dueAt` out.
5. **`idempotencyKey`**: always pass one, stable for this intent (for example `todo-<topic>-<short-slug>-<date>`). A retry with the same key returns the same item (`created: false`) instead of a duplicate.
6. Optional: `containerId`, `priority` (0 to 4), and `startAt` and `endAt` (ISO 8601 with offset) when the to-do happens at a time: travel time can then anchor on it.

## Changing and finishing

- `update_todo` patches title, `dueAt`, priority, topic, container, note or status. Re-check the verb-first rule when you retitle.
- `complete_todo` is how finished work is closed. Use it instead of deleting (`done: false` reopens).
- **Time blocks, areas and travel legs are not to-dos.** They have kind `block` or `travel` and show in `list_today.scheduled[]` and `get_calendar`. They are time, not work: never call `complete_todo` on a block or a leg (it answers 409 `not_completable`), they have no status or due date, and `search_items` leaves them out unless you pass `kind`. `update_todo` refuses them and names `edit_time_block` or `travel_edit_leg`.
- **Mirrored items are never edited.** Items with a `source.provider` other than `local` (Jira, ClickUp, Linear, Moodle, GitHub, Google) belong to their provider. Give the user the `openIn.url` as "Open in <provider>". To pin, hide or annotate a mirrored item locally, use `set_overlay`; that never touches the provider.

## Destructive tools

`delete_todo` (and any tool taking `confirm`) first answers with a preview, not a change. Show the user what would be deleted, get an explicit yes, and only then call again with `confirm: true`. Never set `confirm: true` on your own initiative. Prefer `complete_todo`.

## Never

- Never put tokens, passwords or keys in titles or notes.
- Never create many to-dos in one go without telling the user the list first.

## Laying out a study or work week (time blocks and areas)

A **time block** reserves time ("Study: Math, Sundays 13:00-17:00"); an **area** (`layer: "area"`) paints time for a part of life ("Studying", "Work 9-17"). Both are made with `create_time_block`, and one call makes a whole repeating series.

1. **Ask first**, then show the plan as a list and get a yes before creating anything: which areas, which subjects, which days and hours. Never create blocks in bulk unannounced.
2. **Areas first, blocks inside.** Create each frame as an area (`layer: "area"`, a `title`, `startAt` and `endAt` of its first occurrence, `recurrence` as one `RRULE:` line, for example `RRULE:FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH`). Then create the blocks that sit inside it with the default `layer: "block"`.
3. A block takes `subject` (a lesson such as Math or History; a new one is added to the workspace), `topic` (a slug, or `null`), an optional `note`, and its first occurrence: `startAt`, `endAt` (1 minute to 24 hours). Give a stable `idempotencyKey` for each (for example `block-math-sun-<date>`), so a retry makes no second one.
4. Change one with `edit_time_block`: `scope: "this"` with `originalStart` moves or skips one occurrence (`skip: true`), `scope: "all"` changes the series. Delete one with `delete_todo` (preview, then `confirm: true`). Read the week back with `get_calendar`: blocks are busy time, areas are not.
5. An area takes travel like a block ("Studying" at the campus: mark it with `travel_mark_item`, or let a rule match it). Inside a marked area, a block with a place of its own gets its own legs there and back into the area (or straight on when there's no time to go back); a marked area lends its place to a block with none, so that block adds no trips of its own (`travel_mark_item` answers `within`: the area and the place). Blocks are time, not to-dos: never `complete_todo` on one.

## Setting up travel time

TodoList adds travel legs ("Bus to Braude") between the places the member's day happens in, from rules they set. Legs belong to the key's own member, and agents see place names only: an address is accepted but never returned. Nothing is looked up: the member says how long each trip takes.

1. **Home first.** `travel_set_place` with `home: true` and a `name`; an `address` is optional free text that only opens Waze or Google Maps on the member's device (ask for it, never guess one). Without Home there are no legs (marking answers `travel_home_missing`). Add other places (campus, the gym) with `aliases`: an event's location finds a place by its name or an alias only.
2. **Then rules.** `travel_set_rule` says which items to travel to and how: `where` (a rule group, for example a calendar), `seriesItemId` (every occurrence of a repeating item) or `itemId`, with `mode` (`walk`, `drive`, `transit`), `direction` (`there`, `back`, `both`) and an optional `place`. For one item, `travel_mark_item` is the shortcut.
3. **Set the minutes once; every repeat uses them.** A trip is (from place, to place, mode), and each direction is its own trip; the way back starts with the same length when it has none yet (change it on its own if it differs). Pass `minutes` on `travel_mark_item`, or on `travel_edit_leg` for any leg of the trip: every leg of that trip takes it, every day and every occurrence, but legs whose times were set by hand. If `travel_mark_item` answers `lengthStored: false`, the item's own place isn't known yet and nothing was stored: mark it again with `place`. Until then a leg has `lengthUnset: true` and a 30-minute placeholder: ask the member how long the trip takes rather than guessing.
4. Check the result with `get_calendar` (legs are kind `travel`, busy time) and `travel_list_rules`. `travel_get_settings` and `travel_set_settings` hold the going-home window and the default mode per member (no factors or buffers).
5. A leg is not a to-do. Never `complete_todo` or `delete_todo` it: `travel_skip_leg` leaves it out for its day, `travel_edit_leg` with `startAt`/`endAt` moves that one leg (kept until `travel_reset_leg`), and with `minutes` sets how long the trip takes every time.
6. `travel_remove_place` and `travel_remove_rule` preview first; repeat with `confirm: true` only after the user says yes.
