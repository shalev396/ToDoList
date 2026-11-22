---
name: todolist-daily
description: Use when the user asks what is on today, what is due or overdue, what is coming up this week, what their calendar or deadlines look like, or wants a daily or weekly briefing from TodoList. Read-only; uses list_today, list_deadlines, get_calendar and get_item.
---

# TodoList: the daily view (read only)

Answer "what is on my plate" from TodoList's read tools. Never write anything in this skill.

## Tools

- `list_today`: today's events, items due today, overdue items, and `scheduled[]` (in the workspace time zone). Start here for "today".
  - `scheduled[]` is the time TodoList keeps today: time blocks (study or focus time), areas (`layer: "area"`, time painted for a part of life, such as "Studying 13:00-17:00") and travel legs. Each repeating block appears once per occurrence.
  - Blocks and legs are not tasks: they are never due, overdue or completed. Do not list them as to-dos or offer to tick them off.
  - `busy: true` marks time that is taken (time blocks, travel, events). An area has `busy: false`: it is a plan, so suggest putting blocks inside it.
  - A to-do also created in Google Calendar is listed once: when it is due today or overdue, its event is left out of `events`.
- `list_deadlines`: upcoming due dates, grouped by topic, container (project or course) and provider. Use it for "what is coming up".
- `get_calendar`: events, dated items, time blocks, areas and travel for a week, a month or a custom range. Each occurrence of a repeating event or block is its own entry, with `occurrence` (`seriesId`, `originalStart`) and `busy`.
- `get_item`: one item in full, with its source and `openIn` link.
- Travel legs (kind `travel`, such as "Bus to Braude") are the member's own and show in `scheduled[]` and `get_calendar` as busy time. Mention a leg next to the event it serves ("leave 08:10 for the 09:00 lecture"); a leg with `props.travel.conflict` cannot be made in time, say so. Never offer to complete one. To set travel up or change a leg, use the `todolist-tasks` skill.
- `search_items` and `list_facets`: for "find my X" and to learn the topics, providers and containers that exist.

All of them accept a `topic` filter where it makes sense: the slugs of the workspace's topics (its pages), as `workspace_get` lists them (for example `work`, `college`, `personal`, or one the user added).

## How to present it

1. Respect topics. If the user named one ("my work day"), filter by it. Otherwise group the answer by topic so work and personal never blur together.
2. Order: overdue first (say how late), then events and scheduled time in time order, then due today. Name an area as the frame ("Studying 13:00-17:00") with the blocks inside it under it.
3. Every item that comes from a provider (Jira, ClickUp, Linear, Moodle, GitHub or Google Calendar) gets its link: write `Open in <provider>` as a Markdown link to `openIn.url`. Local to-dos have no link; say they live in TodoList.
4. Keep it short: title, topic, due time, link. Offer details only on request.
5. Times: show them in the workspace time zone that `list_today` returns, not UTC.
6. Empty results are an answer: say "nothing due today" instead of inventing items.

## Do not

- Do not edit mirrored items; they are changed in their provider (use the `openIn` link).
- Do not call sync tools just to read; if data looks stale, suggest the `todolist-sync` skill.
