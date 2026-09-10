# UI/UX V2 — Staging / Preview Handoff

This document records the owner-approved separate Supabase staging project and
Vercel Preview environment for branch `kimi/uiux-v2-spatial-workspace`.

## Owner conditions

- Staging/preview only; never production.
- Synthetic test companies, users, tasks, alerts, finance records and assets only.
- No production data or production credentials in repository files.
- Secrets entered directly into Supabase and Vercel platform settings, never in chat.
- Migrations applied only to the new staging database.
- Production feature flags remain OFF.
- Seed owner/CEO, manager and ordinary staff test accounts.
- Run role and tenant-isolation verification.
- Capture authenticated spatial workspace at 390px, 768px, 1440px and a large touchscreen resolution.
- Capture focus window, floating module windows, SpatialDock, incoming task/alert rail,
  command palette, docking, resizing, reduced-motion mode and mobile fallback.
- Produce a short interaction recording if browser tooling supports it.
- Run all staging acceptance tests and document rollback/removal steps.
- Stop for visual approval before any merge or production action.

## Current branch state

| Item | Value |
|---|---|
| Branch | `kimi/uiux-v2-spatial-workspace` |
| Final SHA | `a5bf155cfccf5fc86025860d9ca6293bd4454fd0` |
| Status | Clean working tree; already committed and pushed |
| Vercel project | `singha-central-uiux-v2-staging` (scope `singha4`) |
| Vercel CLI scope | `singha4` |
| Supabase CLI auth | **Not authenticated** — blocks project creation |

## What was added for staging

| File | Purpose |
|---|---|
| `scripts/verify/staging-seed.mjs` | Seeds owner + manager + staff, finance records and fleet assets for the staging database. |
| `tests/spatial/staging-acceptance.test.ts` | Verifies role capability filtering and tenant isolation against the seeded database. Skips when no staging credentials are configured. |
| `scripts/verify/spatial-screenshots.mjs` | Updated to optionally capture the manager role and use `staging-seed.mjs` when `SPATIAL_SCREENSHOT_MANAGER_PASSWORD` is set. |

## Required environment variables

### For seed / screenshot / acceptance tests

```text
SPATIAL_SCREENSHOT_SUPABASE_URL=<new-staging-project-url>
SPATIAL_SCREENSHOT_ANON_KEY=<new-staging-anon-key>
SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY=<new-staging-service-role-key>
SPATIAL_SCREENSHOT_OWNER_PASSWORD=<long-random-password>
SPATIAL_SCREENSHOT_MANAGER_PASSWORD=<long-random-password>
SPATIAL_SCREENSHOT_STAFF_PASSWORD=<long-random-password>
```

### For Vercel Preview deployment

```text
NEXT_PUBLIC_SUPABASE_URL=<new-staging-project-url>
SUPABASE_URL=<new-staging-project-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<new-staging-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<new-staging-service-role-key>
NEXT_PUBLIC_SPATIAL_WORKSPACE=on
RLS_READS=off
RLS_WRITES=off
WHATSAPP_ASYNC=off
APP_ENV=staging
```

## Provisioning checklist

1. **Authenticate Supabase CLI** (owner action):
   ```bash
   npx supabase login
   ```

2. **Create/link the staging Supabase project** (owner action):
   ```bash
   npx supabase projects create singha-central-uiux-v2-staging --org-id <org> --region <region>
   # or link an existing project:
   # npx supabase link --project-ref <ref>
   ```

3. **Apply migrations 0001–0108**:
   ```bash
   npx supabase db push
   ```

4. **Add Supabase secrets to Vercel Preview** (owner action, never commit):
   ```bash
   npx vercel env add NEXT_PUBLIC_SUPABASE_URL preview
   npx vercel env add SUPABASE_URL preview
   npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY preview
   npx vercel env add SUPABASE_SERVICE_ROLE_KEY preview
   ```

5. **Verify Vercel Preview env**:
   ```bash
   npx vercel env ls singha-central-uiux-v2-staging
   ```

6. **Deploy branch to Preview**:
   ```bash
   npx vercel --target=preview --project=singha-central-uiux-v2-staging
   ```

7. **Seed the staging database**:
   ```bash
   # Set the required env vars first, then:
   node scripts/verify/staging-seed.mjs
   ```

8. **Run staging acceptance tests**:
   ```bash
   # With env vars set:
   npx vitest run tests/spatial/staging-acceptance.test.ts
   ```

9. **Capture authenticated screenshots**:
   ```bash
   BASE_URL=https://<preview-url> node scripts/verify/spatial-screenshots.mjs
   ```

10. **Run final verification**:
    ```bash
    npm run verify
    npm run lint
    npm run build
    npm run browser-check
    npx vitest run tests/spatial/
    ```

## Rollback / removal steps

### Remove Vercel Preview project

```bash
npx vercel project remove singha-central-uiux-v2-staging
```

This removes the project and all Preview deployments.

### Remove Supabase staging project

1. Open the Supabase dashboard, select the staging project.
2. Go to Project Settings → General.
3. Click **Delete project** and confirm the project name.
4. Optionally remove the linked local config:
   ```bash
   rm -f supabase/config.toml
   ```

### Remove seeded data without deleting the project

```bash
# Set env vars pointing at the staging project, then run:
node -e "
import { createClient } from '@supabase/supabase-js';
const url = process.env.SPATIAL_SCREENSHOT_SUPABASE_URL;
const key = process.env.SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY;
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const companyId = '00000000-0000-0000-0000-00000000515a';
await sb.from('journal_lines').delete().neq('id', '00000000-0000-0000-0000-000000000000');
await sb.from('journal_entries').delete().ilike('memo', 'Staging seed%');
await sb.from('vehicles').delete().ilike('registration_no', 'STAGE-%');
await sb.from('tasks').delete().ilike('title', '[screenshot]%');
await sb.from('notifications').delete().ilike('title', '[screenshot]%');
"
```

## Gating blocker

Supabase CLI is not authenticated in this session. The Vercel project and Preview
env vars are prepared, but the Supabase project cannot be created or linked until
`npx supabase login` has been run by the project owner.

Once authenticated, the remaining steps can proceed autonomously.

## Stopping rule

No merge, deploy to production, hosted migration application, feature-flag enablement,
RLS change, financial-control change, provider contact, or use of real business data is
performed without explicit owner visual approval.
