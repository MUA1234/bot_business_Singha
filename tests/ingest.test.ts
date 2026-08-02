import { describe, it, expect } from "vitest";
import { ingestSourceEvent, type SourceEventStore, type EventQueue } from "@/events/source-event";

/** In-memory store that honours the idempotency-key uniqueness like the DB does. */
function makeFakeStore() {
  const byKey = new Map<string, { id: string; idempotency_key: string; correlation_id: string; status: string }>();
  let seq = 0;
  const store: SourceEventStore = {
    async upsert(row) {
      const existing = byKey.get(row.idempotency_key);
      if (existing) return { event: existing, alreadyExisted: true };
      const event = { id: `se_${++seq}`, idempotency_key: row.idempotency_key, correlation_id: row.correlation_id, status: "received" };
      byKey.set(row.idempotency_key, event);
      return { event, alreadyExisted: false };
    },
  };
  return { store, byKey };
}

function makeFakeQueue() {
  const enqueued: { name: string; data: unknown }[] = [];
  const queue: EventQueue = {
    async enqueue(event) {
      enqueued.push(event);
    },
  };
  return { queue, enqueued };
}

describe("Source-event ingestion — persist then enqueue (guide invariant #9)", () => {
  it("persists and enqueues a first-time event", async () => {
    const { store } = makeFakeStore();
    const { queue, enqueued } = makeFakeQueue();
    const r = await ingestSourceEvent(
      { source: "whatsapp", providerMessageId: "wamid.ABC", rawPayload: { text: "I paid 14500" }, body: "x" },
      store,
      queue,
    );
    expect(r.status).toBe("enqueued");
    expect(enqueued).toHaveLength(1);
  });

  it("dedups a duplicate delivery and NEVER enqueues twice (guide §14 duplicate webhook)", async () => {
    const { store } = makeFakeStore();
    const { queue, enqueued } = makeFakeQueue();
    const raw = { source: "whatsapp" as const, providerMessageId: "wamid.SAME", rawPayload: { t: 1 }, body: "x" };

    const first = await ingestSourceEvent(raw, store, queue);
    const second = await ingestSourceEvent(raw, store, queue);

    expect(first.status).toBe("enqueued");
    expect(second.status).toBe("duplicate");
    expect(enqueued).toHaveLength(1); // the crux: only one processing job
  });
});
