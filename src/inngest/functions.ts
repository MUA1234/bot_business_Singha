/**
 * Inngest consumers. THIS FILE IS THE "FURTHER DEVELOPMENT" BOUNDARY.
 *
 * Everything up to here — ingest, persist, dedup, enqueue — is built and tested.
 * The consumer below is where the next phase continues: load the stored source
 * event, run the AI gateway extraction, detect missing fields, create a draft
 * financial_event, evaluate policy, and route to the approval queue.
 *
 * It is intentionally left as a documented skeleton because wiring the live AI
 * transport requires your OpenAI key (a configuration step). The pure logic it
 * will call (gateway, intelligence, policy, journal) already exists and is tested.
 */
import { inngest } from "./client";

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

    // ── NEXT PHASE (after webhook config) wires these steps: ──
    // 1. step.run("load-source-event", …)         → fetch raw payload + evidence
    // 2. step.run("ai-extract", …)                → AiGateway.runExtraction(untrusted)
    // 3. step.run("detect-missing", …)            → detectMissingFields()
    // 4. step.run("dedup", …)                     → scoreDuplicate() vs recent events
    // 5. step.run("create-draft", …)              → insert financial_events (state=draft)
    // 6. step.run("evaluate-policy", …)           → evaluatePolicy() → approval_requests
    // 7. step.run("audit", …)                     → append audit_events

    await step.run("acknowledge", async () => ({
      acknowledged: true,
      source_event_id,
      correlation_id,
      note: "stored + enqueued; downstream processing wired in the next phase",
    }));

    return { source_event_id };
  },
);

export const functions = [onSourceEventReceived];
