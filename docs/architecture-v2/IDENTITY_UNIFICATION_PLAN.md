# Identity Unification Plan (§5.3) — ready for owner approval

**Why gated:** Constitution §15 — this migrates material identity data. Needs a
staging DB to validate before prod. Do NOT run blind.

## Current reality (three overlapping models)

| Table | Migration | Role today |
|---|---|---|
| `users` + `user_company_access` | 0001 | RLS anchor for accounting (`has_company_access`) |
| `employees` | 0003 | Referenced by finance (`financial_events.paid_by_employee_id`, subledgers) |
| `profiles` | 0007 | App auth: username → one department + `is_admin` |

Problem: access is decided in two places; a person is three rows. No multi-company,
multi-role, or authority limits.

## Target (change plan §5.3)

`users` · `companies` · `memberships` · `membership_roles` · `role_permissions` ·
`authority_rules` · `organisation_units` · `membership_assignments` ·
`employee_profiles` · `delegations`.

One person → many companies, many departments/projects, many roles, authority limits,
temporary delegation.

## Safe cutover sequence (forward-only, §12)

1. Add new tables **alongside** old ones (no drops). RLS on all.
2. Backfill: each `profiles` row → one `membership` (+ `membership_role` from
   `is_admin`/department) + link to existing `users`/`employees`.
3. Validate on staging with ≥2 companies + several roles (isolation tests).
4. Point `getProfile()`/`requireProfile()` **reads** at memberships.
5. Point admin **writes** at memberships.
6. Freeze legacy `profiles` columns (keep, don't drop) after green.

**Each step = its own migration + tests + owner sign-off. Steps 1–2 additive/safe.
Steps 4–6 change running behaviour → approval each.**

Say go → me build step 1 (additive tables + backfill) first.
