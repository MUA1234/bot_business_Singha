# Operational runbooks — WP E

> Referenced by the alert engine (`src/management/ai-manager/alerts.ts`) and the health
> endpoint (`/api/health`). Each alert carries its `owner` and a link to the anchor below.
> The health endpoint is CRON_SECRET-gated: `GET /api/health` with `Authorization: Bearer $CRON_SECRET`.

## ledger-imbalance
**Owner:** finance-oncall. **Signal:** `ledger_integrity_report` returns a nonzero count
(imbalanced lines, header≠lines, orphaned lines, or a posting in a locked/closed period).
1. `GET /api/health` and read `ledgerIntegrity.issues`.
2. Run `select * from public.ledger_integrity_report(<company>)` to scope it.
3. Never edit posted rows. Correct via a controlled reversal (`reverse_journal`) + re-post.
4. A locked-period posting indicates a period was locked after a post — investigate the
   posting's `correlation_id`/`idempotency_key` in `audit_events`.

## dead-letters
**Owner:** platform-oncall. **Signal:** `dead_letter_events` count > 0 or outbox rows in
`dead`.
1. Inspect the dead rows (admin Outbox screen / `message_outbox where status='dead'`).
2. Fix the root cause (bad recipient, template, provider outage).
3. Replay via the audited admin replay (`replayReset` → status back to `pending`); the
   drain worker re-attempts. Replays are audited.

## failed-events
**Owner:** platform-oncall. **Signal:** `source_events` in `failed`.
1. `GET /api/health` → `metrics.sourceFailed`.
2. The Inngest consumer retries with backoff then dead-letters; check Inngest run history.
3. Re-drive after fixing the cause; idempotency keys make re-processing safe.

## outbox
**Owner:** platform-oncall. **Signal:** `outboxFailed`/`outboxDead` > 0, or oldest pending
age growing (>15m warn, >60m crit).
1. Confirm the WhatsApp sender env (`WHATSAPP_ACCESS_TOKEN`, phone id) and Meta status.
2. The drain runs on the Inngest `outbox-sweep` (every ~2 min) and recovers expired leases.
3. If the sweep is not running, verify the Inngest app is connected; the daily Vercel
   heartbeat is only a coarse fallback.

## ai-gateway
**Owner:** platform-oncall. **Signal:** repeated AI failures.
1. Check the AI gateway/model access and cost ledger.
2. Per-company rate limits / circuit breakers throttle spend — confirm they are not
   tripped unexpectedly.
