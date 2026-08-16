/**
 * FINAL external-review item 4 — the REAL application wrapper `enqueueOutbox` invokes the atomic,
 * service-only `enqueue_outbox_row` RPC (migration 0061), passing the built outbox row, and maps its
 * result truthfully. This is the "invoked by the real application wrapper" half of the requirement;
 * the RPC's atomic dedup under genuine two-connection concurrency is proven live in
 * tests/integration/wp12-quotation-delivery.test.ts. Together they show concurrent finalisers can
 * never create two logical outbox rows via the production path (no raw INSERT anywhere).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { outboundIdempotencyKey } from "@/events/outbox";
import type { OutboxEntry } from "@/events/outbox";

const H = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => ({ rpc: H.rpc }) }));

import { enqueueOutbox } from "@/lib/outbox-enqueue";

const entry: OutboxEntry = {
  channel: "whatsapp",
  companyId: "co1",
  recipient: "9471",
  body: "hi",
  dedupeKey: "quotation:q9",
  sourceType: "quotation",
  sourceId: "q9",
  messagePurpose: "quotation",
};

describe("enqueueOutbox — real wrapper invokes the atomic enqueue_outbox_row RPC", () => {
  beforeEach(() => { H.rpc.mockReset(); }); // void body: returning the mock confuses vitest's hook handling

  it("calls enqueue_outbox_row with the built row and returns 'enqueued'", async () => {
    H.rpc.mockResolvedValue({ data: "enqueued", error: null });
    const r = await enqueueOutbox(entry);
    expect(r).toBe("enqueued");
    expect(H.rpc).toHaveBeenCalledTimes(1);
    const call = H.rpc.mock.calls[0]!;
    expect(call[0]).toBe("enqueue_outbox_row"); // NOT a raw insert — the production atomic RPC
    expect(call[1]).toMatchObject({
      p_company: "co1",
      p_channel: "whatsapp",
      p_recipient: "9471",
      p_body: "hi",
      p_idempotency_key: outboundIdempotencyKey("whatsapp", "quotation:q9"),
      p_source_type: "quotation",
      p_source_id: "q9",
      p_message_purpose: "quotation",
    });
  });

  it("returns 'duplicate' when the RPC reports a duplicate (idempotent enqueue)", async () => {
    H.rpc.mockResolvedValue({ data: "duplicate", error: null });
    expect(await enqueueOutbox(entry)).toBe("duplicate");
  });

  it("fails safe to 'unavailable' on an RPC error — retryable, never breaks the caller", async () => {
    H.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await enqueueOutbox(entry)).toBe("unavailable");
  });

  it("fails safe to 'unavailable' when the RPC throws", async () => {
    H.rpc.mockImplementation(() => { throw new Error("network"); });
    expect(await enqueueOutbox(entry)).toBe("unavailable");
  });

  it("treats an unexpected RPC payload as 'unavailable' (never a false success)", async () => {
    H.rpc.mockResolvedValue({ data: "weird", error: null });
    expect(await enqueueOutbox(entry)).toBe("unavailable");
  });
});
