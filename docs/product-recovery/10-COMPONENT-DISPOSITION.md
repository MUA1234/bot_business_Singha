# 10. Retain / adapt / replace / retire

> Default disposition is **RETAIN**. The owner's instruction is explicit: preserve
> working foundations. Nothing below is marked replace or retire without a stated
> reason.

## 10.1 RETAIN unchanged — the foundations

| Component | Why |
|---|---|
| Authentication, `requireAdmin` / `requireDepartment` gating | Consistent, fail-closed, verified in the hard-scenario campaign |
| RLS policy surface, capability matrix, composite company FKs | 74 tables with RLS; database-level company consistency |
| **Accounting Core** (`src/accounting/*`) | The accounting source of truth; double-entry, immutable posted journals, controlled reversals, periods, tax |
| **Authority engine** (`src/policy/*`) | Deterministic ladder, delegation, fail-closed. The kernel depends on it unchanged |
| `decide_approval`, maker/checker, SoD | Ten review loops of hardening |
| **Delivery boundary (0063–0067)** | Atomic enqueue, fenced transitions, snapshot freeze, `search_path` hardening. **Must be carried across renumbering verbatim, including its self-verifying assertions** |
| `source_events` durable intake (leases, retry, DLQ) | The template for kernel observation intake |
| `message_outbox` + drain worker | The OS-wide outbound spine |
| Idempotency: canonical fingerprints, `idempotency_keys` | Prevents duplicate tasks, receipts, payments, journals |
| Audit events and audit formatting | Required by every kernel transition |
| **Command Centre panel** | Already the right interaction model — exception-led, honest degradation |
| Health signals, ledger integrity report, `/api/health` | Monitoring foundation |
| WhatsApp adapter, signature verification, template/window handling | Official Cloud API, correct policy handling |
| Model gateway, policy router, budget policy, telemetry (branch) | Provider-neutral with failover; the kernel's only model path |
| Test suites (1365 unit / 75 integration files) and the hard-scenario harness | Substantial, and the harness proved provider isolation properly |
| Requirement register, findings register, state controller | The only register — and it is unusually honest |
| Design system, `src/components/ui`, icons, layout | Consistent and working |

## 10.2 RETAIN as the Sales subsystem

The owner asked specifically which sales components to keep. **All of them** — but
re-parented, because several are infrastructure that sales happens to own today.

| Component | Target home |
|---|---|
| `order-intake.ts`, quotation lifecycle, `quotations.ts` | Sales domain service (layer 5) |
| Price confirmations and department routing | Generic kernel allocation; the sales-specific fallback is removed |
| `src/ai/quotation.ts` | Sales domain model use — **must be routed through the gateway + cost ledger** (OF-011) |
| Leads, opportunities, accounts, customers, pipeline value, lead scoring | Sales domain service + observation sources |
| Public quote view `/q/[token]` | Retain — a working customer-facing surface |
| WhatsApp webhook + signature verification | **Move down** to layer 3 as a shared channel adapter |
| `message_outbox` + drain | **Move down** to layer 3 — OS-wide delivery |
| Customer identity / `channel_identities` | **Move down** to layer 3 — identity resolution serves every channel |

## 10.3 ADAPT — keep the logic, change the wiring

| Component | Adaptation |
|---|---|
| `renewals.ts`, `exceptions.ts`, `alerts.ts`, `priority.ts`, `forecast.ts`, `objective-status.ts`, ageing, budget-vs-actual, three-way match, `availability.ts`, capacity | Currently render to pages. **Re-expose as registered `ObservationSource`s.** Logic unchanged; tests unchanged |
| `planFromObservation` | Already correct. Extend so recommendations resolve to catalogue actions rather than free-text suggestions |
| `create_management_case_atomic` (0068) | Extend to persist the case **state machine** and its first transition atomically |
| `analyze-conversation.ts` | Becomes one observation source among many, not a primary entry point |
| `/api/cron/ai-monitor` | Becomes the generic **kernel scan scheduler**, driven by the source registry rather than hardcoded to `wa_conversations` |
| `route-captured-tasks.ts` | Becomes the department-routing step of the new allocation service |
| `follow-ups` + escalation chain | Extend from tasks to kernel cases |
| Department pages | Keep the UI; move their queries into domain services (Phase R3) |
| `scheduler.ts` | Extend `DEFAULT_JOBS` with kernel scan cadences |
| V3.1 flags | Keep the registry; **wire the six unwired flags to real slices or remove them** so a flag never implies a capability |

## 10.4 REPLACE

Few, and each for a stated defect.

| Component | Replace with | Reason |
|---|---|---|
| Migration ledger keying (`version = f.slice(0,4)`) | `(version, filename)` or content-hash keyed, fail-closed on mismatch | Silently skips a colliding migration (PR-F-001) |
| One of the two inbound company-resolution models | The channel-agnostic `channel_accounts` model, with a data migration from `companies.whatsapp_phone_number_id` | Two incompatible implementations cannot both survive (PR-F-003). Recommended direction; owner decides (D-2) |
| `routeDepartment ?? "sales"` on the branch line | `main`'s catalogue-department routing | The branch would regress a fixed production defect (PR-F-002) |
| 12 source-text test assertions | Behavioural assertions | They verify appearance, not behaviour (PR-F-013) |
| Page-level direct Supabase access (95 of 105 pages) | Domain services | No seam for the kernel (PR-F-009). **Incremental, domain by domain** — not a big-bang rewrite |

## 10.5 RETIRE

| Component | Reason |
|---|---|
| `docs/architecture-v2/RUN_*.sql`, `RUN_ALL_PENDING_MIGRATIONS.sql`, `docs/interim-accounting/ALL_MIGRATIONS.sql` | Duplicate runnable migration copies that can drift from canonical migrations. The repo's own docs flag this and the master rule forbids it |
| The second deployment origin (Vercel or Railway — one of them) | Two hosts scheduling against one database with one webhook is the cause of PR-F-005 |
| Superseded QuickBooks documentation | Already void per D-011; still present as a source of agent confusion |
| Stale claims in `CLAUDE.md` (0048–0067 "not merged", test counts) | Materially wrong (PR-F-015) |

**Explicitly NOT retired:**

- `/app/spatial` — undeployed, not dead. It is a real 21-component workspace. Its fate
  is owner decision **D-5**, not an audit judgement.
- `/app/ai` — not a shell; it reports real `ai_runs` data and honestly states what is
  not built.
- `/dev/design-lab` — flag-gated development surface, verified to 404 when off.
- `/app/finance/price-requests` vs `/app/sales/price-requests` — not duplicates;
  department-scoped views of one component.
- Inngest — configured but unused, at zero cost. Retain the option; the in-process
  scheduler covers current needs.
- Push subscriptions — persisted, nothing sends, deliberately. Retain.

## 10.6 Disposition roll-up

| Disposition | Approximate share of the system |
|---|---|
| Retain unchanged | ~60% — security, accounting, authority, event spine, delivery, tests, UI |
| Adapt (rewire, keep logic) | ~30% — detectors, department pages, AI-manager modules, schedulers |
| Replace | ~7% — data-access pattern, migration keying, one inbound model, weak tests |
| Retire | ~3% — duplicate SQL, one origin, stale docs |

**No working capability is discarded.** The recovery is predominantly re-wiring, which
is the direct consequence of the audit's central finding: the parts largely exist and
are not connected.
