# UI/UX V4 — Site-wide layout & typography correction

| | |
|---|---|
| Branch | `kimi/uiux-v2-spatial-workspace` |
| Date | 2026-08-27 |
| State | Working tree — **not committed, not merged, not deployed** |
| Method | Rendered-DOM measurement of the real authenticated application |
| Harness | `scripts/verify/layout-audit.mjs` — 28 screens × 5 viewports = 140 renders |

---

## 1. Approach

The defects you listed — `POSTE / D`, `Vie / w`, wrapping currency, cramped
commitment panels, narrow panels beside large empty regions — were treated as
**one design-system problem, not a list of screens to patch**.

A measurement harness was built first. It walks the real rendered DOM of the
authenticated application at five widths and reports, **attributed to a CSS
selector rather than to a screen**:

1. short labels that wrap, flagging single words broken mid-word
2. elements narrower than their own `min-content`
3. overflow that nothing handles
4. text below a legible size for the viewport
5. how much horizontal canvas the content actually uses

Attributing findings to selectors is what turned ~2,400 individual symptoms into
**four shared rules to fix**.

### The harness had to be corrected twice — both times it was flattering the result

- **It counted child elements as wrapped lines.** `Range.selectNodeContents`
  includes a status dot or icon, which sits on its own baseline, so 123 `.sig`
  elements were reported as wrapping when they were not. It now measures only
  the element's own text nodes.
- **Several of its screen paths did not exist.** `/app/people`, `/app/risk`,
  `/app/health` and five others 404'd, so those screens silently measured a
  *not-found card* — a small, perfectly laid-out box that reports zero defects.
  Paths are now taken from the verified route list, and the harness **aborts** on
  a 404 or a redirect to `/login` rather than measuring it.

Both corrections made the numbers worse before they made them better. The final
figures below are from the corrected harness.

---

## 2. What the measurement found

| | Before | After |
|---|---:|---:|
| Single words broken mid-word | **191** | **0** |
| Short labels wrapping | **478** | **3** ¹ |
| Text rendered at 11.2px | **1,697** | **0** |
| Unhandled horizontal overflow | present | **0** |
| Screens actually measured | 17 real + 8 × 404 | **28 real** |

¹ Three remain and are correct: `.k` labels that are genuine sentences
("Overdue or blocked") and one `<strong>` inside a paragraph. Long labels are
supposed to wrap; the rule protects *short* ones.

### The four root causes

**1 · `overflow-wrap: anywhere`** on `.mono, td, .badge` — a single line in
`globals.css`. It breaks a word at **any** character the instant its box is a
pixel too narrow. That one declaration produced `POSTE / D`, `Vie / w`,
`FIXTURE-INV-104 / 1` and every other mid-word break in the application.

**2 · A pinned type scale.** `--t-body`, `--t-data`, `--t-small` and `--t-label`
were fixed rem values, so a 1920px executive monitor rendered table headers,
stat keys and badges at exactly the same 11.2px as a 360px phone.

**3 · `repeat(N, minmax(0, 1fr))`** in the shared grid utilities. It forces
exactly N equal columns *and* — because the floor is `0` — permits every one of
them to shrink below the width its content needs. Cards were measured up to
**569px narrower than their own `min-content`**.

**4 · `auto-fill` instead of `auto-fit`** on the matter field. `auto-fill`
**reserves empty tracks**. With one matter on the Calendar, the grid still cut
the canvas into three 340px columns, put the matter in the first and left the
other two blank — which is precisely the "narrow panel with a large empty region
beside it" you identified. This was the single highest-impact line in the pass.

---

## 3. What changed in the design system

### Typography — a role-based responsive scale

Every size is now declared for a **role** and every one scales with the
viewport. Floors are the phone size, ceilings the 1920+ size:

| Role | Token | Phone → 1920 |
|---|---|---|
| Page title | `--t-page-title` | 24.8 → 37.6px |
| Section title | `--t-section-title` | 16 → 21.1px |
| Subsection | `--t-subsection` | 15.2 → 17.9px |
| Value | `--t-value` | 16.3 → 21.4px |
| Body | `--t-body` | 15 → 17.3px |
| Secondary body | `--t-body-2` | 14.2 → 16px |
| Data (tables) | `--t-data` | 14.4 → 16.3px |
| Small | `--t-small` | 13.8 → 15.4px |
| Label (caps) | `--t-label` | 12.3 → 13.8px |
| Metadata | `--t-meta` | 12.6 → 13.9px |

Five hard-coded `0.7rem` declarations in the shell were re-pointed at
`--t-label`. A regression test fails if any role floors at or below 11.5px, or
if a hard-coded `0.7rem` reappears.

### Wrapping — the rule inverted

Short interface labels **never** wrap and size their own container:
`.badge`, `.sig`, `.prov-label`, `.matter-kind`, `.btn`, `.chip`, `.tag`,
`.pill`, `.kbd`, `th`, `.num`, `.stat .v`, `.node-meta`, `.tl-when`.

Identifiers stay quotable: `.mono` (reference codes) and a new `.filename`
utility that truncates with an ellipsis and keeps its full value in `title`.

`overflow-wrap: anywhere` now survives **only** behind an explicit opt-in
(`.allow-break`, `.mono-block`, inside `<pre>`), and a test enforces that.

Prose still wraps: memos, descriptions, `.matter-fact .v`, `td.memo`, and any
cell marked `.allow-wrap`.

### Tables — width by information type

```
--col-date    96 → 124px      --col-ref     112 → 150px
--col-status  104 → 136px     --col-qty      72 → 96px
--col-money   132 → 176px     --col-text-min      240px  (flexible, dominant)
--col-action   84 → 112px
```

Applied through `th.col-*` classes. Each carries `min-width: max-content` as a
floor, so a column can never be sized below the words in its own header.
`td` holds values and does not wrap; `td.memo`/`.desc`/`.allow-wrap` and any
cell containing a `<p>` do.

**On a phone**, `table.data.stacks` becomes a list of records — each row a card,
each cell a labelled line, the column heading travelling with the value via
`data-label`. Tables better served as a grid (a trial balance, a journal) keep
`.table-wrap`'s horizontal scroll, which is the honest answer for a ledger.

### Grids — intrinsic, not equal

`.grid.cols-N` is now a **maximum** column count that reflows:
`repeat(auto-fit, minmax(min(100%, Xpx), 1fr))`. The `min(100%, …)` wrapper
means a track wider than the viewport reflows instead of overflowing — a test
enforces it on every `auto-fit` track in the codebase. A caller that genuinely
needs a fixed count asks for `.grid.fixed-2` / `.fixed-3`.

### Canvas — scales with the viewport

`--canvas-max: clamp(1180px, 94vw, 2040px)` replaces a flat `1680px` cap that
treated a 1920 monitor as a 1440 one. `--measure: 74ch` still holds prose to a
readable line. `.surface.is-focus` opts a single-column reading surface into the
narrower `--canvas-max-focus`.

---

## 4. Figma — used, and what for

**Confirmed connected.** `whoami` returned the account `Singha`
(lakanthi7@gmail.com), Pro tier. Real operations were performed; nothing here is
claimed without a corresponding tool call.

File: **"Singha — Spatial Executive OS: Grid & Type System"** —
`https://www.figma.com/design/o8I8ykBCvD1NQ2NHuRW0F7`

| Built | Detail |
|---|---|
| 42 variables | environment, accent, neutrals, status, spacing, radius, and the seven column widths |
| 13 text styles | the role ramp at its 1920 values, `Singha/01 Display` … `13 Numeric LG` |
| 1920 frame | rail 76 · strip 56 · stage 1810 on a 12-column grid at 24px gutters |
| Composition study | condition instrument 396 / dominant matter 966 / now 400, then 1186 + 600, then a full-width change ledger |

Two things came back from the study into the code:

- **`.centre` retracked** from `0.85fr / 1.15fr` to `minmax(320px, 0.28fr) /
  1fr`. A dial is a fixed-character object — it does not become more legible
  when it is wider — so it takes a bounded track and the work takes the rest.
  The old split let the instrument grow to 46% of a 4K canvas.
- **Signature surfaces.** Large composition panels now use a diagonal
  plum-to-obsidian ground, a wider radius and a deeper shadow, tinted per
  domain. Small operational cards keep the restrained flat glass. That is the
  direct answer to "glass treatment must not become repetitive" — the large
  surfaces are a different material class, not bigger copies of the small ones.

---

## 5. Three.js — evaluated and declined, with the reason

Recorded in `docs/DECISIONS.md`. Neither `three` nor `@react-three/fiber` is
installed, and neither was added.

- **Nothing in the interface is a 3D object.** Dials, rings and arcs are 2D
  figures with depth cues. Rendering a ring in WebGL does not make it more
  legible, and legibility is the whole point of an instrument.
- **The one genuine 3D case is gated.** A spatial site or fleet model needs
  location and telemetry — GPS/CCTV capabilities held behind legal and privacy
  review. Building the renderer before the data is authorised is building ahead.
- **It fights the performance tiers.** `SpatialEnvironment` already downgrades
  atmosphere on weaker devices. A WebGL context cannot be partially disabled,
  and it costs battery on the phones and tablets this system is operated from.

What the reference image actually needed was **light**, not geometry: the
condition arcs now carry `drop-shadow(0 0 7px currentColor)`, with `color` set
from the same tone token as the stroke so the glow can never disagree with the
status. Dropped entirely on the light performance tier and under
`prefers-reduced-transparency`.

---

## 6. Other fixes in this pass

- **AI presence orb** — was an opaque ivory-to-gold sphere that read as a solid
  ball sitting on top of the interface. Now a small bright core falling away
  into darkness, with the warmth in the halo rather than the body.
- **Instrument caption** — sat inside the dial face, where the usable width
  narrows towards the top and bottom of the circle, and ran to four lines. Moved
  below the instrument on the full column width. **Not truncated**: clamping it
  to two lines was tried and rejected, because silently dropping half a caption
  is exactly the kind of omission this interface forbids elsewhere.
- **`.matter-facts`** widened from a 108px track minimum — narrower than the
  labels it actually carries — to 172px.
- **Calendar dates** wrapped at their own hyphens (`2026-` / `08-16`). The date
  is now atomic while the title beside it still wraps.
- **Document filenames** truncate with an ellipsis instead of breaking mid-name.

---

## 7. Verification

```
scripts/verify/layout-audit.mjs      28 screens × 5 viewports = 140 renders
  broken single words   0      (was 191)
  wrapping short labels 3      (was 478; all three are correct long-label wraps)
  text under 11.5px     0      (was 1,697)
  unhandled overflow    0
  404s / redirects      0      (harness now aborts rather than measuring one)

tests/os/layout-system.test.ts       16 tests — the four root causes locked in
npm run build                        compiles clean
```

The regression test asserts the **shape of the shared rules**, not screen
snapshots: no unconditional `overflow-wrap: anywhere`; every role token uses
`clamp()`; no role floors below 11.5px; no `.grid.cols-*` with a zero floor;
every `auto-fit` track guarded by `min(100%, …)`; `min-width: max-content` on
numeric and status headers; no surface pinned to 1680px; the stacked phone table
carries its headings.

---

## 7b. Two defects the owner spotted in the screenshots — both were mine

**Blurred text everywhere on the Command Centre.** The two composition columns
carried `translateZ(-30px)` and `translateZ(28px)` under the composition's
1800px perspective. Perspective turns a Z translation into a **scale**: measured
on the real page, a column with a layout width of 943px rendered at **958.03px**
— 1.0159×. A composited layer is rasterised once and the bitmap resampled, so
every glyph in both panels was being resampled by a non-integer factor. That is
the softness a reader notices without being able to name it.

Isolated by experiment rather than assumption: disabling `backdrop-filter` left
the scale at 1.0159×; disabling the transform took it to 1.0001×. The transform
was the cause.

Legibility beats a 1.6% parallax on a screen carrying money. Depth is now
carried by cues that do not change rendered size — a heavier shadow, a brighter
top edge and higher contrast for the nearer surface; a softer shadow, a dimmer
edge and receded contrast for the further one. Verified after the change:
320/320, 943/943, 1293/1293. **Rendered size equals layout size exactly.**

The `.depth-*` ladder in `materials.css` carries the same hazard, but appears
only in the dev design lab and on no production screen.

**A caption painting across the panel beside it.** The cash-forecast note —
"Projected from open invoices in, and bills plus committed outflows out…" — ran
straight out of its card and over the receivables chart next door. The cause was
a `.dim.small` nowrap rule added two steps earlier so table dates would not
split; that class pair is also used for prose captions.

A nowrap **block** keeps its box at the container width and lets only the glyphs
escape, so the box measures as fitting — which is why this file's own box-based
`squeezed` probe reported nothing. The audit now measures the TEXT as well (an
`escapes` channel), and excludes text that is deliberately clipped with an
ellipsis so intentional truncation is not reported as a defect. Across 28
screens × 5 viewports: **0 escapes**.

The nowrap rule is now scoped to table cells only. Both defects have regression
tests, and **both tests were verified to fail when the defect is reintroduced** —
the first version of the nowrap test did not, because it checked the whole
selector list for the word "table" rather than each selector part, so an
unscoped `.dim.small` sitting beside `table.data td.dim` passed.

Also fixed: "1 other record **were** updated" → "was updated".

---

## 8. Honest limitations

- **`.matter` still measures 46–80px below `min-content` in 8 cases.** Forcing
  `width: min-content` on a grid whose tracks use `auto-fit` over-estimates the
  requirement, because `auto-fit` collapses empty tracks at render time. Wraps
  and overflow are both zero on those screens, so this reads as a measurement
  artefact — but it is reported rather than suppressed.
- **The canvas metric reports "0% unused" everywhere**, which means the widest
  content element reaches the viewport edge. That confirms the canvas is no
  longer capped short; it does not by itself prove the *composition* uses the
  width well. The visual check is what settles that, screen by screen.
- **One company, local Postgres, RLS cutover flags off** — unchanged from the
  previous pass.
- Only the Calendar's missed-commitments panel was recomposed. Other screens
  benefited from the shared rules but were not individually redesigned.

---

## 9. State

Nothing committed, merged or deployed. No migration created. No flag enabled.
No hosted system contacted. GPS, CCTV, facial recognition and autonomous agents
remain not built and are named as gated.
