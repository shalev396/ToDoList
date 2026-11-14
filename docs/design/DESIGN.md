# TodoList design system

Status: v1, 2026-11-11. Owner: the build. Covers the landing page, auth, onboarding, the app shell, blocks, settings and email.

## Brief

- **Subject:** one calm place where a student who also works sees today, this week and every deadline. It pulls from Moodle, Jira/ClickUp, Linear, GitHub and Google Calendar.
- **Audience:** classmates and friends. Hebrew and English, phone and laptop, often used between classes.
- **Landing page's one job:** show the real dashboard, then get someone to create an organization and connect a first source.

**References** are captured in `design/research/` (local only). We take their patterns and quality bar, not their assets:

- **Linear:** shell, sidebar, ⌘K, restraint, dark polish.
- **Todoist:** task rows, quick add, friendly empty states.
- **Trello:** boards and cards.

## Signature

The **24-hour ring**. Today's events sit around a clock face in their source colours, and an ink needle marks _now_.

- It is the logo mark, the landing hero (live and ticking), and the dashboard's clock block.
- Everything else stays quiet so this one element is what people remember.

## Colour

**Palette: Saffron & Sand** (TODO E5, applied in H10; the three options are in [PALETTE-OPTIONS.md](./PALETTE-OPTIONS.md)). Warm paper neutrals, like a well-used planner. The brand hue, deep ochre and saffron, appears only on chrome:

- primary actions (buttons, the CTA pill, links);
- the accent wash: what is selected or what just changed, like a highlighter on paper;
- focus rings.

Everything else in colour is **data**:

- source identity (small dots, ring arcs, donut segments);
- status (overdue, done).

| Token                                    | Light                | Dark                    | Role                                          |
| ---------------------------------------- | -------------------- | ----------------------- | --------------------------------------------- |
| `--background` (page plane, `--sidebar`) | `#F7F4EE`            | `#16130E`               | app canvas                                    |
| `--card`, `--popover` (surface)          | `#FFFDF9`            | `#1E1A14`               | blocks, panels, menus                         |
| `--sunken` (`--secondary`, `--muted`)    | `#EFEAE0`            | `#27221A`               | inputs, wells, hover wash                     |
| `--foreground` (ink)                     | `#1F1A12`            | `#F3EDE0`               | text, the now-needle, today                   |
| `--muted-foreground`                     | `#675F50`            | `#B0A691`               | secondary text                                |
| `--primary` (`--sidebar-primary`)        | `#7A4F00`            | `#F0B53C`               | primary buttons, the CTA pill, links          |
| `--primary-foreground`                   | `#FFFDF9`            | `#1B1405`               | text on primary                               |
| `--accent`                               | `#F2C14E`            | `#5A4513`               | selected / just-changed wash (ink text on it) |
| `--border`                               | `rgba(31,26,18,.14)` | `rgba(243,237,224,.14)` | 1px hairlines, the only separators            |
| `--input`                                | `rgba(31,26,18,.20)` | `rgba(243,237,224,.20)` | form field borders                            |
| `--ring`                                 | `#9A5B00`            | `#F0B53C`               | keyboard focus only                           |
| `--destructive`                          | `#B42A2A`            | `#EF7070`               | errors and destructive actions                |
| `--destructive-foreground`               | `#FFFFFF`            | `#14161A`               | text on a destructive fill                    |

- **Hairlines** stay a low-alpha overlay of the ink. 14% matches the contrast of the palette's solid border (`#DDD5C4` on the light page, 1.33:1; `#3A3326` on the dark page, 1.48:1).
- **Not in the palette sheet, set to match it:** `--sidebar-accent` (`#EBE5DA` / `#27221A`), the dialog scrim `--overlay` (`#16130E`, at 40%) and the overlay shadow (see "Depth").
- **Browser chrome:** `theme-color` (index.html, ThemeProvider), the manifest and the Home Screen icons use the page plane: `#F7F4EE` light, `#16130E` dark. The logo tile is drawn in each theme's ink.

**Contrast**, measured on these tokens (WCAG 2.x; text needs 4.5:1, focus and other non-text marks 3:1):

| Pair                                                                 | Light                 | Dark                  |
| -------------------------------------------------------------------- | --------------------- | --------------------- |
| Ink on the page / a card / `--sunken`                                | 15.75 / 17.02 / 14.42 | 15.88 / 14.84 / 13.53 |
| Muted text on the page / a card / `--sunken`                         | 5.75 / 6.21 / 5.26    | 7.68 / 7.18 / 6.55    |
| Primary (links, text buttons) on the page / a card                   | 6.49 / 7.02           | 10.04 / 9.38          |
| `--primary-foreground` on primary / on the hover fill (85%)          | 7.02 / 5.01           | 9.91 / 7.41           |
| Ink on the full accent wash                                          | 10.30                 | 7.84                  |
| Muted text on the full accent wash                                   | 3.76 (fails)          | 3.79 (fails)          |
| Muted text on the accent at 45% over a card                          | 4.96                  | 5.57                  |
| Destructive text on the page / a card / `--sunken`                   | 5.79 / 6.25 / 5.30    | 6.37 / 5.95 / 5.43    |
| Destructive text in the error well (`bg-destructive/5`), card / page | 5.78 / 5.36           | 5.58 / 6.01           |
| `--destructive-foreground` on the fill / on the 90% hover            | 6.35 / 5.37           | 6.23 / 5.29           |
| Focus ring on the page / a card / `--sunken` (non-text)              | 4.94 / 5.34 / 4.53    | 10.04 / 9.38 / 8.56   |
| A 50% ring halo on the page (non-text)                               | 2.06 (fails)          | 3.37                  |

Rules that follow from the measurements:

- **Accent wash:** only ink text goes on the full wash. A row that also has muted text (a deadline's course, a time) gets the accent at 45% or less over the card.
- **Focus:** a solid 2px `--ring`. Buttons and CTAs add a 2px offset in the page colour; scroll regions draw it inset, inside their clipping box. A 50% halo fails 3:1 on the light page, so the button, accordion and scroll-area primitives use the solid ring. Inputs and selects keep their halo, and their border turns `--ring` on focus, which carries the 3:1 (4.94 on the page, 5.34 on a card).

**Source colours** come from the dataviz reference palette. Saffron & Sand leaves them unchanged; they were validated again on its surfaces with `validate_palette.js` (dataviz skill), on the page plane and on the card:

| Run                        | Lightness | Chroma | CVD, adjacent pairs            | Normal vision | Contrast vs 3:1                                            |
| -------------------------- | --------- | ------ | ------------------------------ | ------------- | ---------------------------------------------------------- |
| Light, on `#F7F4EE` (page) | PASS      | PASS   | PASS: worst ΔE 9.1, tritan 5.8 | PASS: 19.6    | WARN: Moodle 2.92, Calendar 2.56, Drive 1.97, ClickUp 2.45 |
| Light, on `#FFFDF9` (card) | PASS      | PASS   | PASS: worst ΔE 9.1, tritan 5.8 | PASS: 19.6    | WARN: Calendar 2.77, Drive 2.13, ClickUp 2.65              |
| Dark, on `#16130E` (page)  | PASS      | PASS   | PASS: worst ΔE 8.4, tritan 8.7 | PASS: 19.3    | PASS: all 7 at 3:1 or more                                 |
| Dark, on `#1E1A14` (card)  | PASS      | PASS   | PASS: worst ΔE 8.4, tritan 8.7 | PASS: 19.3    | PASS: all 7 at 3:1 or more                                 |

Nothing fails. The light WARN is the one these colours always had: every source mark ships with its name (legend chips, the "Moodle / Data structures" line) and the charts have a data table. Drive's amber (slot 4) sits near the ochre brand hue; the brand hue is only on chrome, and Drive marks always carry a label.

| Slot | Source                    | Light                | Dark                 |
| ---- | ------------------------- | -------------------- | -------------------- |
| 1    | Jira                      | `#2a78d6`            | `#3987e5`            |
| 2    | Moodle                    | `#eb6834`            | `#d95926`            |
| 3    | Google Calendar           | `#1baf7a`            | `#199e70`            |
| 4    | Google Drive (Notability) | `#eda100`            | `#c98500`            |
| 5    | ClickUp                   | `#e87ba4`            | `#d55181`            |
| 6    | GitHub                    | `#008300`            | `#008300`            |
| 7    | Linear                    | `#6250d6`            | `#9085e9`            |
| —    | Local to-dos              | `--muted-foreground` | `--muted-foreground` |

Rules:

- Colour follows the source, never its rank.
- Segments are always drawn in slot order.
- Slot 8 (red) is unused, so it never collides with "overdue".

**Status** (reserved, always shown with an icon and a label):

| Status             | Hex       |
| ------------------ | --------- |
| good               | `#0ca30c` |
| warning            | `#fab219` |
| serious            | `#ec835a` |
| critical (overdue) | `#d03b3b` |

## Type

- **Typeface:** IBM Plex Sans Variable (Latin) with IBM Plex Sans Hebrew. One family across both scripts, both OFL, self-hosted via `@fontsource`. Plex's engineered, slightly squared forms fit a precise time tool and keep us off the default Inter.
- **App scale (px):** 12 / 13 / 14 (base) / 16 / 20 / 24 / 30.
- **Marketing scale (px):** 16 / 18 / 21 / 30 / 44 / 64.
- **Headings:** weight 600 at -0.02em tracking, line-height 1.05–1.15.
- **Body:** weight 400, line-height 1.5, line length ≤ 72ch.
- **Times, dates and counts in rows and tables** use `tabular-nums`. Hero figures stay proportional.
- **Avoid:** all-caps labels, eyebrows, and a single highlighted word in a headline.

## Shape, depth, motion

- **Radii:** 6px (controls), 10px (blocks and panels), 999px (chips and the primary CTA pill).
- **Depth:** hairlines separate surfaces; no shadows on blocks. Overlays (popover, dialog, sheet) get one soft shadow: `0 12px 32px rgba(31,26,18,.14)` light, `rgba(0,0,0,.5)` dark.
- **Motion:** only for response (open, expand, confirm), 120–200ms ease-out. The single orchestrated moment is the hero ring drawing in on first load. `prefers-reduced-motion` turns it off.

## Layout

**App shell:**

```
┌──────────────┬──────────────────────────────────────────────┐
│ ◐ Org ▾      │ Page title                [Week|Month] [Edit]│
│ Search ⌘K    ├──────────────────────────────────────────────┤
│ Dashboard    │ ┌ clock ┐ ┌ donut ┐ ┌──── week calendar ────┐ │
│ Work         │ └───────┘ └───────┘ └───────────────────────┘ │
│ College      │ ┌──── deadlines (soonest first) ────────────┐ │
│ Personal     │ └───────────────────────────────────────────┘ │
│ + New page   │                                              │
│ ──────────── │                                              │
│ Integrations │                                              │
│ Settings     │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

- The sidebar is 240px and collapses to a 56px rail.
- On phones it becomes a bottom tab bar (Dashboard, up to 3 pinned topics, More).
- Content uses a 12-column grid with a 16px gutter.
- Rows: 36px on desktop, 44px touch targets.

**Landing hero** (text left, live ring right on desktop; stacked and centred on phones):

```
 TodoList                                   Log in   [Sign up]
 ─────────────────────────────────────────────────────────────
 Your whole week,                      ◜  ring of today  ◝
 one clock.                            ◟  now-needle ticks ◞
 [one paragraph]                       next: Algorithms 14:00
 [Create your organization]            ▸ 3 deadlines this week
```

- Section rhythm: 128px on desktop, 72px on phones.
- Order: hero → sources strip → "how it works" (connect → build → share, a real sequence, so numbering is honest) → features (built on product screenshots, not icon grids) → pricing (Free) → FAQ → footer ("Built on Elytra").

## Principles

1. **Time is the hero.** The ring and needle are the brand. "Now" and "today" are marked in ink, never by an extra colour.
2. **Colour is data.** Neutrals and hairlines everywhere else. Every coloured mark in the content answers "which source?" or "what state?". The brand hue stays on chrome: actions, the selected or just-changed wash, focus.
3. **Every row is a door.** "Open in <provider>" is one click from any item.
4. **Bilingual by construction.** Logical properties only, Hebrew glyph coverage, mirrored grid, unmirrored clock.
5. **Dense, not cramped.** Linear-level density in lists, generous air around page titles.

## Self-review against generic defaults

- _Cream and terracotta / black and acid green:_ the warm paper base is Shalev's pick (Saffron & Sand), and it stays off the generic cream look on purpose: no serif display (Plex Sans throughout), a deep ochre and a saffron highlighter instead of terracotta, and colour in the content still means data only.
- _SaaS card kit_ (identical shadowed cards, gradient washes): blocks use hairlines without shadows, block chrome varies by type, and there are no gradients. Elytra's purple-blue gradients are removed.
- _Inter by default:_ changed to IBM Plex Sans + Plex Sans Hebrew, which is also required for Hebrew coverage.
- _Big-number hero with gradient accent:_ replaced by a live product ring, the thing only this product has.
- _Eyebrows, arrow CTAs, mono micro-labels:_ banned in copy and components.
- _Kept on purpose:_ the `in 2 days · Fri 13 Nov` date format comes from FRONTEND.md §9, and the spec wins.
