# PERMISSION_MODEL.md

**Status:** Phase 0 deliverable — for review. Master spec §6, §23. Implemented Phase 1.

## 1. Model

Three layers, all deterministic:

1. **Company scope** (`company_id`) — the isolation boundary, enforced by RLS.
2. **Role** — a named bundle of permissions per company (`roles`, `role_permissions`).
3. **Action permission** — the granular verb on a resource.

Least privilege: a user has only the permissions explicitly granted to their role(s)
within their company scope.

## 2. Action verbs (separated per spec §6)

`view`, `create`, `edit`, `approve`, `post`, `export`, `delete`, `administer`,
`access_sensitive_media`. Separating `approve`/`post` from `create`/`edit` is what
makes human-in-the-loop enforceable (you can create a payment record without being
able to approve or post it).

## 3. Pilot roles (starting point — configurable)

| Role | Typical permissions |
|---|---|
| `owner_admin` | administer + all verbs within the company |
| `manager` | view/create/edit tasks, projects, employees; approve within authority limits; view finance (read) |
| `finance` | view/create/edit/approve/post-draft for expenses & QuickBooks drafts; export; MFA required |
| `employee` | view/create/edit own tasks, time, evidence, expenses; no approve/post |

Roles are per-company rows, not global enums, so different companies can differ.

## 4. Enforcement points

- **DB (RLS):** company scope +, where useful, row ownership.
- **Service:** every function receives an auth context `{ user_id, company_id, roles,
  permissions }` and checks the required action verb before acting.
- **API:** middleware resolves the session → context; routes declare required
  permission; denies are audited (`security_events`).
- **Jobs:** carry company scope from the event; system actions are attributed to a
  system principal and audited.
- **UI:** hides unauthorised actions, but the server is the source of truth (UI checks
  are convenience only).

## 5. Relationship to authority limits

Permissions answer "may this role do this verb at all?" **Authority limits** answer
"up to what threshold / for which sensitive actions is human approval required?" —
see `AUTHORITY_MATRIX.md`. Both must pass. AI-proposed sensitive actions always route
to the approval queue regardless of the proposing principal's permissions.

## 6. Tests (Phase 1 gate)

Permission matrix (role × verb × resource), denial auditing, RLS company isolation,
privilege-escalation attempts fail, `approve`/`post` cannot be exercised by
`employee`, MFA required for finance/admin.
