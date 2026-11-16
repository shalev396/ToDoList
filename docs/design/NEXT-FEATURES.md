# NEXT-FEATURES: design proposals for Shalev's review (TODO.md D2–D7, E5, F1–F7)

These change the product's shape, so each section gives a recommendation and the **decisions I need from you**. Nothing here is built yet, except D6's first slice, which is in progress (N4).

---

## D2. Dynamic topics (pages you can add, rename, remove)

**Today.** `Area` is a fixed enum (`work | college | personal`). It is used by items, area rules, member `areaScope`, the builder field `area`, MCP filters and the sidebar.

**Proposal.** Replace it with a `Topics` collection per workspace:
`{_id, workspaceId, name, slug, icon?, colour?, order, createdBy}`.

- `item.area` becomes `item.topicId`. Area rules map a glob to a `topicId`.
- `membership.areaScope` becomes `topicScope: topicId[] | null`.
- The builder field `area` becomes `topic`, with values from the facets. MCP `area` filters accept topic slugs.
- **Migration:** every existing workspace gets three topics from today's areas. Their ids and slugs are stable, so URLs (`/t/work`) keep working.
- **Sidebar:** "+ Add page" asks for a name and an optional template, then creates the topic and its first view. Rename and delete happen inline. Deleting a topic moves its items to "Unsorted"; nothing is lost.
- **Effort:** large, because it touches the data model, rules, builder, MCP and client. Needs one migration, with tests.

**Decide.**

- (a) Are topic names free text, with an optional icon and colour?
- (b) Does deleting a topic keep its items under "Unsorted"? (recommended)
- (c) Can a member be scoped to several topics? (yes today)

## D3. Views per page (tabs)

**Research summary:**

- Jira: Summary, Board, List, Timeline, Calendar.
- ClickUp: List, Board, Calendar, Gantt, Timeline, Table, Workload.
- Linear: List, Board, project Timeline.
- Notion: Table, Board, Timeline, Calendar, List, Gallery, Chart.

**Proposal.** Each topic page has `views[]`:
`{id, type, name, config}`, rendered as tabs.

- **v1 types:**
  - **Summary:** today's dashboard grid, the default view.
  - **List:** every item, with saved filters, sort and group. Inline "Open in". Bulk complete for local to-dos.
  - **Board:** columns by status, priority, provider or topic. Drag is allowed only for local items.
  - **Timeline:** time runs left to right (day / week / month) and items run top to bottom, drawn as bars from `startAt` to `endAt`, or as a due marker. Today's line is marked. "What takes my day" comes from calendar events stacked per row.
- **v2:** Calendar (full page), **Workload** (hours per day from events and estimates), **Agenda** (a phone-first "now / next / today").
- Every view uses the **same query model** as blocks (D5), so one language rules everything.
- **Optional global controls (D4):** a page-level filter bar (topic, provider, range) that every view and block on the page listens to. It reuses the existing `$page.*` variables.

**Decide.**

- (a) Are the v1 view types right?
- (b) Should the Timeline's default range be week?
- (c) Should each user be able to pick their own default landing view per page?

## D5. The logic language ("our own language", Mixpanel-style)

**One pipeline for blocks and views:**
**Sources → Filter → Transform → Display**.

- **Sources:** connectors (D6). One or more integrations, plus local to-dos. Every provider is already normalized into `Items`, so mixing ClickUp + Jira needs no join. It's one collection with a `source.integrationId in [...]` match.
- **Filter:** typed conditions joined in AND/OR groups. The operator set follows the field type:

| Type   | Fields                                           | Operators                                                                                     |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| enum   | status, kind, provider, priority, topic          | is / is not / any of / none of                                                                |
| text   | title, labels                                    | contains / starts with / is empty                                                             |
| date   | due, start, end, updated, closed                 | relative presets (today, next 7 days, overdue, this semester), before/after, within, is empty |
| number | estimate, story points                           | = ≠ < ≤ > ≥ / between                                                                         |
| user   | assignee                                         | is me / is / is empty                                                                         |
| bool   | pinned, mirrored                                 | is true / false                                                                               |
| custom | provider props (e.g. Jira sprint, Moodle course) | operators by the inferred type                                                                |

Types are inferred from the facets per workspace and shown with a provider badge.

- **Transform:** sort (multi-key, with meaningful orders for status and priority), group by, limit, plus a **computed "Importance"** score (see below).
- **Display:** the block or view type, with if/then rules (highlight, badge, hide, already built), and the block title renamed inline (e.g. "Emergencies").
- **MongoDB:** compiles to one aggregation, as today: `$match` (base filter first, always), then optional `$addFields` for computed fields, then `$sort`, `$group` and `$limit`. Caps stay (≤10 rules, ≤3 groups). Indexes cover `{workspaceId, dueAt}`, `{workspaceId, status}` and `source.integrationId`.
- **"Importance" (proposed):**

  `score = w_priority·priority + w_due·dueProximity + w_pinned·pinned`
  - Default weights are editable per workspace.
  - `dueProximity` grows as the due date nears, and becomes 0 once the item is overdue by more than N days.
  - This lets "Deadlines → only important" be one condition: Importance ≥ 7.

- **UI:** the editor's Filter step becomes a sentence-like builder, e.g. "Show **tasks** from **ClickUp, Jira** where **status** is not **done** and **due** is **next 7 days**, sorted by **importance**". There is also an "Advanced" toggle to the current rule tree.

**Decide.**

- (a) Is the Importance formula OK, and should weights be editable per workspace?
- (b) Is the sentence-style editor as the default OK?
- (c) Should custom provider fields be shown with a provider badge? (recommended)

## D6. Per-block connectors (first slice running now: N4)

Each block's Source step picks connectors (integrations, many-to-one aware), plus local to-dos. The block then shows exactly that data after Done. Later this extends to views (D3) and to "Sources" in the sentence editor (D5).

## D7. Templates

- **Persona templates:**
  - Light student (courses + deadlines + calendar);
  - Student + job;
  - Two jobs + studies + side project;
  - Freelancer (clients as topics).
- **Page templates per view type:** List (my open work), Board (by status), Timeline (this week), Summary (clock + deadlines + donut).
- **Gallery:** live previews made from demo data. "Use template" creates the topic plus its views, with the connectors pre-chosen when matching integrations exist.

**Decide.** Which personas matter most first?

## E5. A new palette

**Plan.**

1. Find your site through your GitHub profile.
2. Open it headless (GPU off) and capture each project's palette.
3. List the colour families you've already used. Known so far:
   - green/black with purple/blue;
   - World Flow purple → blue;
   - red alerts.
4. Propose **three** distinct, professional palettes, each validated for AA contrast and colourblind safety with the dataviz validator. Provider colours stay distinguishable.
5. You pick one, and I apply it through the design tokens, which is one file plus checks.

**Decide.** Pick one of the three when they're ready (next step after the builder and plugin).

## F. Landing page rework (F1–F7)

1. **Live hero.** Every ~30 s, a scripted event from a bank of about 40 happens: "Moodle: Quiz 2 added", "Jira: ADS-12 done", "Calendar: Gym moved". The clock arcs and deadline rows animate the change. Reduced-motion users get a static frame.
2. **Flow section** (like Trello and ClickUp marketing). A horizontal strip of three live mini-scenes: connect (provider chips snapping in), build (a block assembling), share (an invite card landing). Captions are short, with no numbered arrows.
3. **"Built for everyone".** A toggle between two real-looking dashboards, "Light week (student)" and "Packed week (two jobs + studies + project)", with the same components and different data.
4. Keep "Your day as a clock, your week as a calendar".
5. **"Logic at every turn".** A scripted cursor walkthrough on a real block: focus → Edit → Logic → "Only important" → the list re-sorts.
6. **One rotating showcase** replaces the 4-block grid. Same carousel logic, but one large stage with a caption rail.
7. **FAQ:** add "Is it open source?", answered "Yes", with a repo link placeholder.

**Pricing:** one **Individual** plan, free with no limits, plus "Business or school? Contact us" (`mailto:` from one config value that the privacy page also uses).

**Order.** After the palette, so the new sections are built once in the final colours.
