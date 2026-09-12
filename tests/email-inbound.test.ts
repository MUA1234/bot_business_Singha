import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyEmailSignature,
  normalizeInboundEmail,
  parseRecipient,
  emailContentText,
} from "@/lib/email-inbound";
import { extractText } from "@/db/consumer-store";

const SECRET = "s3cret";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

describe("verifyEmailSignature — fail closed, like every other webhook (D-007)", () => {
  const body = '{"a":1}';

  it("accepts a correct digest, with or without the sha256= prefix", () => {
    expect(verifyEmailSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyEmailSignature(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
    expect(verifyEmailSignature(body, sign(body).toUpperCase(), SECRET)).toBe(true);
  });

  it("REFUSES when the secret is unset or blank — an unconfigured endpoint is closed, not open", () => {
    expect(verifyEmailSignature(body, sign(body), undefined)).toBe(false);
    expect(verifyEmailSignature(body, sign(body), "")).toBe(false);
    expect(verifyEmailSignature(body, sign(body), "   ")).toBe(false);
  });

  it("refuses a missing header, a wrong secret, and a tampered body", () => {
    expect(verifyEmailSignature(body, null, SECRET)).toBe(false);
    expect(verifyEmailSignature(body, sign(body, "other"), SECRET)).toBe(false);
    expect(verifyEmailSignature('{"a":2}', sign(body), SECRET)).toBe(false);
  });

  it("refuses non-hex and truncated signatures rather than letting Buffer.from mangle them", () => {
    expect(verifyEmailSignature(body, "not-hex!!", SECRET)).toBe(false);
    expect(verifyEmailSignature(body, sign(body).slice(0, 40), SECRET)).toBe(false);
    expect(verifyEmailSignature(body, "", SECRET)).toBe(false);
  });
});

describe("parseRecipient — the company routing key (migration 0071)", () => {
  it("takes the bare address, lower-cased, from a display-name header", () => {
    expect(parseRecipient("Sales <Sales@Singha.LK>")).toBe("sales@singha.lk");
    expect(parseRecipient("  orders@singha.lk ")).toBe("orders@singha.lk");
  });

  it("routes on the FIRST address when several are listed", () => {
    expect(parseRecipient("orders@singha.lk, cc@elsewhere.com")).toBe("orders@singha.lk");
  });

  it("returns null for anything that is not an address", () => {
    for (const v of [null, "", "not an address", "@nope", "a@b", "a b@c.com"]) {
      expect(parseRecipient(v as string | null)).toBeNull();
    }
  });
});

describe("normalizeInboundEmail — understand it fully or refuse it", () => {
  const ok = { "message-id": "<m1@provider>", to: "Orders <orders@singha.lk>", from: "Customer <c@x.com>", subject: "Quote", text: "50 bags" };

  it("normalises a typical inbound-parse payload", () => {
    const r = normalizeInboundEmail(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.email).toEqual({
      providerMessageId: "<m1@provider>",
      recipient: "orders@singha.lk",
      from: "c@x.com",
      subject: "Quote",
      text: "50 bags",
    });
  });

  it("accepts the other common field spellings", () => {
    const r = normalizeInboundEmail({ messageId: "m2", recipient: "orders@singha.lk", "body-plain": "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email.text).toBe("hi");
  });

  it("refuses a payload with no message id — that is the idempotency key", () => {
    const r = normalizeInboundEmail({ to: "orders@singha.lk", text: "hi" });
    expect(r).toEqual({ ok: false, reason: "no_message_id" });
  });

  it("refuses a payload with no routable recipient — company must never be guessed", () => {
    expect(normalizeInboundEmail({ id: "m3", text: "hi" })).toEqual({ ok: false, reason: "no_recipient" });
    expect(normalizeInboundEmail({ id: "m3", to: "garbage", text: "hi" })).toEqual({ ok: false, reason: "no_recipient" });
  });

  it("refuses non-objects", () => {
    for (const v of [null, undefined, "str", 5, [], [{ id: "m" }]]) {
      expect(normalizeInboundEmail(v)).toEqual({ ok: false, reason: "not_an_object" });
    }
  });

  it("allows empty text (attachment-only mail) but still ingests", () => {
    const r = normalizeInboundEmail({ id: "m4", to: "orders@singha.lk" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email.text).toBe("");
  });
});

describe("emailContentText — what the AI is actually asked to read", () => {
  it("puts the subject above the body (a supplier subject carries the invoice no. / amount)", () => {
    expect(emailContentText({ subject: "INV-4471", "body-plain": "50 bags @ 2,720" })).toBe(
      "Subject: INV-4471\n\n50 bags @ 2,720",
    );
  });

  it("copes with only one of the two present", () => {
    expect(emailContentText({ subject: "INV-4471" })).toBe("Subject: INV-4471");
    expect(emailContentText({ text: "50 bags" })).toBe("50 bags");
  });

  it("returns null — never an empty string — when there is nothing a human wrote", () => {
    // Null is the signal to fall back, so an unrecognised provider shape stays visible
    // instead of the model being handed "".
    expect(emailContentText({ "message-id": "m", to: "a@b.com" })).toBeNull();
    expect(emailContentText({ subject: "   " })).toBeNull();
    for (const v of [null, undefined, "str", 7, []]) expect(emailContentText(v)).toBeNull();
  });
});

describe("extractText — the channel decides how the payload is read", () => {
  const emailPayload = {
    "message-id": "<m1@provider>",
    to: "orders@singha.lk",
    subject: "INV-4471",
    "body-plain": "50 bags of cement @ 2,720",
    "envelope-from": "supplier@x.com",
    "content-id-map": "{...}",
  };

  it("reads an email as subject + body, NOT as the provider envelope", () => {
    const content = extractText(emailPayload, "email");
    expect(content).toBe("Subject: INV-4471\n\n50 bags of cement @ 2,720");
    // The regression: falling through to JSON.stringify buried the message in routing keys.
    expect(content).not.toContain("envelope-from");
    expect(content).not.toContain("message-id");
  });

  it("honours the stored source rather than sniffing keys — a crafted payload cannot pick its reader", () => {
    // The SAME payload on the whatsapp channel must not take the email branch.
    expect(extractText(emailPayload, "whatsapp")).toContain("envelope-from");
    expect(extractText({ text: { body: "hello" } }, "whatsapp")).toBe("hello");
  });

  it("falls back to the JSON dump for an email with no readable content", () => {
    // Visible to a human beats an empty prompt.
    expect(extractText({ "message-id": "m", to: "a@b.com" }, "email")).toContain("message-id");
  });

  it("leaves every existing WhatsApp shape untouched when no source is given", () => {
    expect(extractText({ text: { body: "hi" } })).toBe("hi");
    expect(extractText({ caption: "cap" })).toBe("cap");
    expect(extractText({ button: { text: "btn" } })).toBe("btn");
    expect(extractText({ interactive: { list_reply: { title: "pick" } } })).toBe("pick");
  });
});
