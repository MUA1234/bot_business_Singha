# UI/UX V3 — Cinematic Spatial Executive OS

| | |
|---|---|
| Branch | `kimi/uiux-v2-spatial-workspace` |
| Base SHA | `8c71c81` |
| Date | 2026-08-27 |
| State | Working tree — **not committed, not merged, not deployed** |

---

## 1. What was asked, and what was done

Transform the whole user-facing platform into an immersive, cinematic **AI Spatial
Command Centre** — without sacrificing, mocking, bypassing or removing any working
functionality.

The transformation was done as a **design-system replacement plus a composition
rewrite**, not as a page-by-page reskin:

1. **Four new style layers** replace the previous "Agentic OS" mint-on-graphite
   theme with the **Cinematic Spatial Executive OS**: obsidian environment, smoky
   aubergine atmosphere, warm champagne accent used sparingly and never for status.
2. **Every legacy class name was preserved** (`.card`, `.btn`, `.badge`, `.stat`,
   `table.data`, `.nav-item`, …) and re-pointed at the new material system, so all
   114 page routes inherited the new material world without being touched.
3. **The shell was replaced**: a structural command rail, a minimal scope strip, an
   extremely subtle virtual camera and an always-reachable AI presence.
4. **The signature surfaces were rewritten** on top of a new instrument library.

Nothing in this change touches business logic, permissions, authority rules,
accounting, migrations or the WhatsApp pipeline.

---

## 2. Architecture of the design system

```
src/styles/tokens.css        colour · type · space · radius · material · border ·
                             shadow · blur · reflection · lighting · depth ·
                             camera · motion · breakpoints · semantic status
src/styles/materials.css     the five materials, the depth ladder, the signal
                             system, the provenance rules, typography utilities
src/styles/shell.css         environment, command rail, top strip, stage, camera,
                             AI presence, phone bar, destination sheet
src/styles/instruments.css   condition instrument, change ledger, briefing, matter,
                             constellation, timeline, evidence sheet, decision
                             chamber, command palette, AI room, honest states
src/app/globals.css          base elements + the component library (unchanged
                             class names, new construction)
```

### The five materials

| | Material | Used for |
|---|---|---|
| A | **Spatial glass** | High-level floating surfaces. Translucent, blurred, edge-lit. |
| B | **Smoked glass** | Secondary operational panels. Less transparent, dense data stays crisp. |
| C | **Instrument** | Gauges, meters, condition wheels. A machined well with a lit top lip. |
| D | **Paper / evidence** | Documents. Squarer corners, lifted edge, real drop shadow — never another glass rectangle. |
| E | **Metal / structural** | The rail, dividers, frame elements. Anodised, used sparingly. |

### Depth carries meaning

`--z-env → --z-backdrop → --z-dept → --z-base → --z-active → --z-priority →
--z-critical → --z-focus`. Each level pairs a Z translation, a matched shadow and a
matched scale, so "forward" reads as forward rather than merely bigger. **Reduced
motion keeps every depth cue and drops every transition** — hierarchy survives with
all movement removed.

### The camera

Pointer influence is capped in the tokens at ±1.5° horizontal, ±1° vertical and 8 px
of depth. `useCamera` writes CSS custom properties on one element (a compositor
transform per frame, no re-render) and **disengages entirely** for a coarse pointer,
for `prefers-reduced-motion`, and below 1200 px.

### Performance tiers

`SpatialEnvironment` measures the device and stamps `<html data-tier>`. A tier only
ever removes atmosphere — never a control, a label, a route or a figure. Where
`backdrop-filter` is unsupported, panels paint opaque instead of translucent.

---

## 3. Surfaces transformed

### Phase A — foundations
Tokens, materials, depth, lighting, motion, responsive rules, and the global shell
(`SpatialShell`, `CommandRail`, `CommandPalette`, `AIManagementRoom`,
`SpatialEnvironment`, `useCamera`, `ViewSwitcher`).

### Phase B — signature experience
| Surface | File |
|---|---|
| Owner/CEO Command Centre | `src/components/spatial/panels/CommandCentrePanel.tsx` |
| AI Manager presence + room | `src/components/os/AIManagementRoom.tsx`, `SpatialShell.tsx` |
| Decision chamber (approvals) | `src/components/spatial/panels/ApprovalsPanel.tsx` |
| Work command centre | `src/components/spatial/panels/TasksPanel.tsx` |
| Task workspace | `src/app/app/operations/tasks/[id]/page.tsx` |

### Phase C — management core
Finance control room, People/workforce constellation, Capacity, Customer
relationship field, Communications (three-layer), Projects portfolio, Project
command room, Personal staff cockpit.

### Phase D — operational control
Operations, Procurement, Fleet control tower, Risk & governance, **Calendar &
commitments (new)**, **Documents & knowledge (new)**.

### Phase E — AI & platform
**AI operations (new)**, System health, Audit trail (timeline + table).

### Phase F — other experiences
Admin overview, Marketing, Notifications, login, landing, not-found, and the
external customer quotation portal (`/q/[token]`).

---

## 4. Three new rooms, built from records that already exist

None of these introduced a table, a migration or a business rule.

| Room | Assembled from |
|---|---|
| `/app/calendar` | Task due dates, obligations, licence expiries, contract renewals, insurance expiries, expected PO payments, expected commitment settlements, approved leave |
| `/app/documents` | The `documents` evidence store plus contracts, licences and insurances |
| `/app/ai` | `ai_runs` — model, cost, validation result per run |

---

## 5. Honesty guarantees — the design constraint that shaped everything

A cinematic surface is allowed; a dishonest one is not.

- **A degraded read never produces an all-clear.** The condition instrument refuses
  to state a condition when a source failed, and the banded briefing suppresses its
  "no exceptions" line. `conditionSummary()` and `buildBandedBriefing()` are unit
  tested for exactly this.
- **A failed probe is never a calm zero.** The system-health screen's `Metric`
  contract is preserved and surfaced: an unreadable signal says *"could not be read
  — this is not a zero"*.
- **An undated record is reported, not placed.** The calendar counts records with no
  date and shows the gap rather than guessing a day.
- **Provenance is never blurred.** AI advice, deterministic system state, a human
  decision, an approved action and a completed action each carry a distinct rule and
  label (`Provenance`), so they can never be read as the same thing.
- **Status is never colour alone.** Every `Signal` is a shape-differentiated marker
  plus a colour plus a word.
- **Telemetry is never invented.** The fleet screen states plainly that location,
  trips, odometer and utilisation are *not* available, rather than estimating them.
- **Measured / inferred / missing** is a first-class tag (`ProvenanceTag`).

### AI authority boundary, stated on the surface
The AI Management Room and `/app/ai` both state, before any figure, that the AI
observes, explains and proposes and **cannot** approve a payment, post a journal,
change a permission or make a commitment. The command palette navigates and opens
the AI room — it executes no business action, because a fuzzy-matched string is not
an authorisation.

---

## 6. Gated capabilities — an honest absence, not an empty console

`CLAUDE.md` gates GPS, CCTV, facial recognition, the Agent Builder, autonomous
agents and customer-facing AI agents behind legal/privacy review. **None was built.**
Rather than shipping empty consoles that imply the capability exists, `/app/ai` and
the fleet screen name each gated capability and say it is not implemented and why.

The design brief's §37 (Fleet/GPS), §38 (CCTV) and §42–43 (Agent Room / Builder) are
therefore **deliberately not delivered as functional surfaces**. This is the one
place where the brief and the repository's standing constraints conflict, and the
constraint was followed. Reversing that is an owner decision.

---

## 7. Navigation: nothing lost, nothing gained

`src/lib/os-navigation.ts` folds each department's entitled `NavItem`s into rail
destinations. Two invariants, asserted for **every department** in
`tests/os/navigation.test.ts`:

1. **Nothing is lost** — every entitled route is reachable, as a destination or
   inside one; an unmapped route surfaces under "Other" rather than disappearing.
2. **Nothing is gained** — a destination is offered only when the department's own
   nav already contains one of its routes. The rail cannot become a way around a
   permission.

The test caught three **pre-existing** gaps, now fixed in `departments.ts`:
`/app/operations/projects` (reachable by route, no link, for both Operations and
Admin), `/app/hr/leave`, and several admin routes (outbox, integrations,
directives, model-budgets, portfolio, cases, memory, operations, hr) that existed
but had no navigation entry.

---

## 8. Responsive, touch and accessibility

- **Phone navigation was rebuilt.** Sixteen horizontally scrolling tabs is a list
  nobody reads; the bar now carries four primary destinations plus a **full-height
  destination sheet** holding everything else, grouped exactly as the desktop rail
  groups it. Nothing is removed on a small screen.
- **44 px is the floor for every interactive control**, including `.btn.sm` —
  "small" is a visual weight, not a smaller target.
- Verified at **1920, 1440, 1366, 1280, 1024, 834, 768, 430, 390 and 360 px**.
- **Zero horizontal overflow** at every width; wide tables scroll inside their own
  container.
- Skip link, focus rings on every interactive surface, focus trapping in the
  palette / AI room / destination sheet, `aria-current` on the current destination,
  screen-reader labels on counts, and `role="listbox"`/`aria-activedescendant` in
  the palette.
- Reduced motion captured separately as a first-class rendering mode.

---

## 9. Verification

### Automated
```
npm run verify
  ✅ secret-scan: no tracked secrets found
  ✅ migration-lint: 108 migrations, sequential 0001–0108, no gaps  (no new migrations)
  ✅ completion-inventory --check
  ✅ autonomy/audit-requirements --quiet
  ✅ autonomy/check-ip-boundary --quiet
  ✅ typecheck
  ✅ npm test — 178 files / 1277 passed | 2 skipped

npm run build   ✅ production build succeeds
npm run lint    ✅ only the two pre-existing <img> warnings
```

Test count moved from **176 files / 1254 tests** to **178 / 1277** — the new files
are `tests/os/navigation.test.ts` (7) and `tests/os/honesty.test.ts` (16).

### Visual
`scripts/verify/os-screenshots.mjs` — a new harness that renders real routes in a
real browser at ten viewports and **measures what a screenshot cannot show**:
horizontal overflow, console errors, touch targets under 44 px, text under 11 px,
and HTTP status against an expected value. Reduced motion is captured separately.

```
node scripts/verify/os-screenshots.mjs --base http://127.0.0.1:3220
  60 captures → screenshots/uiux-v3
  0 flagged · horizontal overflow: none
```

Captures were taken against a **production build**, because the dev server's own
CSP (`script-src 'self' 'unsafe-inline'`) blocks Next's react-refresh runtime and
prevents client hydration in development. Interactivity — the command palette
(40 entries), the AI Management Room, the rail — was verified against that
production server.

### Three tests were changed, and why
| Test | Change |
|---|---|
| `mob-001-responsive-surface` | Asserted the literal `grid-template-columns: 1fr`. Now asserts the collapse **behaviour** by regex and accepts `minmax(0, 1fr)`, which is what prevents the grid blowout the neighbouring overflow assertion exists to stop. |
| `gov-001-management-directives` | Asserted `href="/app/admin/directives"`. The admin home now builds its index from a data array, so the route appears as `href: "…"`. Asserts the route reference instead. |
| `int-001-integration-gateway` | Same change, for `/app/admin/integrations`. |

Five other guard tests asserted section headings (`Project registry`, `Forecast
curve by period`, `Project risks`, `Project decisions`, `Scenario comparison`).
Those were **not** relaxed — the headings were restored to the exact wording, which
reads correctly anyway.

---

## 10. What could not be verified here, stated plainly

**Authenticated screens have not been rendered.** The application reaches its data
through Supabase and there is no Supabase instance in this environment, so every
`/app/*` route redirects to sign-in. What was verified is the design system itself,
through `/dev/design-lab` — a development-only surface that renders every material,
instrument, signal and honest state against clearly-labelled synthetic placeholder
values, reads no business data, and is refused outright when `APP_ENV=production`.

The lab is `force-dynamic`, so its gate is evaluated per request rather than baked
into the build output as a static page.

Authenticated capture remains the job of `scripts/verify/spatial-screenshots.mjs`,
which signs in for real against a disposable environment — still blocked on the
staging Supabase project described in `docs/uiux-v2-staging-handoff.md`.

---

## 11. Pre-existing issues observed, not fixed

Both reproduced with these changes stashed, and both outside this task's scope:

1. **`useActionState` is imported from React 18.3** in
   `src/app/app/finance/duplicate-reviews/ReviewCard.tsx`. It is a React 19 API;
   the build emits *"Attempted import error: 'useActionState' is not exported from
   'react'"*. That component's interactive path will fail at runtime.
2. **The middleware sign-in redirect resolves to `https://` on a plain-HTTP
   origin**, producing `ERR_SSL_PROTOCOL_ERROR` for prefetches of `/app/*` on a
   local production server. Real deployments are HTTPS, so this likely never
   manifests in production — but it makes local end-to-end verification noisy.

---

## 12. Reversible design decisions the owner may want to revisit

1. **The living-background video was retired from the UI.** It is a green-teal robot
   loop; the new direction is obsidian and champagne, and the brief prohibits robot
   imagery in the AI interface. `LivingBackground.tsx` and the media assets are
   **kept, not deleted** — restoring it is a one-line change per surface.
2. **The AI presence sits bottom-right, not bottom-centre.** Centred, it sat
   permanently on top of the reading column and covered a different heading at every
   scroll position.
3. **The condition instrument's headline number is what needs attention**, not the
   total of everything charted, with "of N tracked" beneath it.

---

## 13. Files

| Category | Files |
|---|---|
| Style layers | `src/styles/tokens.css`, `materials.css`, `shell.css`, `instruments.css`, `src/app/globals.css` |
| Shell | `src/components/os/SpatialShell.tsx`, `SpatialEnvironment.tsx`, `CommandRail.tsx`, `CommandPalette.tsx`, `AIManagementRoom.tsx`, `useCamera.ts`, `ViewSwitcher.tsx` |
| Instruments | `src/components/os/ConditionInstrument.tsx`, `primitives.tsx` |
| Model | `src/lib/os-navigation.ts`, `os-ai-context.ts`, `os-shell-data.ts`, `src/management/ai-manager/briefing-bands.ts`, `changes.ts`, `src/modules/calendar/commitments.ts` |
| New rooms | `src/app/app/calendar/page.tsx`, `src/app/app/documents/page.tsx`, `src/app/app/ai/page.tsx` |
| Design lab | `src/app/dev/design-lab/**` (development-only) |
| Harness | `scripts/verify/os-screenshots.mjs` |
| Tests | `tests/os/navigation.test.ts`, `tests/os/honesty.test.ts` |
| Evidence | `screenshots/uiux-v3/` — 60 captures + `report.json` |

---

## 14. Next step

Owner review. Nothing here has been committed, merged or deployed; no migration was
created; no feature flag was enabled; no hosted or production system was contacted.
