import { describe, it, expect } from "vitest";
import {
  outboundIdempotencyKey,
  isSendable,
  classifyAfterFailure,
  buildOutboxRow,
  MAX_OUTBOX_ATTEMPTS,
} from "@/events/outbox";

describe("outbox — idempotent outbound delivery (change plan §5.7)", () => {
  it("same channel + dedupeKey ⇒ same idempotency key (dedup)", () => {
    const a = outboundIdempotencyKey("whatsapp", "quotation:123");
    const b = outboundIdempotencyKey("whatsapp", "quotation:123");
    expect(a).toBe(b);
    expect(a).toMatch(/^out_[0-9a-f]{64}$/);
  });

  it("different dedupeKey or channel ⇒ different key", () => {
    expect(outboundIdempotencyKey("whatsapp", "quotation:123")).not.toBe(
      outboundIdempotencyKey("whatsapp", "quotation:124"),
    );
    expect(outboundIdempotencyKey("whatsapp", "x")).not.toBe(
      outboundIdempotencyKey("email", "x"),
    );
  });

  it("only pending/failed rows are sendable", () => {
    expect(isSendable("pending")).toBe(true);
    expect(isSendable("failed")).toBe(true);
    expect(isSendable("sent")).toBe(false);
    expect(isSendable("dead")).toBe(false);
  });

  it("retries until the cap, then dead-letters", () => {
    expect(classifyAfterFailure(0)).toBe("failed");
    expect(classifyAfterFailure(MAX_OUTBOX_ATTEMPTS - 2)).toBe("failed");
    expect(classifyAfterFailure(MAX_OUTBOX_ATTEMPTS - 1)).toBe("dead");
  });

  it("builds a pending row with a stable key", () => {
    const row = buildOutboxRow({
      channel: "whatsapp",
      companyId: "co-1",
      recipient: "94701135556",
      body: "hi",
      dedupeKey: "wa_reply:abc",
      correlationId: "corr-1",
    });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.company_id).toBe("co-1");
    expect(row.idempotency_key).toBe(outboundIdempotencyKey("whatsapp", "wa_reply:abc"));
  });
});
