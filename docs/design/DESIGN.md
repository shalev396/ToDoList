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

- It is the landing hero (live and ticking) and the dashboard's clock block.
- The logo, the **square dial**, is the same clock drawn as a to-do box (see "Logo").
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
- **Browser chrome:** `theme-color` (index.html, ThemeProvider), the manifest and the Home Screen icons use the page plane: `#F7F4EE` light, `#16130E` dark. The Home Screen icons draw the logo's dark variant on the dark plane; the favicons are the logo filled with each theme's plane (see "Logo").

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

### Topic colours

Spec: `docs/superpowers/specs/2026-11-17-topic-colours-design.md`. Every item takes a **family** and a **role**, from one shared rule (`server/src/types/colours.ts`):

- **Family:** the item's subject, else its topic, else gray (Unsorted). The nine families are the topic colours: gray, red, orange, amber, green, teal, blue, violet, pink. New topics get the next one in `FAMILY_ASSIGN_ORDER` (blue, orange, teal, amber, pink, green, violet, red), saved on the topic.
- **Role:** Scheduled (a provider's calendar event), Work (to-dos, issues, his own time blocks), Travel (travel legs), Area (painted time). Charts by topic use Scheduled.

**Tokens.** `--tc-<family>-<role>` for every family and role, plus `--tc-<family>-scheduled-ink` and `--tc-<family>-work-ink` (the text colour on the two solid fills): 54 hex values in `:root` (light) and again in `.dark`. Nothing reads them directly. Every view paints through `client/src/features/colours/`:

- `palette.ts`: `colourVar`, `inkVar`, `paintOf`, `hatchBackground`, `hatchFill`, `markStyle`;
- `rowColour.ts` and `useColours.ts`: from a row to its colour;
- the components `ColourDot`, `FamilySwatch` and `HatchPatternDefs`.

`palette.test.ts` checks that every token is there, and every text contrast below.

**How each step is made.** The brief's derivation came first; the validator then decided the fixes. Every fix keeps the hue and moves only the lightness (OKLCH L), the snap-to-passing rule.

- **Scheduled:** the app's data colours (`--chart-1…7`; `--status-critical` for red, with dark lowered from `#ef7070`; `--muted-foreground` for gray). A step moves only when no ink reaches 4.5:1 on it:
  - light blue `#2a78d6` → `#2674d2` (4.35 → 4.58);
  - dark orange `#d95926` → `#db5b28` (4.46 → 4.57);
  - dark pink `#d55181` → `#d85484` (4.39 → 4.55);
  - dark green `#008300` → `#279723` (4.24 → 4.56). Moving green up rather than down also leaves room for its Work step under it in the dark band.

  So the light blue and the four dark Scheduled steps differ a little from the source colours of the same hue.

- **Work:** a deeper step of the same hue, darker than Scheduled in both themes, so it reads the same way in every family.
  - Light: L −0.16, but never below the band floor (0.435).
  - Dark: L −0.10, never below 0.485. The brief's +0.12 has no room: the dark band's ceiling (0.67) sits within 0.05 of most Scheduled steps, and the ordinal check needs 0.06 between steps.
  - Chroma is held, clamped to sRGB. Each step then moves to the nearest lightness where an ink reaches 4.5:1 (light amber 0.604 → 0.616; dark amber, teal and violet). In dark mode it must also clear 3:1 on the card where the ink allows it (dark red, orange, green and pink moved by 0.001 to 0.003).
  - Dark amber sits at L 0.509 so that it stays apart from teal's Work step for colour-blind readers: CVD 7.3 (protan, the WARN band) → 8.1 (deutan, PASS).
- **Travel:** chroma × 0.45, the step nearest the card (lighter in light mode, darker in dark). It keeps 2:1 on the card (the ordinal light-end floor) and 4.5:1 under `--foreground`, its text colour. Its 1.5px stripes every 6px, at 135°, use the family's Scheduled step.
  - Light orange (0.791 → 0.775) and teal (0.789 → 0.761) were lowered to keep 2:1.
  - Light amber and pink have no room above Scheduled: their Scheduled steps are already only 2.13:1 and 2.65:1 on the card. Their Travel sits midway between Scheduled and Work (0.690 and 0.636). The hatching, not the lightness, is what marks travel.
- **Area:** the Scheduled step mixed into the card (`#fffdf9` / `#1e1a14`) in OKLab, at 14% (light) or 24% (dark). Its text is `--foreground`. As a dot or a swatch it gets a 1px Scheduled edge, or the tint would vanish on the card.
- **Inks:** for Scheduled and Work, `--foreground` (ink) or `--card` (card), whichever contrasts more.

| Light  | Scheduled (text) | Work (text)      | Travel    | Area      |
| ------ | ---------------- | ---------------- | --------- | --------- |
| gray   | `#675f50` (card) | `#3b3426` (card) | `#86837c` | `#e8e5e0` |
| red    | `#d03b3b` (card) | `#9b0015` (card) | `#cc8882` | `#fce3dd` |
| orange | `#eb6834` (ink)  | `#ad3c00` (card) | `#e2a58f` | `#ffe9de` |
| amber  | `#eda100` (ink)  | `#b27800` (ink)  | `#b69568` | `#fdf1df` |
| green  | `#008300` (card) | `#006400` (card) | `#729c6e` | `#e0ecd9` |
| teal   | `#1baf7a` (ink)  | `#007952` (card) | `#8dbea5` | `#e5f2e7` |
| blue   | `#2674d2` (card) | `#004f9f` (card) | `#7b9bc6` | `#e1eaf5` |
| violet | `#6250d6` (card) | `#4b31b7` (card) | `#8787c3` | `#e6e6f7` |
| pink   | `#e87ba4` (ink)  | `#b14a74` (card) | `#ab7b8b` | `#feebed` |

| Dark   | Scheduled (text) | Work (text)      | Travel    | Area      |
| ------ | ---------------- | ---------------- | --------- | --------- |
| gray   | `#b0a691` (card) | `#918773` (card) | `#6f6b62` | `#3d382e` |
| red    | `#e05252` (card) | `#be3136` (ink)  | `#814744` | `#482922` |
| orange | `#db5b28` (card) | `#b63e00` (ink)  | `#7e4937` | `#472a1c` |
| amber  | `#c98500` (card) | `#8b5a00` (ink)  | `#694e29` | `#42311a` |
| green  | `#279723` (card) | `#007800` (ink)  | `#345b31` | `#27351b` |
| teal   | `#199e70` (card) | `#007a54` (ink)  | `#355f4c` | `#273728` |
| blue   | `#3987e5` (card) | `#1468c3` (ink)  | `#3b597f` | `#283341` |
| violet | `#9085e9` (card) | `#6b5dbd` (ink)  | `#59567f` | `#363241` |
| pink   | `#d85484` (card) | `#b63467` (ink)  | `#7e4758` | `#46292c` |

**Validator runs** (`validate_palette.js` from the dataviz skill), on the card of each theme:

1. Scheduled steps in `FAMILY_ASSIGN_ORDER`, with blue repeated last for the wrap.
2. Work steps, same order.
3. `--ordinal` per family on its three steps, from light to dark in light mode and from dark to light in dark mode, so each run is monotone in L. Most light families read [travel, scheduled, work]; light amber and pink read [scheduled, travel, work]; every dark family reads [travel, work, scheduled].
4. `contrast()` of each ink on its fill, and of `--foreground` on every Travel and Area fill.

Nothing fails. Two WARNs remain, both contrast relief:

- **Light Scheduled:** teal 2.77, amber 2.13 and pink 2.65 on the card. This is the same WARN the source colours always had.
- **Dark amber Work:** 2.93, the price of its CVD fix.

The relief is the one the spec requires: colour is never the only cue.

- Every block and row carries its title.
- The clock keeps its Now/Next labels and gets a topic legend (the spec's "Accessibility").
- Travel is hatched.
- The source stays as its icon (`SourceIcon`).

Rules that follow:

- A coloured fill carries text only in its own ink: `paintOf(…).ink`, never the fill colour as text.
- **Text on travel:** `--foreground` on the Travel fill is at least 4.55:1, but where a letter crosses a stripe, it sits on the Scheduled step. A view that writes on a travel block keeps the label off the stripes, for example on a small Travel-fill plate.
- **Red** (the eighth family) is the status-critical hue, as the brief chose. Status marks always carry an icon and a label ("Status" above), so an overdue mark never relies on its red.
- The views (clock, calendar, timeline, agenda, lists, kanban, charts) move from source colours to these tokens in later tasks. Until then, the source colours above still apply where a view uses them.

```text
# light — scheduled
$ node scripts/validate_palette.js "#2674d2,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#d03b3b,#2674d2" --mode light --surface #fffdf9
Palette (light, surface #fffdf9, categorical): 9 slots
  [PASS] Lightness band         all 9 inside L 0.43–0.77
  [PASS] Chroma floor           all 9 >= 0.1
  [PASS] CVD separation         worst adjacent #eda100↔#1baf7a ΔE 9.1 (protan) · tritan 5.8
  [PASS] Normal-vision floor    worst adjacent #e87ba4↔#eda100 ΔE 19.6 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#1baf7a",2.77],["#eda100",2.13],["#e87ba4",2.65]]
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
# light — work
$ node scripts/validate_palette.js "#004f9f,#ad3c00,#007952,#b27800,#b14a74,#006400,#4b31b7,#9b0015,#004f9f" --mode light --surface #fffdf9
Palette (light, surface #fffdf9, categorical): 9 slots
  [PASS] Lightness band         all 9 inside L 0.43–0.77
  [PASS] Chroma floor           all 9 >= 0.1
  [PASS] CVD separation         worst adjacent #007952↔#ad3c00 ΔE 8.4 (deutan) · tritan 6.9
  [PASS] Normal-vision floor    worst adjacent #b14a74↔#b27800 ΔE 18.2 (normal)
  [PASS] Contrast vs surface    all 9 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
# dark — scheduled
$ node scripts/validate_palette.js "#3987e5,#db5b28,#199e70,#c98500,#d85484,#279723,#9085e9,#e05252,#3987e5" --mode dark --surface #1e1a14
Palette (dark, surface #1e1a14, categorical): 9 slots
  [PASS] Lightness band         all 9 inside L 0.48–0.67
  [PASS] Chroma floor           all 9 >= 0.1
  [PASS] CVD separation         worst adjacent #c98500↔#199e70 ΔE 8.4 (protan) · tritan 8.2
  [PASS] Normal-vision floor    worst adjacent #d85484↔#c98500 ΔE 19.1 (normal)
  [PASS] Contrast vs surface    all 9 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
# dark — work
$ node scripts/validate_palette.js "#1468c3,#b63e00,#007a54,#8b5a00,#b63467,#007800,#6b5dbd,#be3136,#1468c3" --mode dark --surface #1e1a14
Palette (dark, surface #1e1a14, categorical): 9 slots
  [PASS] Lightness band         all 9 inside L 0.48–0.67
  [PASS] Chroma floor           all 9 >= 0.1
  [PASS] CVD separation         worst adjacent #8b5a00↔#007a54 ΔE 8.1 (deutan) · tritan 8.2
  [PASS] Normal-vision floor    worst adjacent #8b5a00↔#007a54 ΔE 15.6 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#8b5a00",2.93]]
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
# light — gray ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#86837c,#675f50,#3b3426" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #86837c at 3.72:1 vs surface
  [PASS] Single hue             hue spread 4°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — red ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#cc8882,#d03b3b,#9b0015" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #cc8882 at 2.79:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — orange ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#e2a58f,#eb6834,#ad3c00" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #e2a58f at 2.06:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — amber ordinal [scheduled, travel, work]
$ node scripts/validate_palette.js "#eda100,#b69568,#b27800" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #eda100 at 2.13:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — green ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#729c6e,#008300,#006400" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #729c6e at 3.09:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — teal ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#8dbea5,#1baf7a,#007952" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #8dbea5 at 2.06:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — blue ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#7b9bc6,#2674d2,#004f9f" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #7b9bc6 at 2.81:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — violet ordinal [travel, scheduled, work]
$ node scripts/validate_palette.js "#8787c3,#6250d6,#4b31b7" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #8787c3 at 3.29:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# light — pink ordinal [scheduled, travel, work]
$ node scripts/validate_palette.js "#e87ba4,#ab7b8b,#b14a74" --mode light --surface #fffdf9 --ordinal
Palette (light, surface #fffdf9, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #e87ba4 at 2.65:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — gray ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#6f6b62,#918773,#b0a691" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #6f6b62 at 3.26:1 vs surface
  [PASS] Single hue             hue spread 2°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — red ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#814744,#be3136,#e05252" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #814744 at 2.41:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — orange ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#7e4937,#b63e00,#db5b28" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #7e4937 at 2.39:1 vs surface
  [PASS] Single hue             hue spread 1°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — amber ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#694e29,#8b5a00,#c98500" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #694e29 at 2.24:1 vs surface
  [PASS] Single hue             hue spread 1°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — green ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#345b31,#007800,#279723" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #345b31 at 2.21:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — teal ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#355f4c,#007a54,#199e70" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #355f4c at 2.38:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — blue ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#3b597f,#1468c3,#3987e5" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #3b597f at 2.41:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — violet ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#59567f,#6b5dbd,#9085e9" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #59567f at 2.52:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# dark — pink ordinal [travel, work, scheduled]
$ node scripts/validate_palette.js "#7e4758,#b63467,#d85484" --mode dark --surface #1e1a14 --ordinal
Palette (dark, surface #1e1a14, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #7e4758 at 2.41:1 vs surface
  [PASS] Single hue             hue spread 0°
  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
# run 4 — contrast() of each ink on its fill, --foreground on travel and area
light gray   scheduled #fffdf9 on #675f50 6.21 | work #fffdf9 on #3b3426 12.12 | travel #1f1a12 on #86837c 4.57 | area #1f1a12 on #e8e5e0 13.76
light red    scheduled #fffdf9 on #d03b3b 4.73 | work #fffdf9 on #9b0015 8.60 | travel #1f1a12 on #cc8882 6.10 | area #1f1a12 on #fce3dd 14.14
light orange scheduled #1f1a12 on #eb6834 5.40 | work #fffdf9 on #ad3c00 6.04 | travel #1f1a12 on #e2a58f 8.24 | area #1f1a12 on #ffe9de 14.79
light amber  scheduled #1f1a12 on #eda100 7.98 | work #1f1a12 on #b27800 4.59 | travel #1f1a12 on #b69568 6.16 | area #1f1a12 on #fdf1df 15.50
light green  scheduled #fffdf9 on #008300 4.87 | work #fffdf9 on #006400 7.32 | travel #1f1a12 on #729c6e 5.51 | area #1f1a12 on #e0ecd9 14.13
light teal   scheduled #1f1a12 on #1baf7a 6.14 | work #fffdf9 on #007952 5.36 | travel #1f1a12 on #8dbea5 8.27 | area #1f1a12 on #e5f2e7 14.97
light blue   scheduled #fffdf9 on #2674d2 4.58 | work #fffdf9 on #004f9f 7.89 | travel #1f1a12 on #7b9bc6 6.05 | area #1f1a12 on #e1eaf5 14.23
light violet scheduled #fffdf9 on #6250d6 5.68 | work #fffdf9 on #4b31b7 8.53 | travel #1f1a12 on #8787c3 5.17 | area #1f1a12 on #e6e6f7 14.02
light pink   scheduled #1f1a12 on #e87ba4 6.42 | work #fffdf9 on #b14a74 5.04 | travel #1f1a12 on #ab7b8b 4.89 | area #1f1a12 on #feebed 15.08
dark gray   scheduled #1e1a14 on #b0a691 7.18 | work #1e1a14 on #918773 4.88 | travel #f3ede0 on #6f6b62 4.55 | area #f3ede0 on #3d382e 9.98
dark red    scheduled #1e1a14 on #e05252 4.53 | work #f3ede0 on #be3136 4.89 | travel #f3ede0 on #814744 6.17 | area #f3ede0 on #482922 11.14
dark orange scheduled #1e1a14 on #db5b28 4.57 | work #f3ede0 on #b63e00 4.89 | travel #f3ede0 on #7e4937 6.22 | area #f3ede0 on #472a1c 11.14
dark amber  scheduled #1e1a14 on #c98500 5.64 | work #f3ede0 on #8b5a00 5.06 | travel #f3ede0 on #694e29 6.61 | area #f3ede0 on #42311a 10.68
dark green  scheduled #1e1a14 on #279723 4.56 | work #f3ede0 on #007800 4.88 | travel #f3ede0 on #345b31 6.70 | area #f3ede0 on #27351b 11.17
dark teal   scheduled #1e1a14 on #199e70 5.08 | work #f3ede0 on #007a54 4.60 | travel #f3ede0 on #355f4c 6.22 | area #f3ede0 on #273728 10.82
dark blue   scheduled #1e1a14 on #3987e5 4.76 | work #f3ede0 on #1468c3 4.74 | travel #f3ede0 on #3b597f 6.16 | area #f3ede0 on #283341 10.98
dark violet scheduled #1e1a14 on #9085e9 5.54 | work #f3ede0 on #6b5dbd 4.59 | travel #f3ede0 on #59567f 5.88 | area #f3ede0 on #363241 10.66
dark pink   scheduled #1e1a14 on #d85484 4.55 | work #f3ede0 on #b63467 4.90 | travel #f3ede0 on #7e4758 6.15 | area #f3ede0 on #46292c 11.15
worst 4.53 -> PASS (all >= 4.5)
```

## Logo

**The square dial:** the to-do box drawn as a clock face.

- The rounded square is the checkbox.
- The saffron sweep, from 12 o'clock to the hand, is the part of the day already marked with the highlighter.
- The hand is now. It points into the corner at half past four.

It says both halves of the name at once, a to-do box and a clock. The 24-hour ring stays the hero and the clock block. The alternates (a ring dial and a highlighter tick) and every exploration round are in `.superpowers/sdd/2026-11-11-todolist-dashboard/logo/` (local only).

**Construction** (24-unit box, the rim's outer edge is the box edge):

- Corner radius 7.
- Rim 3.4 wide, stroked on its centreline.
- Hand 3 wide with round caps, 7 long, from the centre at 135°.
- Sweep from 0° to 135°. It ends under the rim, so it needs no clip path.

`client/src/data/logo.ts` is the only source. `<LogoMark>` and `<Logo>` (`components/ui/Logo.tsx`) draw from it. `npm run generate:icons` writes everything else from it:

- the favicons;
- `public/brand/` (the mark and the lockup, both variants);
- the PNG icons and the social image.

`data/logo.test.ts` fails when the colours drift from the theme tokens or the shipped SVGs are stale.

**Two variants**, one per background:

| Variant                   | Rim, hand, wordmark              | Sweep                           | Plane (filled favicon, icons) |
| ------------------------- | -------------------------------- | ------------------------------- | ----------------------------- |
| Light (light backgrounds) | ink `#1F1A12` (`--foreground`)   | saffron `#F2C14E` (`--accent`)  | `#F7F4EE`                     |
| Dark (dark backgrounds)   | paper `#F3EDE0` (`--foreground`) | saffron `#F0B53C` (`--primary`) | `#16130E`                     |

**Contrast:**

- **Rim, hand and wordmark** (the parts that carry the shape) clear AA text contrast: 15.75 / 17.02 on the light page and card, 15.88 / 14.84 on the dark ones.
- **The light hand** where it crosses the sweep: 10.30.
- **The sweep** is a fill inside the rim, not a boundary: 1.53 on the light page, 10.04 on the dark one.

**Light and dark in use:**

- **In the app,** `<Logo>` and `<LogoMark>` are inline SVG. Both variants' colours are on the element, and `dark:` classes pick one under `.dark`, so the swap is pure CSS: no flash and no image request.
- **The favicons** follow the app's theme, not the browser's: `data/favicon.ts` is swapped by ThemeProvider. Each one is filled with its own page plane, so it still reads when the tab strip is the opposite colour (the paper plane is 10.99:1 on Chrome's dark tab, the dark plane 18.52:1 on white).
- **Elsewhere,** use the light variant on the light page and cards and the dark variant on the dark ones.
- **Don'ts:** never put the mark on saffron or ochre fills, where the sweep disappears. Never recolour the sweep. Never set the mark in the brand ochre.
- **Email** renders on light backgrounds, so it would use `public/brand/logo-light.svg`. No email embeds the logo today.

**Lockup:**

- The mark is 1.375em, then a 0.4em gap, then "TodoList" in IBM Plex Sans 600 at -0.02em. The capitals are centred on the mark.
- `<Logo>` sets this in live text; `public/brand/logo-*.svg` carry the same wordmark as outlines (`scripts/wordmark.ts`).
- The wordmark is always Latin and left to right (`dir="ltr"`, `translate="no"`), including in the Hebrew UI. There the lockup sits at the inline start but reads mark first.

**Clear space and size:**

- **Clear space:** a quarter of the mark's height on every side, with nothing inside it.
- **Smallest sizes:** 16 px as a favicon (the filled version), 20 px for the mark in the interface, and a 16 px mark in the lockup (an 11.6 px wordmark). The navigation uses a 22 px mark with a 16 px wordmark; the auth pages show the mark alone at 40 px.
- **Workspace marks** (`WorkspaceMark`, the workspace switcher) keep the earlier ring tile. They are per-workspace avatars, not the logo.

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
