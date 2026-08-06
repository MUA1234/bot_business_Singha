import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWhatsappSignature, verifyWebhookChallenge } from "@/lib/whatsapp-signature";

const SECRET = "app-secret-123";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyWhatsappSignature", () => {
  const body = JSON.stringify({ hello: "world" });

  it("accepts a correct signature over the raw body", () => {
    expect(verifyWhatsappSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWhatsappSignature(body + "x", sign(body), SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyWhatsappSignature(body, sign(body), "other-secret")).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyWhatsappSignature(body, null, SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, "md5=abc", SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, "sha256=zz", SECRET)).toBe(false); // wrong length
  });
});

describe("verifyWebhookChallenge", () => {
  it("echoes the challenge only when the verify token matches", () => {
    const ok = verifyWebhookChallenge(
      new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1234" }),
      "tok",
    );
    expect(ok).toEqual({ ok: true, challenge: "1234" });
  });

  it("rejects a wrong token or wrong mode", () => {
    expect(verifyWebhookChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "bad", "hub.challenge": "1" }), "tok").ok).toBe(false);
    expect(verifyWebhookChallenge(new URLSearchParams({ "hub.mode": "x", "hub.verify_token": "tok", "hub.challenge": "1" }), "tok").ok).toBe(false);
  });
});
