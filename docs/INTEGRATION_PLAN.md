# INTEGRATION_PLAN.md

**Status:** Phase 0 deliverable — for review. Master spec §21.

## 1. Adapter principle

Every integration sits behind an **adapter** with: secure credentials (by reference,
never committed), permissions, health, last-sync, errors, retries, rate limits,
webhook validation, duplicate handling, reconnection, field mapping, and audit. The
adapter's only job on inbound: verify → normalise → **persist event** → enqueue
(never run business logic inline).

## 2. Pilot integrations

| Integration | Direction | Phase | Notes |
|---|---|---|---|
| Meta WhatsApp Cloud API | in + out | 7 | Reuse Sasiri webhook + sender patterns; **hard-reject** bad signatures; 24h window + templates |
| Supabase Storage | in | 9 | Receipt/file uploads → event |
| OpenAI (via gateway) | out | 3 | Not an "adapter" — the AI gateway |
| QuickBooks Online | in + out (draft) | 10 | OAuth; sandbox in staging; draft-only writes |
| Inngest | internal | 2 | Durable jobs; not external data |

## 3. Later integrations (post-pilot)

| Integration | Phase | Notes |
|---|---|---|
| Gmail / email | 11 | Authorised inbound expense/comm evidence |
| Google Sheets | 11 | Transitional staff interface, **not** primary DB (§5) |
| Google Calendar | 11 | Source for scheduled commitments |
| Bank feeds | 17 | Reconciliation inputs |
| GPS / telematics | 15 | **GATED** (privacy) |
| CCTV / NVR / VMS / access control | 16 | **GATED** (privacy) |

## 4. Existing-bot integration (§21, Phase 7)

The Sasiri sales bot keeps running in its own repo. Integration is **read/handoff**,
not merger: relevant sales/customer events can be forwarded into this platform's event
pipeline via an adapter later. The pilot only needs the **staff-update** WhatsApp
path, which reuses Sasiri's Meta Cloud API patterns. See
`MIGRATION_FROM_EXISTING_BOTS.md`.

## 5. WhatsApp specifics (ban-safety)

- Official Meta Cloud API only. Never `whatsapp-web.js` / Baileys / `venom-bot`.
- Webhook: GET verify handshake; POST verify `X-Hub-Signature-256` HMAC **before**
  processing and hard-reject on mismatch; fast 200 then enqueue.
- Respect the 24-hour customer-service window; use approved templates for
  business-initiated messages outside it.
- The WhatsApp number must be a registered WhatsApp Business number.

## 6. Health & reconnection

Each adapter reports to `integration_health` (last sync, error counts, token
expiry). Token refresh (QuickBooks) and reconnection flows are explicit. Repeated
failure raises an alert with an owner (`OBSERVABILITY.md`).
