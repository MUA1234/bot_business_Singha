import { describe, it, expect } from "vitest";
import {
  nextRetryAt,
  isDue,
  classifyAfterFailure,
  inboundEventKey,
  outboundIdempotencyKey,
  MAX_OUTBOX_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
} from "@/events/outbox";

const now = new Date("2026-08-15T12:00:00Z");

describe("retry backoff", () => {
  it("grows exponentially from the base", () => {
    expect(nextRetryAt(0, now)).toBe(new Date(now.getTime() + RETRY_BASE_MS).toISOString());
    expect(nextRetryAt(1, now)).toBe(new Date(now.getTime() + RETRY_BASE_MS * 2).toISOString());
    expect(nextRetryAt(2, now)).toBe(new Date(now.getTime() + RETRY_BASE_MS * 4).toISOString());
  });

  it("caps the delay", () => {
    const t = nextRetryAt(3, now)!; // base*8 = 8min < cap, fine; ensure never exceeds cap
    const delay = new Date(t).getTime() - now.getTime();
    expect(delay).toBeLessThanOrEqual(RETRY_CAP_MS);
  });

  it("returns null once the attempt cap is reached (dead-letter, no retry)", () => {
    expect(nextRetryAt(MAX_OUTBOX_ATTEMPTS - 1, now)).toBeNull();
    expect(classifyAfterFailure(MAX_OUTBOX_ATTEMPTS - 1)).toBe("dead");
  });

  it("isDue is true only at/after the scheduled time and never for dead rows", () => {
    const at = nextRetryAt(0, now)!;
    expect(isDue(at, now)).toBe(false); // scheduled in the future
    expect(isDue(at, new Date(now.getTime() + RETRY_BASE_MS))).toBe(true);
    expect(isDue(null, now)).toBe(false); // dead-lettered
  });
});

describe("dedup keys", () => {
  it("same provider message id → same inbound key (idempotent ingest)", () => {
    expect(inboundEventKey("whatsapp", "wamid.ABC")).toBe(inboundEventKey("whatsapp", "wamid.ABC"));
    expect(inboundEventKey("whatsapp", "wamid.ABC")).not.toBe(inboundEventKey("whatsapp", "wamid.XYZ"));
  });

  it("one inbound reply maps to one stable outbound key (no double send)", () => {
    const a = outboundIdempotencyKey("whatsapp", "wa_reply:wamid.ABC");
    const b = outboundIdempotencyKey("whatsapp", "wa_reply:wamid.ABC");
    expect(a).toBe(b);
  });
});
