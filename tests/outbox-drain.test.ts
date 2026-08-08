import { describe, it, expect, vi } from "vitest";

// The drain calls the real WhatsApp sender; stub it so this is a pure unit test.
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppText: async () => ({ ok: true, messageId: "m1" }),
  sendWhatsAppTemplate: async () => ({ ok: true, messageId: "m1" }),
}));

import { drainOutbox } from "@/events/outbox-drain";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Minimal fake matching db.rpc(...) and db.from(...).update(...).eq(...).eq(...).select(...). */
function fakeDb(claimRows: unknown[], completion: () => { data: unknown[] | null; error: { message: string } | null }) {
  return {
    rpc: async () => ({ data: claimRows, error: null }),
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ select: async () => completion() }) }) }),
    }),
  } as unknown as SupabaseClient;
}
const row = { id: "r1", channel: "whatsapp", recipient: "9471", body: "hi", template_name: null, template_params: null, template_lang: null, attempts: 0 };

describe("drainOutbox truthful completion (WP5)", () => {
  it("counts a row sent only when the completion durably affects exactly one row", async () => {
    const r = await drainOutbox(fakeDb([row], () => ({ data: [{ id: "r1" }], error: null })));
    expect(r.ok).toBe(true);
    expect(r.sent).toBe(1);
    expect(r.errors).toBe(0);
  });

  it("a completion that affects ZERO rows (lease lost) → ok:false, not counted as sent", async () => {
    const r = await drainOutbox(fakeDb([row], () => ({ data: [], error: null })));
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.errors).toBe(1);
  });

  it("a completion DB error → ok:false", async () => {
    const r = await drainOutbox(fakeDb([row], () => ({ data: null, error: { message: "db down" } })));
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.errors).toBe(1);
  });
});
