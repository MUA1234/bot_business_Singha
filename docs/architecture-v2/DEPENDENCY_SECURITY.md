# Dependency security — WP F

## Gate

CI runs `npm run audit-check` (`scripts/audit-check.mjs`), which:
- runs `npm audit --omit=dev` (production dependencies only);
- **fails** if any high/critical appears that is not listed in
  `security/approved-audit-exceptions.json`;
- **fails** if any accepted exception is past its `review_by` date;
- passes when the only high/critical findings are current, reviewed exceptions.

This keeps CI green on reviewed/compensated risk while blocking any NEW or EXPIRED
high/critical finding. `npm audit fix --force` is never used (it pulls a Next.js major).

## History

- `brace-expansion` (high) — fixed 2026-08-07 via non-breaking `npm audit fix` (lockfile only).

## Currently accepted exceptions (review by 2026-11-07)

| Module | Severity | Why accepted | Compensating control |
|---|---|---|---|
| `next` | high | Next 14.2.x advisories (DoS/SSRF/cache-poisoning). Fix requires next@16 — a major React 19 / App Router upgrade, out of scope for this phase. | Vercel edge mitigations; auth/capability-gated Server Actions; no attacker-controlled image domains; no custom server. |
| `postcss` | high | Build-time only; pinned transitively by next; processes first-party CSS only. Fix only via next@16. | First-party CSS at build only; no untrusted stylesheet input. |

**Planned remediation:** schedule the Next 15/16 upgrade as its own reviewed PR; both
exceptions clear with it. Re-review by the date above regardless.
