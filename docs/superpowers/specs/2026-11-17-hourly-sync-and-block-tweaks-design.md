# Hourly sync and two block tweaks: design

Status: requested by Shalev (2026-11-17), to ship in the same release as the topic colours, time blocks and travel designs.

## 1. Calendar block: the hour it opens at

**His words:** "add a variable … when the scroll is going to start. Like if it's going to start at exactly twelve … midnight, or if it's going to start on eight and I can go up and down."

- New calendar viz option **`startHour`**: an integer 0–23. Unset means 7, today's behaviour (`scrollTime="07:00:00"`).
- When the week view opens, its scroll region is scrolled so that hour's row is at the top. He can still scroll up and down freely. Changing the week or view keeps the same hour.
- Today the grid is `height="auto"` inside the block's own scroll region, so FullCalendar's `scrollTime` has nothing to scroll. The block must scroll **its own region** to the hour's slot: measure the slot row's offset after render, not a guess in pixels.
- **Where he sets it:** the block's header gets a small "Starts at" hour select (00:00–23:00) next to the Week/Month choice. Editors save it to the block's viz, the same way Week/Month is saved today (`useSaveCalendarView`). Viewers can change it for themselves for the session only.
- The rigid Calendar view and calendar blocks on dashboards both get it. The builder schema (`VIZ_SCHEMAS.calendar`), the catalog and the MCP builder tools accept it.

## 2. Board (kanban) block: each column scrolls on its own

**His words:** "if we have way too much on one side, like … done, I don't want all of the blocks to scroll, I just want to stand on done and scroll these."

- Each column's card list scrolls inside the column. The board keeps its height; the other columns don't move.
- Desktop: the columns fill the block's height and each card list is `overflow-y: auto`.
- Phone (columns stacked): each column's list is capped (about 60% of the viewport) and scrolls inside, so a long Done column doesn't push the others off screen.
- Drag and drop keeps working: dropping on a scrolled column, and dragging near a column's edge scrolls it (dnd-kit auto-scroll).
- The column header (name, count) stays visible above its list.

## 3. Sync every hour, on the hour

**His words:** "auto sync every hour … every whole hour … it will press the sync all button basically."

- An **EventBridge schedule** at minute 0 of every hour (`cron(0 * * * ? *)`, UTC; whole hours are the same in Israel) invokes the **existing function** with `{ "action": "sync-dispatch" }`. That queues one background run per dispatchable integration, for every workspace: what "Sync all" does for one workspace (`dispatchAllSyncs`).
- **No new function** (my call): the rule targets the stack's one function, so the infra stays one function and one role. The rule gets its own invoke permission on that function. On every stage, the schedule exists; dev and qa can disable it later if their quota suffers.
- The same scheduled invoke then runs the **travel horizon pass** (travel design), at most once a day per workspace.
- The lambda header comment ("No schedule invokes them for now") and the infra tests are updated.
- **Rate limits:** dispatch already throttles per provider. Integrations waiting for the user (expired, auth failed, no credential) are skipped, as today.

## 4. GitHub as to-dos (checked, no change)

He asked to confirm GitHub issues and Projects are to-dos. They are (`server/src/sync/providers/github.ts`):

- repos;
- Projects (v2) boards, whose cards yield the full issue or PR, plus draft cards as tasks;
- issues and pull requests that involve him.

No change is needed. The hourly sync keeps them fresh.
