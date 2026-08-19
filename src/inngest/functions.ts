/**
 * Inngest consumers. This is where processing continues past the webhook boundary.
 *
 * Ingestion (persist → dedup → enqueue) happens in the webhook route. This function
 * picks up the stored source event and runs the consumer pipeline
 * (`src/inngest/processing.ts`): AI extraction → missing-field detection → duplicate
 * scoring → draft financial_event → deterministic policy → approval/clarification →
 * audit. All of that logic is pure and unit-tested; here we bind the live ports
 * (Supabase + the OpenAI-backed gateway) and run it under Inngest's durable retries.
 *
 * Idempotency (guide invariant #9): the function key is the source_event_id, so a
 * given external event is processed at most once even if the queue delivers twice.
 */
import { inngest, WHATSAPP_INBOUND_EVENT } from "./client";
import { AiGateway } from "@/ai/gateway";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { serviceClient } from "@/db/client";
import { makeSupabaseConsumerStore, makeSupabaseCostLedger } from "@/db/consumer-store";
import { processSourceEvent, type ConsumerDeps } from "./processing";
import { makeInboundDeps } from "@/lib/inbound/production-deps";
import { recordInboundReceipt } from "@/lib/inbound/receipt";
import { dispatchReceipt } from "@/lib/inbound/dispatch-receipt";
import { sha256 } from "@/lib/ids";
import { supabaseAdmin } from "@/lib/supabase/server";
import { drainOutbox } from "@/events/outbox-drain";
import { newCorrelationId, log } from "@/lib/log";

/** Build the live deps once per invocation (lazy — no client is created at import). */
function liveDeps(): ConsumerDeps {
  const db = serviceClient();
  const gateway = new AiGateway(makeOpenAiTransport(), makeSupabaseCostLedger(db));
  return { gateway, ...makeSupabaseConsumerStore(db) };
}

export const onSourceEventReceived = inngest.createFunction(
  {
    id: "on-source-event-received",
    // Idempotency: one run per source event, ever (guide invariant #9).
    idempotency: "event.data.source_event_id",
    retries: 4,
  },
  { event: "financial/source_event.received" },
  async ({ event, step }) => {
    const { source_event_id, correlation_id } = event.data as {
      source_event_id: string;
      correlation_id: string;
    };

    // The whole pipeline runs inside one durable step. It is internally idempotent
    // via the function-level idempotency key; a RetryableExtractionError thrown from
    // inside bubbles up so Inngest retries with backoff, and dead-letters after the
    // configured retries (guide invariant #9: a failed process never loses the event).
    const outcome = await step.run("process-source-event", () =>
      processSourceEvent({ source_event_id, correlation_id }, liveDeps()),
    );

    // SETTLE THE RECEIPT (S-01 case b). Nothing here used to write `source_events.status`, so the
    // scheduled sweeper R1 §4 added went on to claim rows this consumer had already processed
    // successfully — and once the pipeline became idempotent, re-processing them exhausted the
    // attempt budget and dead-lettered healthy captures. With the mandated stack configured that
    // was EVERY finance capture. Settling here is the primary fix; the pipeline being resumable is
    // the backstop for the crash window between the two.
    await step.run("settle-source-event", async () => {
      const { error } = await supabaseAdmin().rpc("settle_processed_source_event", {
        p_id: source_event_id,
      });
      // Not fatal: the receipt is durable and the sweeper's own run is now idempotent. Reporting
      // the failure beats pretending the settle happened.
      if (error) {
        log("error", "could not settle a processed source event", {
          event: "inbound.settle_failed", sourceEventId: source_event_id, error: error.message,
        });
      }
      return { settled: !error };
    });

    return outcome;
  },
);

/**
 * Customer WhatsApp order intake. Separate from the finance pipeline: a customer's
 * "I want 3 gates" is an order, not a financial event. Idempotent on the provider
 * message id so a redelivered webhook never double-replies or double-quotes.
 */
export const onCustomerWhatsAppMessage = inngest.createFunction(
  {
    id: "on-customer-whatsapp-message",
    idempotency: "event.data.wa_message_id",
    retries: 3,
  },
  { event: WHATSAPP_INBOUND_EVENT },
  async ({ event, step }) => {
    const { from, text, wa_message_id, received_by } = event.data as {
      from: string;
      text: string;
      wa_message_id: string;
      received_by?: string | null;
    };

    // FOUND-003 / migration 0076 — the SAME orchestration the synchronous route runs, on the SAME
    // canonical receipt. This worker used to call the customer order handler directly, so with
    // WHATSAPP_ASYNC on every message was a customer order and identity routing did not apply.
    // Re-recording the receipt is idempotent on the canonical identity: it returns the row the
    // webhook already created, and creates it only if the webhook's transaction never landed.
    return await step.run("dispatch-inbound-message", async () => {
      const db = supabaseAdmin();
      const receipt = await recordInboundReceipt(db, {
        source: "whatsapp",
        providerAccountId: received_by ?? null,
        providerMessageId: wa_message_id,
        rawPayload: event.data as Record<string, unknown>,
        contentHash: sha256(text),
        correlationId: newCorrelationId(),
      });
      const outcome = await dispatchReceipt(
        db,
        receipt,
        { channel: "whatsapp", from, text, providerMessageId: wa_message_id, rawPayload: event.data },
        received_by ?? null,
        makeInboundDeps,
      );
      // A dispatch that could not be decided must FAIL the step so Inngest retries it — reporting
      // success would be the false-acknowledgement defect one layer up.
      if (outcome === "error" || outcome === "retry_pending") {
        throw new Error(`inbound dispatch is not finished for ${wa_message_id} (${outcome})`);
      }
      return { status: outcome };
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled work (WP C "Required schedules"). Inngest owns the cadence, so these run at
// USEFUL operational frequencies without hitting Vercel Hobby's one-cron-per-day limit.
// The once-daily Vercel heartbeat (vercel.json) remains only as a coarse fallback for
// when the Inngest app is not connected.
// ─────────────────────────────────────────────────────────────────────────────

/** Base URL for internal cron fan-out (Vercel injects VERCEL_URL at runtime). */
function cronBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
/** Invoke an existing CRON_SECRET-protected internal job endpoint. */
async function runCron(path: string): Promise<{ ok: boolean; status: number }> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — scheduled job skipped", { event: "inngest.cron_misconfigured", path });
    return { ok: false, status: 0 };
  }
  const r = await fetch(`${cronBaseUrl()}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  return { ok: r.ok, status: r.status };
}

/** Frequent outbound delivery + expired-lease + dead-letter recovery sweep. */
export const outboxSweep = inngest.createFunction(
  { id: "outbox-sweep" },
  { cron: "*/2 * * * *" },
  async () => drainOutbox(supabaseAdmin()),
);

/** Task follow-up evaluation every 15 minutes. */
export const taskFollowUpsSchedule = inngest.createFunction(
  { id: "task-follow-ups" },
  { cron: "*/15 * * * *" },
  async () => runCron("/api/cron/follow-ups"),
);

/** conversation analysis sweep every 10 minutes (its own cost/batch limits apply downstream). */
export const aiMonitorSchedule = inngest.createFunction(
  { id: "ai-manager-monitor" },
  { cron: "*/10 * * * *" },
  async () => runCron("/api/cron/ai-monitor"),
);

/** Management digest daily. */
export const managementDigestSchedule = inngest.createFunction(
  { id: "management-digest" },
  { cron: "0 7 * * *" },
  async () => runCron("/api/cron/daily-digest"),
);

/** Health + ledger-integrity check (WP E) every 30 minutes; logs criticals for alerting. */
export const healthCheckSchedule = inngest.createFunction(
  { id: "health-check" },
  { cron: "*/30 * * * *" },
  async () => runCron("/api/health"),
);

export const functions = [
  onSourceEventReceived,
  onCustomerWhatsAppMessage,
  outboxSweep,
  taskFollowUpsSchedule,
  aiMonitorSchedule,
  managementDigestSchedule,
  healthCheckSchedule,
];
