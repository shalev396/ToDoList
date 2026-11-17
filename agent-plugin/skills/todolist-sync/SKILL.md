---
name: todolist-sync
description: Use when TodoList data looks stale or missing, when the user asks to refresh or sync Jira, ClickUp, Linear, Moodle, GitHub or Google Calendar, to check whether a sync worked, to connect or disconnect an integration, or to push items to Google Calendar. Uses sync_now, get_sync_status, integrations_list, integrations_start_connect.
---

# TodoList: syncing and connecting integrations

## When to sync

- The user asks to refresh, or an item they expect from a provider is missing or old.
- Not before every read. `list_today` and `search_items` read what is already mirrored; syncing is a background pull that can take a while.

## How

1. `integrations_list` shows which integrations exist and their status (metadata only, never a secret).
2. `sync_now` with no arguments pulls every integration the user may see; pass `integrationIds` to pull some. It returns `runIds` and anything skipped (with why).
3. `get_sync_status` with a `runId` (or `integrationId`) reads the run: status, counts and a sanitized error. Poll sparingly (every few seconds, a handful of times), then report. Do not loop forever; if still running, say so and offer to check later.
4. Report plainly: what ran, what changed, any error text as given.

## Google Calendar push

`sync_to_google_calendar` defaults to `dryRun: true` and returns the create/update/skip diff. Show the diff and only run it for real (`dryRun: false`) after the user agrees.

## Connecting

- **Never ask the user for a token, password or API key, and never accept one in chat.** There is no tool to set one, by design.
- To connect a provider, call `integrations_start_connect` with the `provider`; give the user the returned `connectUrl` to open in their browser (single use, expires in 10 minutes). They finish the sign-in there. Then `integrations_list` to confirm.
- Connecting and disconnecting need an owner. If refused, say who can do it.
- `integrations_disconnect` wipes a credential: explain the effect, get an explicit yes, then call with `confirm: true`.

## Never

- Never print, store or echo a credential or an agent key.
- Never edit a mirrored item to "fix" sync; the provider owns it (use its `openIn` link).
