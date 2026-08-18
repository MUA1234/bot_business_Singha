/**
 * R1 §6 / OF-006 — one canonical inbound contract, and WhatsApp uses it.
 *
 * Every channel adapter produces the same shape, so nothing downstream reads a provider's payload
 * format. This is a FOUNDATION: WhatsApp is the only adapter with a runtime entrypoint, and email,
 * voice/transcription and calendar are separate requirements at `foundation_only` until each has
 * its own entrypoint and tests. A schema is not an integration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CanonicalInboundMessage } from "@/schemas/inbound-adapter";
import { whatsappAdapter } from "@/lib/inbound/adapters/whatsapp";

let n = 0;
const corr = () => `cor_${++n}`;

const delivery = (changes: unknown[]) => ({ entry: [{ changes }] });
const textChange = (account: string, msgs: unknown[]) => ({ value: { metadata: { phone_number_id: account }, messages: msgs } });
const textMsg = (id: string, from: string, body: string, ts = "1755500000") =>
  ({ id, from, type: "text", timestamp: ts, text: { body } });

describe("the canonical inbound contract", () => {
  it("a parsed WhatsApp message satisfies the contract", () => {
    const [m] = whatsappAdapter.parse(delivery([textChange("10555", [textMsg("wamid.1", "9477", "hello")])]), corr);
    expect(CanonicalInboundMessage.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({
      provider: "meta_whatsapp_cloud",
      channel: "whatsapp",
      providerAccountId: "10555",
      providerMessageId: "wamid.1",
      from: "9477",
      text: "hello",
    });
    expect(m!.receivedAt).toBe(new Date(1755500000 * 1000).toISOString());
    expect(m!.consent).toBeNull(); // Meta carries none; saying "unknown" beats inventing consent
  });

  it("the RECEIVING ACCOUNT is read per change — one delivery can serve several of our numbers", () => {
    const msgs = whatsappAdapter.parse(delivery([
      textChange("acct-A", [textMsg("wamid.a", "9477", "for A")]),
      textChange("acct-B", [textMsg("wamid.b", "9478", "for B")]),
    ]), corr);
    expect(msgs.map((m) => [m.providerAccountId, m.text])).toEqual([["acct-A", "for A"], ["acct-B", "for B"]]);
  });

  it("`raw` is the SINGLE message, never the batch it arrived in", () => {
    const msgs = whatsappAdapter.parse(delivery([
      textChange("acct-A", [textMsg("wamid.a", "9477", "company A secret")]),
      textChange("acct-B", [textMsg("wamid.b", "9478", "company B secret")]),
    ]), corr);
    // Storing the batch would put one company's text inside the other's row.
    expect(JSON.stringify(msgs[0]!.raw)).not.toContain("company B secret");
    expect(JSON.stringify(msgs[1]!.raw)).not.toContain("company A secret");
  });

  it("statuses, unhandled kinds and empty messages are skipped, not half-parsed", () => {
    const msgs = whatsappAdapter.parse(delivery([
      { value: { metadata: { phone_number_id: "a" }, statuses: [{ id: "wamid.x", status: "delivered" }] } },
      textChange("a", [
        { id: "wamid.noid" },                                   // no sender
        { from: "9477", type: "text", text: { body: "hi" } },    // no provider id
        { id: "wamid.empty", from: "9477", type: "text", text: { body: "" } }, // nothing to act on
        { id: "wamid.sticker", from: "9477", type: "sticker" },  // unhandled kind, no media
      ]),
    ]), corr);
    expect(msgs).toEqual([]);
  });

  it("MEDIA are references, never inlined bytes", () => {
    const [m] = whatsappAdapter.parse(delivery([textChange("a", [
      { id: "wamid.img", from: "9477", type: "image", timestamp: "1755500000", image: { id: "media-1", mime_type: "image/jpeg" } },
    ])]), corr);
    expect(m!.mediaRefs).toEqual([{ providerMediaId: "media-1", mimeType: "image/jpeg", bytes: null, filename: null }]);
    expect(m!.text).toBe("");   // an image with no caption carries no text, and does not pretend to
  });

  it("a nonsense or empty payload yields nothing rather than throwing", () => {
    for (const payload of [undefined, null, {}, { entry: null }, { entry: [{}] }, "not an object", 42]) {
      expect(() => whatsappAdapter.parse(payload, corr)).not.toThrow();
      expect(whatsappAdapter.parse(payload, corr)).toEqual([]);
    }
  });

  it("a missing or nonsense timestamp is absent, not a fabricated `now`", () => {
    // Built directly rather than through the helper: passing `undefined` to a parameter with a
    // default would silently exercise the default and prove nothing about a MISSING timestamp.
    for (const ts of [undefined, "", "not-a-number", "-5", "0"]) {
      const msg: Record<string, unknown> = { id: "wamid.t", from: "9477", type: "text", text: { body: "x" } };
      if (ts !== undefined) msg.timestamp = ts;
      const [m] = whatsappAdapter.parse(delivery([textChange("a", [msg])]), corr);
      expect(m!.receivedAt, String(ts)).toBeNull();
    }
  });

  it("every message carries its own correlation id", () => {
    const msgs = whatsappAdapter.parse(delivery([textChange("a", [
      textMsg("wamid.1", "9477", "one"), textMsg("wamid.2", "9477", "two"),
    ])]), corr);
    expect(new Set(msgs.map((m) => m.correlationId)).size).toBe(2);
  });
});

describe("R1 §6 — the contract is used, not merely declared", () => {
  it("the webhook route reads the canonical shape and knows nothing about Meta's", () => {
    const route = readFileSync("src/app/api/webhooks/whatsapp/route.ts", "utf8");
    expect(route).toContain("whatsappAdapter.parse");
    // The provider's own field names live in the adapter alone.
    expect(route).not.toContain("phone_number_id");
    expect(route).not.toContain("entry?.changes");
  });

  it("no other channel claims a runtime entrypoint it does not have", () => {
    // Email/voice/calendar are separate requirements at foundation_only. If one of them grows a real
    // adapter, this test is where the claim has to be made explicit.
    const adapters = readFileSync("src/schemas/inbound-adapter.ts", "utf8");
    expect(adapters).toMatch(/foundation_only/);
  });
});
