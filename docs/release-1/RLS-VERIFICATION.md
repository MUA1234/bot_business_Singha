# RLS verification checklist

Production was found on 2026-09-10 with `RLS_READS` and `RLS_WRITES` **both unset**. Under the
repository's `=== "on"` convention that silently means off: the application reads and writes
through the service-role client, and company separation rests on application code rather than the
database (H-2 / PR-F-012).

Owner decision 5 requires isolation enabled and **proven in isolated staging before production**.
This is what "proven" has to mean.

---

## Part 1 — what is already proven, locally

These run today on disposable PostgreSQL 16.10 and pass. They are necessary and **not sufficient**:
they prove the policies are correct, not that a deployed environment is running with them on.

| Evidence | What it establishes |
|---|---|
| `r1-security-baseline` — 39 tests | Visibility is a **capability**, not membership. An owner with `management.queue.view_company` reads; a project manager without `finance.reconcile` is **refused** a finance item; the same manager reads an `operations` item they do manage; a member with no role reads nothing |
| `r2-cross-company-attack-matrix` — 67 tests | Four actor kinds × nine write attacks on another company, each verified through a **privileged connection** to have changed nothing. Plus reads across seven surfaces, and `anon` refused outright |
| `rls-coverage`, `rls-matrix-coverage` | Every table that must carry RLS does |
| `capability-rls`, `company-isolation` | The capability join and the tenant boundary |
| `r2-authority-and-scope` — 44 tests | Delegation cannot exceed the delegator; an expired or revoked delegation confers nothing |

**Why the attack matrix is the load-bearing one.** Under RLS a write matching no row *succeeds*
and reports zero rows affected — no error. A test watching for a thrown error passes either way,
and so does one that re-reads through the attacker's own session, because RLS hides the row it
just failed to change. Only a privileged reader distinguishes "refused" from "silently allowed".
Disabling RLS on one table makes 5 of the 67 fail immediately, so the suite is not decoration.

---

## Part 2 — what staging must add

The deployment axis. None of this can be done without an environment
([STAGING-REQUIREMENTS.md](STAGING-REQUIREMENTS.md)).

| # | Check | Pass condition |
|---|---|---|
| 1 | `RLS_READS=on` and `RLS_WRITES=on` are set **explicitly** | The app starts. It now refuses to start when either is unset |
| 2 | The app reads through the **RLS-bound** client, not the service role | `supabaseServer()` on the request path; `supabaseAdmin` confined to the allowlist, which `completion-inventory --check` already enforces |
| 3 | Seed **two** companies with distinct data | One company cannot prove isolation |
| 4 | Sign in as a member of A and load every Release 1 surface | Nothing of company B appears in any list, count, total or chart |
| 5 | Re-run the cross-company attack matrix against staging | 67 pass, with the privileged census unchanged |
| 6 | A revoked membership loses access **immediately** | Suspend a membership mid-session; the next read returns nothing |
| 7 | A capability removed mid-session stops the next read | Not only at the next sign-in |
| 8 | The service role cannot be a person | It cannot record a decision, assign, or claim completion |
| 9 | Ask-AI answers within one company only | Ask about company B while signed into A — no fact leaks |
| 10 | Compare `pg_policies` on staging with the local reference | Same policy set; a missing policy in staging is a deployment defect |

---

## Part 3 — production cutover, after staging passes

**Separate owner approval.** Do not fold it into a deployment.

1. Backup and drill the restore ([RUNBOOK.md](RUNBOOK.md) §A).
2. Set `RLS_READS=on` first, alone. Reads are reversible in a way writes are not.
3. Watch for reads returning empty where they should not — that is the app running under a
   client that lacks a capability it needs, and it looks exactly like "no data".
4. Only then `RLS_WRITES=on`.
5. Re-verify with two real companies, or with one company and a synthetic second.

**Rollback:** set the switch back to `off` explicitly. It is a variable change, not a migration,
so it takes effect on restart. Do **not** unset it — unset is the ambiguous state this work
exists to remove.

---

## The honest summary

| Axis | Status |
|---|---|
| The policies are correct | ✅ proven locally, 150+ assertions |
| A privileged reader confirms attacks change nothing | ✅ proven, and proven non-vacuous |
| Absence of configuration cannot start production | ✅ enforced |
| **Any environment is running with RLS on** | ❌ **not proven — no environment has been deployed to** |
