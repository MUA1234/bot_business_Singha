/**
 * Inngest client — durable jobs / queue (DECISIONS D-002; free tier). All
 * money-touching and long-running work runs here with explicit idempotency keys,
 * retries and a dead-letter path.
 */
import { Inngest } from "inngest";
import type { EventQueue } from "@/events/source-event";

export const inngest = new Inngest({ id: "ai-business-manager" });

/** EventQueue port backed by Inngest. */
export const inngestQueue: EventQueue = {
  async enqueue(event) {
    await inngest.send({ name: event.name, data: event.data });
  },
};
