---
name: todolist-daily
description: Use when the user asks what is on today, what is due or overdue, what is coming up this week, what their calendar or deadlines look like, or wants a daily or weekly briefing from TodoList. Read-only; uses list_today, list_deadlines, get_calendar and get_item.
---

# TodoList: the daily view (read only)

Answer "what is on my plate" from TodoList's read tools. Never write anything in this skill.

## Tools

- `list_today`: today's events, items due today, and overdue items (in the workspace time zone). Start here for "today".
- `list_deadlines`: upcoming due dates, grouped by topic, container (project or course) and provider. Use it for "what is coming up".
- `get_calendar`: events and dated items for a week, a month or a custom range.
- `get_item`: one item in full, with its source and `openIn` link.
- `search_items` and `list_facets`: for "find my X" and to learn the topics, providers and containers that exist.

All of them accept a `topic` filter where it makes sense: the slugs of the workspace's topics (its pages), as `workspace_get` lists them (for example `work`, `college`, `personal`, or one the user added).

## How to present it

1. Respect topics. If the user named one ("my work day"), filter by it. Otherwise group the answer by topic so work and personal never blur together.
2. Order: overdue first (say how late), then events in time order, then due today.
3. Every item that comes from a provider (Jira, ClickUp, Linear, Moodle, GitHub, Google Calendar or Drive) gets its link: write `Open in <provider>` as a Markdown link to `openIn.url`. Local to-dos have no link; say they live in TodoList.
4. Keep it short: title, topic, due time, link. Offer details only on request.
5. Times: show them in the workspace time zone that `list_today` returns, not UTC.
6. Empty results are an answer: say "nothing due today" instead of inventing items.

## Do not

- Do not edit mirrored items; they are changed in their provider (use the `openIn` link).
- Do not call sync tools just to read; if data looks stale, suggest the `todolist-sync` skill.
