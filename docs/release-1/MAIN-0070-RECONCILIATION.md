# Main's manually-applied `0070` — disposition

**Verdict: `0070_identity_backfill_and_event_lifecycle.sql` is SAFELY IDEMPOTENT and a CLEAN NO-OP
against the already-repaired database. The safe action is to let the runner apply it normally. No
ledger row should be hand-inserted.**

That is not a reading of the SQL. It was rehearsed against the exact reported production shape on a
disposable database — scenario 4 of `scripts/hosted/integration-rehearsal.mjs` — and the rows were
counted before and after.

## The state this is about

`fd41d30` records it:

> The repair … was applied to production, but **not by the migration runner**, and the
> `schema_migrations` ledger therefore still shows **0069 as the last applied version**.

So production is: ledger at 69 rows / high-water `0069`; main's `0070` **effects present**; **no
`0070` ledger row**. `migrate:status` reports `0070` pending, and that report is accurate — the SQL
has not executed.

## 1. Read-only predicates proving the repair's effects

Run these against production. Every one is `select` only; none writes, and none needs elevated
privileges beyond reading the tables.

```sql
-- A1/A2 — every profile has an identity row and a membership in its own company
select count(*) as profiles_without_users
  from profiles p where not exists (select 1 from users u where u.id = p.id);

select count(*) as profiles_without_membership
  from profiles p
 where not exists (select 1 from memberships m
                    where m.user_id = p.id and m.company_id = p.company_id);

-- A3 — everyone submits; every admin also administers
select count(*) as memberships_without_submitter
  from memberships m
 where not exists (select 1 from membership_roles r
                    where r.membership_id = m.id and r.role_key = 'staff_submitter');

select count(*) as admins_without_admin_role
  from memberships m join profiles p on p.id = m.user_id and p.company_id = m.company_id
 where p.is_admin
   and not exists (select 1 from membership_roles r
                    where r.membership_id = m.id and r.role_key = 'system_administrator');

-- A4 — a deactivated profile keeps no active membership
select count(*) as suspended_profile_with_active_membership
  from memberships m join profiles p on p.id = m.user_id and p.company_id = m.company_id
 where p.is_active = false and m.status = 'active';

-- B — no WhatsApp source event the database can prove was handled is still open
select count(*) as provably_handled_but_open
  from source_events se
  join wa_messages wm on wm.wa_message_id = se.provider_message_id
   and wm.direction = 'inbound' and wm.handled_at is not null
 where se.source = 'whatsapp' and se.status in ('received','processing');

-- C — nothing is authored by a company
select (select count(*) from management_cases mc
         where mc.created_by is not null
           and exists (select 1 from companies c where c.id = mc.created_by)) as cases_authored_by_company,
       (select count(*) from tasks t
         where t.created_by is not null
           and exists (select 1 from companies c where c.id = t.created_by))  as tasks_authored_by_company;

-- The ledger itself
select count(*) as rows, min(version) as lo, max(version) as hi from schema_migrations;
select exists (select 1 from schema_migrations where version = '0070') as has_0070_row;
```

## 2. Expected state

| Predicate | Expected if the repair landed |
|---|---|
| `profiles_without_users` | **0** |
| `profiles_without_membership` | **0** |
| `memberships_without_submitter` | **0** |
| `admins_without_admin_role` | **0** |
| `suspended_profile_with_active_membership` | **0** |
| `provably_handled_but_open` | **0** |
| `cases_authored_by_company`, `tasks_authored_by_company` | **0** |
| ledger | **69 rows, `0001`–`0069`** |
| `has_0070_row` | **false** |

`fd41d30` also states what the repair did: 5 `users` + 5 `memberships` + 5 role grants created, all
8/8 staff holding a complete identity, 14/14 `source_events` moved `received → processed`,
3 `management_cases` and 7 `tasks` un-authored.

## 3. The safe action: run it. It is idempotent by construction

Every statement is self-limiting, and the limit is in the statement rather than in a comment:

| Statement | Why re-running changes nothing |
|---|---|
| A1 `insert into users … where not exists` | the row is there, so the `where` selects nothing |
| A2 `insert into memberships … where not exists` | same, and `unique (company_id, user_id)` backs it |
| A3 `insert into membership_roles … on conflict do nothing` | duplicates are discarded by the index |
| A4 `update memberships set status='suspended' … and m.status='active'` | already `suspended`, so no row matches. **One-way by design**: it suspends, never re-activates |
| B `update source_events … where status in ('received','processing')` | already `processed`, so no row matches |
| C `update … set created_by = null … where created_by is not null` | already null, so no row matches |

**Rehearsed, not inferred.** Scenario 4 built a database at `0069`, seeded the four defect shapes,
applied main's `0070` exactly as the REST applier did (effects, no ledger row), then ran the release
process:

```
defects before the manual repair : profiles_without_users 2, without_membership 2,
                                  suspended_but_active 1, company_authored_tasks 1
after the manual repair          : all 0   — memberships 3, role grants 4, users 3
ledger after the manual repair   : 69 rows, high-water 0069      ← the production shape
release run                      : 74 applied, INCLUDING main's 0070
after the release run            : all 0   — memberships 3, role grants 4, users 3
ending ledger                    : 143 rows, high-water 0143, no duplicates
```

Counts identical before and after: **nothing duplicated, nothing corrupted, nothing partial.**

### The one semantic difference, stated rather than glossed

Re-running is a no-op *with respect to the rows the REST applier already repaired*. It is **not** a
no-op with respect to the world. Statements B and C are defined by a predicate, not by a row list,
so if any NEW row has become eligible since the repair — a WhatsApp event handled but still open, a
case authored by a company id — the migration will repair that too.

That is the migration doing its stated job, and it is why this is the safe option. But it means
"clean no-op" is a claim about the repaired rows, not a promise that zero rows will change.

## 4. Risks of each option

| Option | Risk |
|---|---|
| **Run the migration normally (recommended)** | Low. Idempotent per the table above and rehearsed against the production shape. It may repair newly-eligible rows, which is correct behaviour and should be expected rather than treated as drift |
| Hand-insert a `0070` ledger row | **Unsafe, and specifically rejected.** It asserts the SQL ran when it did not. If ANY statement's effects are incomplete — one profile the REST applier missed, one event it could not see — the gap becomes permanent and invisible, because the runner will never look at `0070` again. `fd41d30` says the same: *"Do not hand-insert the ledger row."* |
| Amend the migration to be "more idempotent" | Unnecessary and worse. It is already idempotent, and editing a data repair that has already executed against production makes the file stop describing what was done |
| Skip it with `MIGRATE_UPTO` | Leaves a permanent hole. Every later run still reports `0070` pending, and the next operator has to rediscover this whole question |

**A ledger row is not harmless.** It is the only record that a migration ran, and inserting one by
hand converts "we believe this was applied" into "the system will never check again".

## 5. Rollback requirements

`0070` is a data repair with **no schema change**, so there is nothing to roll back structurally
and no `src/db/rollback/0070_*.down.sql` exists — correctly.

Its A4 and C statements are **destructive in one direction**: A4 suspends memberships, C nulls
`created_by`. Neither is recoverable from the database alone. Reversal requires a **pre-apply
backup**, which is why the production plan's step 1 is a verified restore and not merely a backup.

For production this is already academic: the effects landed on 2026-09-11 over REST. The
pre-apply snapshot that exists is `pre-0070-backup-20260911T030401Z.json` (29 KB, seven tables),
recorded in `abc8c05`. **That is a targeted REST snapshot, not a `pg_dump`** — it covers the seven
tables the repair touched and nothing else, so it is sufficient to reverse *this* repair and is not
a database backup.

## 6. The separate approval required

Nothing here may be executed against production without its own approval. Specifically:

1. **Running `npm run migrate` against production** — even though `0070` is idempotent, the same
   command applies `0071`–`0143`, which is 73 further migrations including the whole management
   kernel. That is a deployment, not a reconciliation.
2. **Any hosted write at all**, including the read-only predicates above if a reviewer would prefer
   them run by an operator rather than by this process.
3. **Establishing a backup path first.** The repair was done over REST *because there was no IPv6
   route and `pg_dump` was impossible from that machine*. Until a `pg_dump`-capable path exists
   and a restore has actually been performed into an isolated database, the production plan's step
   1 is unsatisfied and nothing after it may begin.

## 7. Recommendation

Run the predicates in §1 read-only. If they return the expected state in §2, take **option 1**:
let the runner apply `0070` in its normal place at the head of the pending range, inside the
authorised production deployment, after the backup precondition is met. Do not touch the ledger.
