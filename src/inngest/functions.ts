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
import { handleCustomerMessage } from "@/lib/order-intake";
import { supabaseAdmin } from "@/lib/supabase/server";
import { drainOutbox } from "@/events/outbox-drain";
import { log } from "@/lib/log";

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
    const { from, text, wa_message_id, company_id } = event.data as {
      from: string;
      text: string;
      wa_message_id: string;
      company_id?: string;
    };
    return await step.run("handle-customer-message", () =>
      handleCustomerMessage({ from, text, waMessageId: wa_message_id, companyId: company_id }),
    );
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

/** AI manager monitoring every 10 minutes (its own cost/batch limits apply downstream). */
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
