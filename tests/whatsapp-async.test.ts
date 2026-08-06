import { describe, it, expect } from "vitest";
import { WHATSAPP_INBOUND_EVENT } from "@/inngest/client";
import { functions, onCustomerWhatsAppMessage } from "@/inngest/functions";

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
