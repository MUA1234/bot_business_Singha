import { describe, it, expect } from "vitest";
import { WHATSAPP_INBOUND_EVENT } from "@/inngest/client";
import { functions, onCustomerWhatsAppMessage, onSourceEventReceived } from "@/inngest/functions";
import { ingestSourceEvent, SOURCE_EVENT_RECEIVED } from "@/events/source-event";

/**
 * §WP4 contract: the webhook (producer) and the durable worker (consumer) share one
 * event name, so an async-enqueued inbound message is always picked up — never dropped.
 */
describe("WhatsApp async webhook ↔ worker contract", () => {
  it("uses one shared inbound event name", () => {
    expect(WHATSAPP_INBOUND_EVENT).toBe("whatsapp/customer_message.received");
  });

  it("the customer-message worker is registered", () => {
    expect(functions).toContain(onCustomerWhatsAppMessage);
    expect(functions.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The same contract for the OTHER producer/consumer pair — the one the email webhook feeds.
 *
 * This pair was broken in a quieter way: `onSourceEventReceived` was registered and correct,
 * but until `/api/webhooks/email` was wired on 2026-09-12 NOTHING emitted its event, so the
 * consumer's missing lifecycle close-out could not be noticed. A drifted name here fails the
 * same silent way — the event is sent, nobody listens, and the source event never leaves
 * `received` while `/api/health` counts it as unprocessed for ever.
 */
describe("source-event webhook ↔ consumer contract", () => {
  it("the producer emits exactly the name the consumer is registered for", async () => {
    const sent: { name: string }[] = [];
    await ingestSourceEvent(
      { source: "email", providerMessageId: "m1", rawPayload: {}, companyId: "co-1" },
      {
        async upsert() {
          return {
            event: { id: "ev1", idempotency_key: "k", correlation_id: "c", status: "received" },
            alreadyExisted: false,
          };
        },
      },
      { async enqueue(e) { sent.push({ name: e.name }); } },
    );
    expect(sent).toEqual([{ name: SOURCE_EVENT_RECEIVED }]);
  });

  it("the source-event consumer is registered", () => {
    expect(functions).toContain(onSourceEventReceived);
  });

  it("a duplicate delivery enqueues NOTHING — the consumer must never run twice", async () => {
    const sent: unknown[] = [];
    const r = await ingestSourceEvent(
      { source: "email", providerMessageId: "m1", rawPayload: {}, companyId: "co-1" },
      {
        async upsert() {
          return {
            event: { id: "ev1", idempotency_key: "k", correlation_id: "c", status: "received" },
            alreadyExisted: true,
          };
        },
      },
      { async enqueue(e) { sent.push(e); } },
    );
    expect(r.status).toBe("duplicate");
    expect(sent).toEqual([]);
  });
});
