# Hosted-state read-only checklist

**For the owner / developer to run against the hosted Supabase database.**
**Nothing in this document has been executed by the development process.** No agent
working in this repository has had, or should be given, hosted credentials during R0.

## Safety properties of these queries

Every statement below is a `SELECT` against **PostgreSQL catalogue and
`information_schema` metadata only**, plus the `schema_migrations` ledger (which contains
migration filenames and timestamps — deployment metadata, not business data).

* No query reads a customer, message, quotation, employee, payment or ledger row.
* No query returns column *values* from any business table — only column *names* and types.
* No statement writes, creates, alters, drops or grants anything.
* Run them as a read-only role if one is available. If you must use a privileged role,
  note that these statements still perform no writes.

Run them in the Supabase SQL editor or `psql`. **Please paste back the complete output of
each numbered block, including empty results** — an empty result is itself evidence.

---

## Q1 — Does the migration ledger exist, and what shape is it?

```sql
-- Q1a: does the table exist at all?
select
  to_regclass('public.schema_migrations') is not null as schema_migrations_exists;

-- Q1b: its exact columns.
select ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'schema_migrations'
order by ordinal_position;
```

**Why it matters.** `scripts/migrate.mjs` creates
`schema_migrations (version text primary key, filename text not null, applied_at timestamptz)`.
If the hosted table is absent, no migration has ever been applied by this runner and the
hosted schema was built some other way. If its shape differs, the runner was not the tool
that made it, and the ledger cannot be trusted as a record of what ran.

---

## Q2 — Every ledger row

```sql
select version, filename, applied_at
from public.schema_migrations
order by version;
```

**Please return the full result, not a summary.** This is the single most important
artifact in the whole checklist: it is the only direct evidence of what has actually been
applied.

---

## Q3 — Highest applied version, and the shape of the ledger

```sql
select
  count(*)                                  as rows_total,
  min(version)                              as lowest_version,
  max(version)                              as high_water,
  count(*) filter (where version >= '0069') as at_or_above_0069,
  min(applied_at)                           as first_applied,
  max(applied_at)                           as last_applied
from public.schema_migrations;
```

```sql
-- Q3b: gaps. A gap means the sequence was not applied end-to-end by the runner.
with expected as (
  select lpad(g::text, 4, '0') as version
  from generate_series(1, (select max(version)::int from public.schema_migrations)) g
)
select e.version as missing_version
from expected e
left join public.schema_migrations m on m.version = e.version
where m.version is null
order by e.version;
```

---

## Q4 — Which 0069 is on this database? **The decisive question.**

Two different migrations are numbered 0069. The ledger stores the filename, and the two
lines create disjoint objects, so both the record and the reality can be checked and
compared.

```sql
-- Q4a: what the ledger CLAIMS 0069 was.
select version, filename, applied_at
from public.schema_migrations
where version in ('0068', '0069', '0070', '0071');
```

```sql
-- Q4b: what is actually PRESENT. Object markers unique to each line.
select 'main-0069: companies.whatsapp_phone_number_id' as marker,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'companies'
           and column_name = 'whatsapp_phone_number_id'
       ) as present
union all
select 'main-0069: companies.default_price_confirmation_department',
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'companies'
           and column_name = 'default_price_confirmation_department'
       )
union all
select 'branch-0069: source_events.next_attempt_at',
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'source_events'
           and column_name = 'next_attempt_at'
       )
union all
select 'branch-0069: source_events.lease_owner',
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'source_events'
           and column_name = 'lease_owner'
       )
union all
select 'branch-0069: source_events.dead_lettered_at',
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'source_events'
           and column_name = 'dead_lettered_at'
       )
union all
select 'branch-0069: function claim_source_events',
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'claim_source_events'
       )
union all
select 'branch-0069: function fail_source_event',
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'fail_source_event'
       )
order by marker;
```

**Reading the result.** `main-0069` markers present and `branch-0069` markers absent is
the Case A pattern. Any other combination — both present, both absent, or a mixture —
means something other than a clean `main` line is deployed, and the decision tree branches
away from Case A. Do not assume; report exactly what comes back.

---

## Q5 — The two competing company-resolution designs

```sql
select 'table: channel_accounts' as object,
       to_regclass('public.channel_accounts') is not null as present
union all
select 'table: channel_identities',
       to_regclass('public.channel_identities') is not null
union all
select 'function: resolve_channel_company',
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'resolve_channel_company'
       )
union all
select 'column: companies.whatsapp_phone_number_id',
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'companies'
           and column_name = 'whatsapp_phone_number_id'
       )
order by object;
```

```sql
-- Q5b: how many companies are mapped by each design? COUNTS ONLY — no identifiers,
-- no phone numbers, no names. Skip this block if you prefer to return nothing at all
-- about company rows; it is useful for backfill sizing but is not required for the
-- numbering decision.
select
  (select count(*) from public.companies)                                        as companies_total,
  (select count(*) from public.companies where whatsapp_phone_number_id is not null)
                                                                                 as mapped_via_legacy_column;
```

---

## Q6 — Is any of the 0069–0109 range already present?

The branch range defines **27 tables, 63 functions and 56 columns**
([`03-expected-objects-0069-0109.json`](03-expected-objects-0069-0109.json) has the exact
list per migration). This block counts how many are present, so a partially-applied or
independently-built schema is detected.

```sql
with expected_tables(name) as (values
  ('ai_guide_messages'),('ai_model_attempts'),('ai_model_budget_policies'),
  ('channel_accounts'),('channel_identities'),('communication_preferences'),
  ('connectors'),('duplicate_reviews'),('funding_requirements'),('inbound_reviews'),
  ('incidents'),('insurances'),('integration_command_contracts'),
  ('integration_event_contracts'),('integrations'),('investments'),
  ('management_directive_conflicts'),('management_directives'),('project_decisions'),
  ('project_risks'),('project_scenarios'),('push_subscriptions'),('risks'),
  ('service_providers'),('task_duplicate_suggestions'),('task_routing'),
  ('task_routing_events')
)
select
  count(*)                                             as expected_total,
  count(*) filter (where to_regclass('public.' || quote_ident(name)) is not null)
                                                       as present,
  count(*) filter (where to_regclass('public.' || quote_ident(name)) is null)
                                                       as absent
from expected_tables;
```

```sql
-- Q6b: name the ones that ARE present (expected: none, under Case A).
with expected_tables(name) as (values
  ('ai_guide_messages'),('ai_model_attempts'),('ai_model_budget_policies'),
  ('channel_accounts'),('channel_identities'),('communication_preferences'),
  ('connectors'),('duplicate_reviews'),('funding_requirements'),('inbound_reviews'),
  ('incidents'),('insurances'),('integration_command_contracts'),
  ('integration_event_contracts'),('integrations'),('investments'),
  ('management_directive_conflicts'),('management_directives'),('project_decisions'),
  ('project_risks'),('project_scenarios'),('push_subscriptions'),('risks'),
  ('service_providers'),('task_duplicate_suggestions'),('task_routing'),
  ('task_routing_events')
)
select name
from expected_tables
where to_regclass('public.' || quote_ident(name)) is not null
order by name;
```

```sql
-- Q6c: the R1 kernel DRAFT track must NOT be on a hosted database.
-- Any row or table here is a finding to report immediately.
select 'ledger: r1_draft_migrations' as object,
       to_regclass('public.r1_draft_migrations') is not null as present
union all
select 'table: management_kernel_enablement',
       to_regclass('public.management_kernel_enablement') is not null
order by object;
```

---

## Q7 — Total schema size, for comparison against the repository

```sql
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE')       as tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public')                                        as functions,
  (select count(*) from pg_trigger where not tgisinternal)              as triggers,
  (select count(*) from pg_policies where schemaname = 'public')        as policies;
```

---

## Q8 — RLS enablement and policy names

Owner decision 5: tenant isolation must be enabled and proven in isolated staging before
production. This establishes the current baseline.

```sql
-- Q8a: which public tables have RLS enabled, and which force it for the owner.
select c.relname          as table_name,
       c.relrowsecurity   as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity desc, c.relname;
```

```sql
-- Q8b: summary counts.
select
  count(*)                                    as public_tables,
  count(*) filter (where relrowsecurity)      as rls_enabled,
  count(*) filter (where not relrowsecurity)  as rls_disabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r';
```

```sql
-- Q8c: policy names and the commands they cover. Definitions are included because a
-- policy expression is schema, not data — but if any policy body embeds a literal
-- identifier you would rather not share, redact it before returning this block.
select schemaname, tablename, policyname, cmd, roles, permissive
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

```sql
-- Q8d: the runtime currently reads and writes through the service role with
-- RLS_READS / RLS_WRITES off (PR-F-012). Confirm what the service role can reach
-- directly — grants only, no data.
select grantee, table_name, string_agg(distinct privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, table_name
order by grantee, table_name;
```

---

## Q9 — Extensions and search_path safety baseline

```sql
select extname, extversion, n.nspname as schema
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
order by extname;
```

```sql
-- Migration 0067 pins every application SECURITY DEFINER function to
-- `pg_catalog, extensions, public, pg_temp`. This reports any that are NOT so pinned.
select n.nspname as schema, p.proname, p.prosecdef as security_definer,
       coalesce(array_to_string(p.proconfig, ' | '), '(none)') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and (p.proconfig is null
       or not exists (
         select 1 from unnest(p.proconfig) c
         where c = 'search_path=pg_catalog, extensions, public, pg_temp'
       ))
order by p.proname;
```

An empty result is the safe answer. Rows here indicate hosted functions that predate or
diverge from 0067's hardening.

---

## What is settled once these come back

| Question | Settled by |
|---|---|
| Has any migration ever been applied by the runner? | Q1, Q2 |
| What is the true high-water mark? | Q3 |
| Which 0069 is deployed — record *and* reality? | Q4 |
| Do the record and the reality agree? | Q2 + Q4 together |
| Which company-resolution design exists on the database? | Q5 |
| Is any of 0069–0109 already present? | Q6 |
| Did the quarantined R1 draft track ever reach hosted? | Q6c |
| What is the RLS baseline for the staging proof? | Q8 |

Until Q2 and Q4 are returned, **hosted migration state is UNKNOWN** and no numbering
decision is final. See [`02-MIGRATION-DECISION-TREE.md`](02-MIGRATION-DECISION-TREE.md)
for what each possible answer implies.
