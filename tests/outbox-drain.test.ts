import { describe, it, expect, vi } from "vitest";

// The drain calls the real WhatsApp sender; stub it so this is a pure unit test.
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppText: async () => ({ ok: true, messageId: "m1" }),
  sendWhatsAppTemplate: async () => ({ ok: true, messageId: "m1" }),
}));

import { drainOutbox } from "@/events/outbox-drain";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Minimal fake. The claim comes from db.rpc('claim_outbox_batch'); the WP12 `sent` completion
 * from db.rpc('complete_outbox_and_advance') → boolean. The failed/dead path (not exercised here,
 * since the WhatsApp mock succeeds) still uses db.from(...).update()...select().
 */
function fakeDb(claimRows: unknown[], completion: () => { data: boolean | null; error: { message: string } | null }) {
  return {
    rpc: async (name: string) => (name === "claim_outbox_batch" ? { data: claimRows, error: null } : completion()),
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }),
    }),
  } as unknown as SupabaseClient;
}
const row = { id: "r1", channel: "whatsapp", recipient: "9471", body: "hi", template_name: null, template_params: null, template_lang: null, attempts: 0 };

describe("drainOutbox truthful completion (WP5/WP12)", () => {
  it("counts a row sent only when the fenced complete_outbox_and_advance returns true", async () => {
    const r = await drainOutbox(fakeDb([row], () => ({ data: true, error: null })));
    expect(r.ok).toBe(true);
    expect(r.sent).toBe(1);
    expect(r.errors).toBe(0);
  });

  it("a completion that affects ZERO owned rows (lease lost) → ok:false, not counted as sent", async () => {
    const r = await drainOutbox(fakeDb([row], () => ({ data: false, error: null })));
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.errors).toBe(1);
  });

  it("a completion RPC error → ok:false, not counted as sent (at-least-once)", async () => {
    const r = await drainOutbox(fakeDb([row], () => ({ data: null, error: { message: "db down" } })));
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.errors).toBe(1);
  });
});
