# Topic colours: design

Status: draft for Shalev's review (2026-11-17). Nothing is built until he approves this document.

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

   Deadline markers use the Work shade.

   **What decides the role** (my call, pending one answer below):
   - **Scheduled:** an event that comes from a provider's calendar (`kind = event`, not a local item).
   - **Work:** everything else, including TodoList's own to-dos that have a start and end (his study blocks).
   - **Travel:** `kind = travel`.
   - **Per-calendar override** (small, first version): "Treat this calendar as: Scheduled / Work". It covers the case where his own study time lives in a separate Google calendar.
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

## Accessibility

- The palette is checked with the dataviz validator (adjacent families and the three shades within a family), against the card surface in both themes.
- Colour is never the only cue:
  - the clock keeps its Now/Next labels and gets a small legend (topic names);
  - hatching marks travel;
  - titles and icons stay.

## Settings

Settings → Topics: a family picker per topic, with a preview of its three shades. There are no per-item overrides in the first version.

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

- Per-item colours.
- Custom hex colours.
- Colour by provider as an option.
- More than three roles in the first version.

## Open for Shalev

1. **Where does your own study time live?**
   - **TodoList time blocks:** they come out as Work, a different shade from lectures, with no setup.
   - **Events in Google Calendar:** on the same calendar as the lectures, they would share the lecture shade. On a separate calendar, the per-calendar "treat as Work" fixes it.

## Calls I made (for Shalev to check)

- Three roles: Scheduled, Work, Travel. Lectures are Scheduled and his own study blocks are Work.
- Unsorted is gray.
- Source becomes an icon instead of a colour.
- File under ships first, so the colours are right from day one.
