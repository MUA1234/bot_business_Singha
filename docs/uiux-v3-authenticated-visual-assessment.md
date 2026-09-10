# UI/UX V3 — Authenticated visual validation & assessment

| | |
|---|---|
| Branch | `kimi/uiux-v2-spatial-workspace` |
| Date | 2026-08-27 |
| State | Working tree — **not committed, not merged, not deployed** |
| Evidence | `screenshots/uiux-v3-auth/` — 100 captures + `report.json` |

---

## 1. How the real application was rendered

**A disposable local Supabase stack, real authentication, no bypass.**

```
supabase start              → Postgres + GoTrue + PostgREST on 127.0.0.1
node scripts/migrate.mjs    → all 108 repository migrations applied
dev-fixture-seed.mjs        → one clearly-labelled synthetic company
authenticated-screenshots   → signs in through the real /login form
```

The harness holds a session GoTrue issued in exchange for a real password, exactly
as a person would. **No cookie is forged, no middleware skipped, no permission
relaxed, no `__preview` flag added.** The previous pass's decision to remove the
old bypass-cookie harness stands.

### Safety
| Guard | Effect |
|---|---|
| Loopback-only check | Both scripts refuse a non-`127.0.0.1` host — staging/production cannot be reached |
| `APP_ENV=production` refusal | The seed exits rather than run |
| Credentials from env only | Nothing embedded; passes the secret scanner |
| `FIXTURE —` prefix | Every company, person, counterparty and reference is unmistakably synthetic |

### Three roles, real entitlement
`fixture.owner` (admin), `fixture.finance` (finance_reviewer + accountant +
payment_approver), `fixture.staff` (operations). Each screen was captured as the
role that is actually entitled to it — the finance screens really were rendered
by a finance user with a finance rail.

The fixture spans 48 tables: work, projects, risks, decisions, scenarios,
people, capacity, leave, a **balanced double-entry accounting core** (15
accounts, 3 periods, 9 posted journals, 18 lines, debits = credits =
LKR 6,940,500), invoices, bills, payments, commitments, POs, approvals,
conversations, quotations, assets, governance, documents, AI runs and audit.

---

## 2. What the seed could NOT fabricate — and why that is good

Three controls refused the fixture, correctly:

| Control | Refusal |
|---|---|
| WP12 delivery boundary | A quotation may only be **created** as `draft`; `ready→queued→sent` is reachable only through the service-only atomic RPCs. The fixture cannot manufacture a "sent" quotation. |
| Append-only audit / outbox | `audit_events` refuses UPDATE; `message_outbox` rows may not be deleted by a non-owner. |
| Ledger immutability | A posted journal and its lines cannot be rewritten, so the seed posts the way the application does: draft → lines → post. |

Each was accommodated by respecting it, never by weakening it.

---

## 3. Measured results

100 captures — 25 screens × **1920×1080, 1440×900, 834×1194 (tablet), 390×844
(mobile)** — plus reduced-motion.

```
100 captures → screenshots/uiux-v3-auth
flagged: 0        horizontal overflow: none
tiny text: 0      touch targets < 44px: 0
console errors: 0 unexpected redirects: 0
captures showing real fixture records: 100 / 100
```

That last line matters: it proves each capture rendered real rows, not an empty
shell that merely failed quietly.

---

## 4. Screen-by-screen assessment

Scored against the brief's own questions.

### 1. Owner/CEO Command Centre — **strong**
Instrument (12 needing attention of 19 tracked, 6 critical) + banded brief +
change ledger, over a money band and a priority field. Every figure traces to a
row: "LKR 1,840,000 in payables is overdue" is the seeded bill.
- *Depth*: the action column now sits **28px forward** and the instrument **30px
  back** under a local perspective. Fixed this pass — previously one flat plane.
- *Dead space*: the short instrument column left a tall empty gutter. Now
  **sticky**, so it stays in view while the reader works down the brief.
- *Change ledger*: previously flooded with "Work updated — now planned" for every
  touched row. Now lists only meaningful transitions and **counts the rest**
  ("2 other records were updated").
- *Remaining*: the ring still carries four hues. Honest, but the most
  chart-like element on an otherwise restrained screen.

### 2. AI Manager / AI operations — **strong**
Authority boundary stated before any figure. Real `ai_runs` telemetry: 7 runs,
$0.0788, 5 validated, 2 rejected. Gated capabilities named as not-built.
The presence collapses to an orb and expands on hover/focus.

### 3. Approval / decision focus — **strong (and now functional)**
Consequence leads at display scale; authority stated in words; approval is
explicitly not payment. **The Approve/Reject controls now render** — see §5,
defect 3. Where a reader may not act, the reason is given in English rather than
the policy layer's `"actor is not an approver"`.

### 4. Work command centre — **good**
Constellation grouped by what decides the next action, with List and Board one
control away. Real tasks, real blockers.

### 5. Task workspace — **good**
Opens with the objective, then state, evidence, check-ins. Evidence renders as
paper sheets, not glass cards.

### 6–7. Projects & Project command room — **strong (and now correct)**
Condition strip (state · stuck work · open risks · budget), then money, forecast
curve, resources, risks, decisions, scenarios. Budget vs actual now reads
**LKR 2,600,000 budgeted / 1,936,000 actual / −664,000 variance / "Within
budget"** — every one of those numbers was zero or inverted before this pass
(§5, defects 4 and 5).

### 8–9. Workforce & Capacity — **strong**
Organisation constellation by department, workload from the capacity engine.
Depth is visible: the critical capacity matter is raised with a red edge; the
leave matter sits back. No performance rating anywhere — as §23 requires.

### 10–13. Finance & accounting — **good**
Control room leads with position, then exceptions, then ageing, then the whole
module index as rows rather than a card wall. **The trial balance is now a real
dense table** — monospace codes, account names, type badges, right-aligned
tabular amounts, em-dash for the empty side, sticky header, "Balanced" signal.
This directly answers "dense accounting remains highly usable": yes.

### 14–16. CRM, Customer 360, Communications — **good**
Relationship field by conversation recency and whether it waits on us.
Three-layer conversation: people / thread / context. Ours-vs-theirs is
distinguished by side, ground *and* a written attribution — never a green bubble.

### 17. Calendar & commitments — **strong**
28 dated commitments assembled from 8 record types, 7 missed, 0 undated —
and the undated count is reported rather than hidden.

### 18. Documents — **good**
Governing documents as paper sheets with unmissable draft/expired states;
evidence files with honest scan state ("pending" is never shown as clean).

### 19. Asset control tower — **good**
Fleet as a constellation by recorded state; compliance alerts. States plainly
that location, telemetry and utilisation are **not available** rather than
estimating them.

### 20–22. Risk, Health, Audit — **strong**
Health reuses the condition instrument over the `Metric` contract, so an
unreadable probe says "could not be read — this is not a zero". Audit
distinguishes human / system / AI by provenance rule, not badge colour alone.

### 23. Employee cockpit — **strongest mobile screen**
"What should I do next?" answered with one raised matter, its facts, and why it
is theirs. The bottom bar adapts to the staff user's own entitlement.

### 24–25. Procurement, Admin — **good**
Position, then exceptions, then a grouped index of the whole area.

---

## 5. Defects found by rendering the real application

Five were **pre-existing and material**; four were mine. All are fixed, all have
regression tests.

### 1. `useActionState` imported from React 18.3 *(pre-existing)*
A React 19 API. The build emitted "Attempted import error" and the
duplicate-review decision form was dead at runtime — on the screen whose only
purpose is letting a human resolve a paused payment.
**Fixed:** `useFormState` + a `DecisionButtons` child so `useFormStatus` reports
the real pending state (calling it in the component that renders `<form>` always
returns false, leaving the buttons live during submission).

### 2. `upgrade-insecure-requests` broke every plain-HTTP deployment *(pre-existing)*
Not the redirect, as I first assumed — the **CSP**. The directive makes the
browser rewrite every same-origin navigation and prefetch to `https://`, which
fails with `ERR_SSL_PROTOCOL_ERROR` on `http://127.0.0.1`. It made local
end-to-end verification impossible.
**Fixed:** it and HSTS are emitted only for an HTTPS deployment, and the test is
**fail-safe** — `APP_ENV=production` alone switches them on, so a deployment that
forgets `APP_BASE_URL` keeps them.

### 3. Ambiguous PostgREST embeds — **no approval could ever be granted** *(pre-existing, systemic)*
Composite tenant-integrity foreign keys `(child_id, company_id) → parent(id,
company_id)` sit alongside the original single-column keys, so **42 parent/child
pairs** now carry two relationships. PostgREST cannot choose a join path and
refuses with *"Could not embed because more than one relationship was found"* —
returning an **error with `data: null`**. Call sites read null as "nothing here"
and rendered empty, confident, wrong screens:

| Embed | Consequence |
|---|---|
| `memberships → membership_roles` | `getApproverForUser` returned null for **every** user. Every finance approver was told "you are not an approver". **No approval could be granted through the UI at all.** |
| `journal_entries → journal_lines` | Every project and budget "actual" read **zero** |
| `tasks → task_assignments` | Every project reported **no assigned staff** |

**Fixed** via `src/lib/embeds.ts` — separate keyed queries that cannot become
ambiguous when another key is added. Verified live: the approve/reject controls
now render, and project actuals now read LKR 1,936,000.

**The unit test had been asserting a shape the database never returns** — the
mock supplied the embedded row PostgREST refuses to produce, so the suite passed
while the feature was broken. The mock now models real behaviour.

**Still outstanding** (same class, outside the screens under review, reported not
fixed): `campaigns → audiences` on the marketing campaigns screen, and two
embeds in the follow-ups cron (`memberships!inner`, `tasks!inner`). A schema-wide
audit is warranted.

### 4. Budget variance sign inverted *(pre-existing + mine)*
`variance = actual − budgeted`, so a **positive** variance is overspend. Three
places treated a leading minus sign as "over budget", marking every under-spent
project and budget line as a problem and every overspend as healthy.
**Fixed** in the project condition strip, the per-period forecast column and the
budget-detail screen.

### 5. Approval count off by one *(mine)*
`remaining` includes the reader's own approval, so "1 more needed after yours"
told a sole approver someone else still had to sign. **Fixed** — it now says
"Yours is the last approval required".

### Smaller fixes
- AI presence collided with right-aligned section captions → collapses to an orb
- Mobile action row clipped its last button → wraps to its own line
- `.views` controls 34px, `.btn.sm` 42px wide, legend rows 43px → all ≥44px
- A select collapsed to 26px on mobile → `min-width: 9ch`
- Plural grammar on fleet and calendar
- Raw UUID shown to approvers → last-8 reference (leading chars collide)

---

## 6. Against the brief's questions

| Question | Verdict |
|---|---|
| Important matters physically come forward | **Yes** — matter bands raise critical items; the Command Centre action column sits forward of the summary under a real perspective |
| Secondary information recedes | **Yes** — `done` band drops to 50% opacity and loses its shadow; the instrument column sits back |
| AI presence integrated, not a mascot | **Yes** — a champagne orb that breathes, names the current screen, and recedes when unused |
| Command centre hierarchy understandable in <5s | **Yes** — title → count → critical count → banded brief |
| Departments have distinct compositions | **Partly** — Finance/People/CRM/Assets each lead with a different dominant object, and the environment relights per domain. Several finance sub-screens still share one table-plus-stats shape |
| Glass treatment not repetitive | **Mostly** — five materials in use; paper for evidence is doing real work. The `.card` glass still carries most surfaces |
| Not walls of rounded cards | **Yes** — module indexes are rows; sections are rules and labels |
| Typography and negative space carry hierarchy | **Yes** — 300-weight display, uppercase micro-labels, tabular numerals |
| Dense accounting/forms usable | **Yes** — verified on a real posted ledger |
| Touch interactions strong | **Yes** — 0 targets under 44px across 100 captures; phone bar with a full destination sheet |

---

## 7. Honest limitations

- **One company.** Multi-company switching is not exercised; the strip shows the
  single fixture company.
- **Local Postgres, not hosted Supabase.** RLS policies are the real ones from
  the migrations, but `RLS_READS`/`RLS_WRITES` remained default-off.
- **No interaction flows captured** beyond command palette and AI room —
  approving a payment end-to-end was not driven, only rendered as available.
- **Finance sub-screens** (journals, receivables, P&L, balance sheet) inherit the
  material system but keep their original composition.

---

## 8. Verification

```
npm run verify   ✅ secret-scan · migration-lint (108, no new) · inventory
                 ✅ audit-requirements · ip-boundary · typecheck
                 ✅ 179 test files / 1291 passed | 2 skipped
npm run build    ✅ compiles, no import errors
npm run lint     ✅ 3 pre-existing <img> warnings only

authenticated-screenshots  100 captures · 0 flagged · 0 overflow
os-screenshots (public)     60 captures · 0 flagged · 0 overflow
```

Test count moved 1254 → 1291. New: `tests/os/runtime-regressions.test.ts` (10),
`navigation` (7), `honesty` (18) plus the corrected approver mock.

---

## 9. Figma / Spline

Neither was used to produce anything in this work. Every surface described above
is hand-authored CSS/SVG, and that stands as the production foundation.

**Both MCP servers have since appeared in this session's tool list** (Figma, and
Spline/Hana 2D + 3D). They arrived after the work above was finished and were not
used for any of it. Per the standing instruction they are worth a *selective*
exploration — Owner Command Centre, AI Manager room, Project Command Room, Asset
Control Tower — to test whether those four can be materially improved beyond the
current 2.5D implementation. That exploration has **not** been started, and
should not create a parallel frontend architecture.

---

## 10. Gated capabilities — unchanged

GPS/location, CCTV, facial recognition, autonomous agents and the agent builder
remain **not built** and are named as gated on `/app/ai` and the fleet screen. No
backend capability was enabled to make a screen look complete.

---

## 11. Next step

Owner review of the screenshots. Nothing has been committed, merged or deployed;
no migration was created; no flag enabled; no hosted system contacted.
