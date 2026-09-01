# 6. Target AI Management OS architecture

> This is a **target for owner approval**, not an implementation plan to begin. It is
> deliberately built from what already exists: every box below is either an existing
> component, an existing component with a defined new interface, or a small number of
> genuinely new components. Nothing working is discarded.

## 6.1 The one principle

**The AI Management OS is a single management loop with many domain adapters — not
twelve departments each with intelligence bolted on.**

Concretely, this means three architectural commitments:

1. **Domains do not own intelligence.** A domain owns its *state*, its *rules* and its
   *actions*. It exposes two contracts to the kernel: *observations it can emit* and
   *actions it can perform*. It never calls a model, never decides authority, never
   creates a case.
2. **The kernel does not own domain knowledge.** The management kernel runs the eleven
   steps generically over a typed signal. It cannot name "invoice" or "vehicle" in its
   code.
3. **Everything sensitive still goes through the existing pipeline.** Zod schema →
   deterministic authority rules → permission check → audit. The kernel makes that
   pipeline mandatory rather than conventional.

## 6.2 Layered target

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 7. EXPERIENCE                                                             │
│    Command Centre (exception-led) · department workspaces · task surfaces │
│    mobile/PWA · spatial workspace (optional shell over the same panels)   │
│    ─ renders the kernel's queues; never queries a domain table directly   │
├───────────────────────────────────────────────────────────────────────────┤
│ 6. MANAGEMENT KERNEL   ◄── the missing layer                              │
│    signal intake · context assembly · interpretation (AI gateway)         │
│    classification · recommendation · authority gate · work allocation     │
│    supervision · escalation · outcome verification · learning             │
│    ─ one implementation, domain-agnostic, driven by the case state machine│
├───────────────────────────────────────────────────────────────────────────┤
│ 5. DOMAIN SERVICES     ◄── mostly missing today (PR-F-009)                │
│    finance · work/projects · workforce · crm+sales · procurement          │
│    marketing · assets/fleet · legal/compliance · providers · governance   │
│    ─ each exposes: query(), observe(), actions[], and its authority map   │
├───────────────────────────────────────────────────────────────────────────┤
│ 4. POLICY & AUTHORITY  (exists — keep as is)                              │
│    authority-engine · delegation · approval ladder · capability matrix    │
├───────────────────────────────────────────────────────────────────────────┤
│ 3. EVENT & DELIVERY SPINE  (exists — keep as is)                          │
│    source_events (lease/retry/DLQ) · message_outbox (fenced) · scheduler  │
│    inbound adapters · dispatch state machine                              │
├───────────────────────────────────────────────────────────────────────────┤
│ 2. DATA & ISOLATION  (exists — finish the RLS cutover)                    │
│    Supabase Postgres · company-scoped RLS · composite company FKs         │
│    Accounting Core as the accounting source of truth                      │
├───────────────────────────────────────────────────────────────────────────┤
│ 1. PROVIDERS  (exists, partly branch-only)                                │
│    WhatsApp Cloud API · model gateway (budget, failover, telemetry)       │
│    email · storage · future connectors — all behind adapters              │
└───────────────────────────────────────────────────────────────────────────┘
```

## 6.3 The two contracts every domain implements

This is the whole integration surface. Small on purpose.

### Contract A — Observation source

A domain declares *what it can notice about itself*. The kernel schedules it; the domain
answers with typed, evidence-linked observations. It does not interpret them.

```ts
interface ObservationSource {
  readonly domain: string;                 // "finance" | "legal" | …
  readonly kind: string;                   // "invoice_overdue" | "licence_expiring" | …
  readonly cadence: Cadence;               // how often the kernel should scan
  scan(ctx: CompanyContext): Promise<Observation[]>;
}

interface Observation {
  companyId: string;
  domain: string;
  kind: string;
  subjectRef: { table: string; id: string };   // what this is about
  evidence: EvidenceRef[];                     // rows, documents, messages
  facts: Record<string, JsonValue>;            // structured, never prose
  detectedAt: string;
  identityKey: string;                         // for dedupe across scans
}
```

Crucially, `facts` is **structured and deterministic**. The detector says
"invoice 123 is 47 days overdue, LKR 480,000, customer X, 3 prior reminders". It does
not say "this looks bad". Interpretation is the kernel's job, and keeping it there is
what stops twelve disconnected intelligences from re-emerging.

Most of these detectors already exist as pure functions and need only to be lifted out
of pages: `renewals.ts`, `exceptions.ts`, `objective-status.ts`, `forecast.ts`, ageing,
budget-vs-actual, capacity, three-way match, `availability.ts`.

### Contract B — Action catalogue

A domain declares *what may be done to it*, with the authority each action needs. The
kernel can then propose actions without knowing what they mean.

```ts
interface DomainAction {
  readonly id: string;                  // "finance.invoice.send_reminder"
  readonly domain: string;
  readonly capability: string;          // existing capability string
  readonly authorityFloor: AuthorityLevel;
  readonly inputSchema: ZodSchema;      // validated before anything runs
  readonly reversible: boolean;
  execute(input, actor, idempotencyKey): Promise<ActionResult>;
}
```

Existing server actions are already close to this: they validate with Zod, check
`requireDepartment`/capability, write audit. Registering them, rather than rewriting
them, is the bulk of the work.

**Safety property preserved:** the AI may only ever *select from* this catalogue and
*fill a validated schema*. It can never invent an action, and free-text model output
never reaches business state — which is `CLAUDE.md`'s absolute rule.

## 6.4 Sales as a managed subsystem

Sales stops being the product and becomes one domain implementing the same two
contracts:

| Sales asset today | Target role |
|---|---|
| WhatsApp webhook, signature verification | Layer 3 — a **channel adapter**, shared by every domain |
| `order-intake.ts`, quotation flow, price confirmations | Sales domain service (layer 5) |
| `message_outbox` + drain | Layer 3 — the OS-wide outbound delivery spine |
| Quotation AI (`src/ai/quotation.ts`) | A domain-scoped model use, routed through the model gateway and the cost ledger (closes OF-011) |
| Price-confirmation routing to a department | An instance of the kernel's generic allocation, not a bespoke path |
| Lead scoring, pipeline value | Sales observation sources |

Nothing in sales is deleted. It is **re-parented**: the pieces that are actually
infrastructure (channel, outbox, identity) move down into shared layers, and what
remains is a normal domain of comparable weight to finance or procurement.

## 6.5 What is genuinely new

Only five things. Everything else is refactoring or wiring.

| New component | Why it cannot be avoided | Replaces / closes |
|---|---|---|
| **Management kernel** (`src/kernel/`) | The loop currently exists as two ad-hoc call sites | PR-F-006 |
| **Observation scheduler + registry** | Nothing scans internal business state today | PR-F-006, loop step 1 |
| **Work allocation service** | Nothing proposes an assignee | PR-F-008, OF-008, WRK-005 |
| **Outcome & learning store** | Step 11 does not exist | PR-F-007, AIM-008, IMP-001/2/3 |
| **Domain service layer** (extraction, not invention) | No seam for the kernel to attach to | PR-F-009 |

## 6.6 Non-negotiable constraints carried forward

Restated because the target must not be read as licence to relax them:

- **AI never executes.** It observes, interprets, classifies and proposes. Every
  material action passes the authority ladder and, where required, a human.
- **AI never posts a material journal**, never makes a payment or transfer, never
  changes permissions, never hires/dismisses/disciplines.
- **Free-text model output never triggers a sensitive action** — only a validated
  selection from the registered action catalogue.
- **Untrusted input stays untrusted.** Messages, documents, receipts, web pages and
  external systems are data. The kernel fences them; they cannot instruct it.
- **Company scope is absolute.** Every kernel record carries `company_id`; the RLS
  cutover (OF-012) must complete so isolation is enforced by the database.
- **Gated capabilities stay gated.** GPS, CCTV, facial recognition, customer-facing AI
  agents, the agent builder and multi-country features are **out of scope** and remain
  behind legal/privacy review. The kernel must not be used as a route to build them.
- **Cost discipline.** No Redis, Kafka, queues or paid infrastructure. The kernel runs
  on the existing Postgres + scheduler + outbox spine. Model calls stay bounded by the
  existing model-gateway budget policy, and every kernel model call is metered (which
  also closes OF-011).

## 6.7 Deployment target

One origin, one scheduler, one webhook:

```
   Meta webhook ──► Railway (singha-web, persistent process)
                      ├── in-process scheduler: kernel scans, outbox drain,
                      │   follow-ups, escalation, digest
                      └── Supabase (RLS enforced, RLS_READS/RLS_WRITES on)

   Vercel ── retired, or kept as a non-webhook preview environment only
```

Plus a **staging environment** (currently absent — OPS-004 is `blocked_owner`), because
a management OS that acts on real business state cannot have its first real execution be
in production.
