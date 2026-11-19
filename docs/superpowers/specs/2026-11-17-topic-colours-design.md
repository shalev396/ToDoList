# Topic colours: design

Status: approved by Shalev (2026-11-17). The sections marked _Added 2026-11-17_ come from his follow-up the same day (each lesson its own colour, painted areas).

## Why

On the clock, Shalev wants to see at a glance which part of his life each block belongs to, and where one thing ends and the next starts within the same part. His example: "studying 1–5, where 1–3 is a lecture and 3–5 homework". Both should read as Studies, and the two parts should still be told apart. Today the clock and the other time views colour blocks by **source** (Jira, Google…), which answers a question he doesn't ask.

## What it is (his decisions)

- **Every topic gets a colour family.** Studies is one family (e.g. all the greens), Work another, Personal another.
- **Shades vary by meaning, not per item.**
  - Lectures (there are many) all share one shade.
  - Studying on his own gets a different shade of the same family.
- **One format everywhere:** every dashboard and every view follows the same rule.

## The rule

1. **Family = the item's topic.**
   - Topics already have a colour setting with nine families: gray, red, orange, amber, green, teal, blue, violet, pink.
   - A topic without one gets the next unused family in sidebar order.
     - That family is **saved on the topic** when first assigned, so colours never shift when topics are added or reordered.
     - A tenth topic reuses the families in order, skipping gray.
   - Items with no topic (Unsorted) use neutral gray.
2. **Shade = the item's role.** Three roles (my call):

   | Role          | Covers                                                                                        | Look                                                               |
   | ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
   | **Scheduled** | calendar events: lectures, meetings                                                           | the family's base step, solid                                      |
   | **Work**      | to-dos, issues, tasks, assignments, and time blocks he creates himself ("studying on my own") | a clearly different step of the family, solid                      |
   | **Travel**    | travel blocks (travel time design)                                                            | a muted step with diagonal hatching, so it reads as time, not work |

   | **Area** _(added)_ | painted time for a part of life ("Work 9–17", "Studying"), see the time-blocks design | the family's lightest tint, drawn behind everything else, with its label |

   Deadline markers use the Work shade.

   **What decides the role** (by class, see the time-blocks design):
   - **Scheduled:** a `CalendarEvent` from a provider (lectures, meetings).
   - **Work:** a `TimeBlock` (his own study time, which lives in TodoList, repeating or not) or a markable `Todo`.
   - **Travel:** a `TravelLeg`.
   - Charts and other topic-level totals use the Scheduled (base) shade.

3. **Same everywhere.**
   - One shared client module decides the colour; no block picks its own.
   - It applies to:
     - the clock ring;
     - the calendar, timeline and agenda;
     - list rows (a dot);
     - kanban cards (an edge);
     - charts grouped by topic.
   - The source (Jira, Google…) stays visible as its small icon, but no longer drives the colour.
4. **Light and dark** each get their own validated steps. They are not an automatic flip.
5. **The colour values are designed during the build.**
   - That is nine families × three roles × two themes, starting from the app's existing palette tokens and checked with the dataviz validator.
   - Topic chips that already show a colour may shift slightly to match.

## Subjects: each lesson its own colour (_Added 2026-11-17_)

Shalev: "give … the lesson name a different color". All his lectures are one topic (Studies), but he wants Calculus, Algebra, Digital Systems… told apart.

- **A subject overrides the topic's family.** The family comes from, in order:
  1. the item's **subject**, when it has one;
  2. its topic;
  3. gray (Unsorted).

  The shade still comes from the role, so a Calculus lecture (Scheduled) and his own Calculus study block (Work) share the Calculus family in two shades.

- **Subjects are the workspace "Subject" attribute** (time-blocks design): a `select` attribute whose options each carry:
  - a **colour family** (the same nine as topics; a new subject gets the next family not used by a topic or another subject, saved when assigned);
  - optional **title patterns**: case-insensitive globs over the item's title, e.g. `*חדו"א*`, `*Calculus*`.
- **How an item gets its subject:**
  1. its own Subject value (set by hand or by an agent; time blocks carry one) wins;
  2. otherwise the first subject, in option order, whose pattern matches the title.

  Patterns are needed because his lectures come from the college's imported calendar as one separate event per week (no series), and new weeks keep arriving. No event is edited; the match is computed when items are read, by one shared pure function (`server/src/types/`, used by the client's colour module and by the server where it reports a subject).

- **Settings → Subjects:** add, rename, reorder, pick the family, edit patterns, with a live count of matching items.
- **MCP:** a tool to add or update a subject (name, family, patterns), so an agent can set his lessons up. Scope `items:write`, editor or owner.
- Filtering and grouping by subject in queries use the stored value only in the first version. Pattern matches colour items but are not stored on them.

## Accessibility

- The palette is checked with the dataviz validator (adjacent families and the three shades within a family), against the card surface in both themes.
- Colour is never the only cue:
  - the clock keeps its Now/Next labels and gets a small legend (topic names);
  - hatching marks travel;
  - titles and icons stay.

## Settings

Settings → Topics: a family picker per topic, with a preview of its shades. There are no per-item overrides in the first version. Settings → Subjects: see above.

**MCP (_added_):** agents can set a topic's family, a connection's File under, and a per-calendar or per-project File under (which writes the name rule). Scope `workspace:share`, owner only, like the same settings in the app.

## Depends on: items having the right topic ("File under")

Colour by topic is only as good as the topics. Today:

- all his calendars, including Braude and the TLVTech work calendar, file under **Personal**;
- Jira and ClickUp are **Unsorted**.

So at first the clock would be mostly "Personal green". The fix is the **File under** setting:

- **Per connection:** in the integration's Manage panel, "File under: Work / Studies / Personal / none".
  - Everything that connection brings in goes there: Jira → Work, ClickUp → Work, the work Google account → Work.
  - The server already supports a connection's topic; only the UI is missing.
- **Per calendar or project inside a connection** (new): e.g. on the personal Google account, the "braude" calendar → Studies while the rest stays Personal.
- **Rules by name** (Settings → Rules) already work and can do the per-calendar part today, e.g. `*braude*` → Studies, applied on the next sync.

**How File under behaves (my calls):**

- **Per calendar or project, first version:** the Manage panel's "File this calendar under…" writes an ordinary name rule (Settings → Rules), so no new storage is needed.
- **When a change takes effect:** a topic is decided at sync time. Changing File under or a rule starts a sync of that connection, so already-synced items move then, not on some later sync.
- **Overrides win:** a topic set by hand on one item (its overlay) beats File under and rules.

Build order (my call):

1. File under (small);
2. the palette module and the clock;
3. the other views;
4. travel blocks pick up the Travel shade when the travel feature lands.

## Non-goals

- Per-item colours (a subject is the finest level).
- Custom hex colours.
- Colour by provider as an option.
- More than four roles in the first version (Scheduled, Work, Travel, Area).

## Answered by Shalev

- His own study time lives in **TodoList time blocks** (repeating or not), not in Google Calendar. They take the Work shade, distinct from lectures, with no setup. No per-calendar role override is needed in the first version.

## Calls I made (for Shalev to check)

- Three roles: Scheduled, Work, Travel. Lectures are Scheduled and his own study blocks are Work.
- Unsorted is gray.
- Source becomes an icon instead of a colour.
- File under ships first, so the colours are right from day one.
