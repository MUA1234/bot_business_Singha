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
import { inngest } from "./client";
import { AiGateway } from "@/ai/gateway";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { serviceClient } from "@/db/client";
import { makeSupabaseConsumerStore, makeSupabaseCostLedger } from "@/db/consumer-store";
import { processSourceEvent, type ConsumerDeps } from "./processing";

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

export const functions = [onSourceEventReceived];
