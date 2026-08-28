# Hard-scenario campaign — environment and provider isolation

**Tested SHA:** `d65c502c565e5dee50840172b456966eca2bf1f5`
**Branch:** `claude/hard-scenario-testing` (created from the pushed UI/UX V3/V4 checkpoint
`claude/uiux-v3-v4-checkpoint`, same SHA)

## Local stack

Everything is disposable, loopback-only, and created for this campaign.

| Component | Image / process | Address | Purpose |
|---|---|---|---|
| PostgreSQL 16 | `postgres:16` (`singha-hst-pg16`) | `127.0.0.1:55442` | `singha_app` (app stack) and `singha_hst` (headless integration) |
| GoTrue | `supabase/gotrue:v2.196.0` | `127.0.0.1:55444` | REAL authentication; migrations confined to the `auth` schema |
| PostgREST | `supabase/postgrest:v16.1` | `127.0.0.1:55445` | REAL data API and RLS enforcement, via an `authenticator` role |
| Gateway | `scripts/hard-scenario/local-supabase-gateway.mjs` | `127.0.0.1:54321` | Stands in for Kong: `/auth/v1`→GoTrue, `/rest/v1`→PostgREST. Forwards verbatim; rewrites nothing but the path prefix |
| Application | `next start` | `127.0.0.1:3241` | The real built application |

Schema: the Supabase compatibility shim (`tests/integration/helpers/supabase-shim.sql`)
followed by all **108** migrations, applied cleanly to a fresh database.

`auth.uid()` is the PostgREST-compatible `request.jwt.claims` form. GoTrue installs a
legacy `request.jwt.claim.sub` variant during its own migration, so the shim is applied
**after** GoTrue and restores the correct one. Verified in the running database.

## What is real, and what is substituted

**Real:** the application build, every page and route handler, authentication (GoTrue
issues genuine JWTs), authorisation (PostgREST + Postgres RLS), the database and all
its functions, triggers and constraints.

**Substituted:** exactly two things — the HTTP gateway (a path-prefix router in place of
Kong) and the external provider adapters (deterministic local mocks). No application
API, authorisation check or business rule is replaced or weakened anywhere.

## Provider isolation — three independent layers

1. **Configuration.** Every provider variable is overridden at process start with a
   non-secret test value: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (empty),
   `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
   `VAPID_PUBLIC_KEY`, plus the Supabase URL/keys pointed at the local gateway.
   `WHATSAPP_ASYNC=off`.

2. **Outbound network guard** (`scripts/hard-scenario/net-guard.cjs`, loaded via
   `NODE_OPTIONS=--require`). Patches `net.Socket.prototype.connect` and `dns.lookup`
   so any non-loopback connection fails closed with `EHSTNETGUARD`. This makes isolation
   a property of the process, not of an env audit being exhaustive — a credential
   arriving from a source nobody enumerated still cannot be used.

3. **Port isolation.** The campaign server runs on **3241**. An unrelated process owns
   3230; it is outside this campaign, was not used, not inspected and not terminated.

### Verification performed before any scenario ran

```
blocked: https://graph.facebook.com/v20.0/me   -> EHSTNETGUARD   (WhatsApp Cloud API)
blocked: https://api.openai.com/v1/models      -> EHSTNETGUARD   (OpenAI)
blocked: https://api.anthropic.com/v1/messages -> EHSTNETGUARD   (Anthropic)
loopback allowed: gateway -> 200
```

Application-level checks on `127.0.0.1:3241`:

- `/login` → 200
- `/app` unauthenticated → 307 to `/login?next=%2Fapp` (fail-closed)
- `/dev/design-lab` → 200 with the flag on in development; the same route returns 404
  where the flag is off, so the gate demonstrably works in both directions
- Security headers present; `Strict-Transport-Security` and `upgrade-insecure-requests`
  correctly **absent** on a plain-HTTP local origin
- A real sign-in as `fixture.owner` through the real form reached `/app/admin`. Every
  browser request went to `127.0.0.1:3241`; **zero** external requests were made and the
  guard recorded **zero** blocked attempts during normal operation.

No hosted Supabase host is baked into the built bundle (the `*.supabase.co` strings
present are a library wildcard allowlist, not a project URL).

## Credential handling

`.env.local` exists in the working tree. It was **not** read, printed, copied, modified
or renamed at any point. It is not referenced by this campaign; the isolated environment
is supplied entirely from non-secret values, and the network guard is the backstop. No
credential value appears in any command, log, screenshot, report or commit.

## Seeded tenants

| Tenant | Company | Users (real GoTrue) |
|---|---|---|
| A | `FIXTURE — Northwind Placeholder (Pvt) Ltd` | owner, finance, staff, sales |
| B | `FIXTURE-B — Southgate Placeholder (Pvt) Ltd` | owner, finance, staff |

Tenant B exists so cross-company isolation can be tested against rows that genuinely
belong to another company and are genuinely readable by that company's own users.
