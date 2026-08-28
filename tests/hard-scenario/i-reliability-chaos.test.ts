/**
 * PACKAGE I — reliability and chaos, driven through the REAL webhook endpoint.
 *
 * These fire genuine HTTP requests at the running application on 127.0.0.1:3241, signed
 * with the campaign's test app secret, so the integration boundary is exercised exactly
 * as Meta would exercise it: raw-body HMAC, persist-first, idempotency on the provider
 * message id.
 *
 * The invariant under test throughout is: a redelivered, replayed, reordered or
 * concurrent webhook must never produce a second business effect, and a failure must
 * never lose the original event.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { stackConfigured, serviceClient, TENANT_A, APP } from "./helpers/stack";

/** Must match WHATSAPP_APP_SECRET in the isolated runtime env. */
const APP_SECRET = process.env.HST_WHATSAPP_APP_SECRET ?? "hst-test-app-secret";
const VERIFY_TOKEN = process.env.HST_WHATSAPP_VERIFY_TOKEN ?? "hst-test-verify-token";
const PHONE_ID = "000000000000000";

const CHANNEL_ACCOUNT = "0000f1de-0000-4000-8000-00000000ca01";

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

/** A minimal, well-formed Meta inbound-text delivery. */
function delivery(messageId: string, text: string, from = "+94770000501", ts = 1787000000) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "94110000000", phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: "FIXTURE Customer" }, wa_id: from.replace("+", "") }],
              messages: [
                { from: from.replace("+", ""), id: messageId, timestamp: String(ts), type: "text", text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(payload: unknown, opts: { signature?: string | null; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const sig = opts.signature === undefined ? sign(raw) : opts.signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  const res = await fetch(`${APP}/api/webhooks/whatsapp`, { method: "POST", headers, body: raw });
  return { status: res.status, text: await res.text() };
}

const seenIds: string[] = [];
function msgId(tag: string) {
  const id = `wamid.HST${tag}${Math.abs(hash(tag))}`;
  seenIds.push(id);
  return id;
}
/** Deterministic id suffix — no Math.random, so a rerun targets the same rows. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe.skipIf(!stackConfigured)("I — reliability and chaos (real webhook boundary)", () => {
  beforeAll(async () => {
    const svc = serviceClient();
    // The webhook resolves the company from the RECEIVING account, so one must exist.
    await svc.from("channel_accounts").upsert(
      {
        id: CHANNEL_ACCOUNT,
        company_id: TENANT_A.company,
        channel: "whatsapp",
        provider_account_id: PHONE_ID,
        display_label: "FIXTURE inbound number",
        is_active: true,
      },
      { onConflict: "id" },
    );
    await svc.from("source_events").delete().like("provider_message_id", "wamid.HST%");
  });

  afterAll(async () => {
    const svc = serviceClient();
    await svc.from("source_events").delete().like("provider_message_id", "wamid.HST%");
    await svc.from("channel_accounts").delete().eq("id", CHANNEL_ACCOUNT);
  });

  /* ── I1. The signature boundary ──────────────────────────────────────── */

  it("I1 — an unsigned webhook is rejected and persists nothing", async () => {
    const id = msgId("unsigned");
    const { status } = await postWebhook(delivery(id, "unsigned attempt"), { signature: null });
    expect(status).toBe(401);

    const svc = serviceClient();
    const { data } = await svc.from("source_events").select("id").eq("provider_message_id", id);
    expect(data ?? [], "an unauthenticated webhook was persisted").toHaveLength(0);
  });

  it("I1 — a wrong signature is rejected", async () => {
    const id = msgId("wrongsig");
    const { status } = await postWebhook(delivery(id, "forged"), { signature: "sha256=" + "0".repeat(64) });
    expect(status).toBe(401);
    const svc = serviceClient();
    const { data } = await svc.from("source_events").select("id").eq("provider_message_id", id);
    expect(data ?? []).toHaveLength(0);
  });

  it("I1 — a signature computed over a DIFFERENT body is rejected", async () => {
    // The realistic tampering attack: keep a captured valid signature, change the body.
    const id = msgId("tamper");
    const original = JSON.stringify(delivery(id, "original text"));
    const tampered = JSON.stringify(delivery(id, "tampered text"));
    const { status } = await postWebhook(null, { raw: tampered, signature: sign(original) });
    expect(status).toBe(401);
  });

  /* ── I2. Malformed input ─────────────────────────────────────────────── */

  it("I2 — malformed JSON is refused with 400, after signature verification", async () => {
    const raw = "{ this is not json";
    const { status } = await postWebhook(null, { raw, signature: sign(raw) });
    expect(status).toBe(400);
  });

  it("I2 — a well-formed delivery carrying no messages is acknowledged, not errored", async () => {
    // Meta sends status callbacks constantly. Erroring on them would make Meta retry forever.
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "e", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    };
    const { status } = await postWebhook(payload);
    expect(status).toBe(200);
  });

  /* ── I3. Duplicate delivery and replay ───────────────────────────────── */

  it("I3 — a redelivered webhook creates exactly ONE source event", async () => {
    const id = msgId("dup");
    const payload = delivery(id, "please quote 10 units of placeholder widget");

    const first = await postWebhook(payload);
    const second = await postWebhook(payload);
    const third = await postWebhook(payload);
    expect([first.status, second.status, third.status].every((s) => s === 200 || s === 503)).toBe(true);

    const svc = serviceClient();
    const { data } = await svc.from("source_events").select("id").eq("provider_message_id", id);
    expect(data ?? [], "a redelivered webhook duplicated the source event").toHaveLength(1);
  });

  it("I3 — an exact byte-for-byte replay is still one event", async () => {
    const id = msgId("replay");
    const raw = JSON.stringify(delivery(id, "replayed message"));
    const signature = sign(raw);
    await postWebhook(null, { raw, signature });
    await postWebhook(null, { raw, signature });

    const svc = serviceClient();
    const { data } = await svc.from("source_events").select("id").eq("provider_message_id", id);
    expect(data ?? []).toHaveLength(1);
  });

  it("I3 — CONCURRENT identical deliveries collapse to one event", async () => {
    const id = msgId("concurrent");
    const raw = JSON.stringify(delivery(id, "concurrent delivery"));
    const signature = sign(raw);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => postWebhook(null, { raw, signature })),
    );
    // Some may legitimately return 503 (retryable) under contention; none may 500.
    expect(results.every((r) => r.status !== 500)).toBe(true);

    const svc = serviceClient();
    const { data } = await svc.from("source_events").select("id").eq("provider_message_id", id);
    expect(data ?? [], "a concurrency race duplicated the source event").toHaveLength(1);
  });

  /* ── I4. Out-of-order delivery ───────────────────────────────────────── */

  it("I4 — out-of-order deliveries are each stored once, under their own identity", async () => {
    const older = msgId("ooo-older");
    const newer = msgId("ooo-newer");
    // Deliver the NEWER message first, then the older one.
    await postWebhook(delivery(newer, "second message", "+94770000501", 1787000200));
    await postWebhook(delivery(older, "first message", "+94770000501", 1787000100));

    const svc = serviceClient();
    for (const id of [older, newer]) {
      const { data } = await svc.from("source_events").select("id").eq("provider_message_id", id);
      expect(data ?? [], `${id} was not stored exactly once`).toHaveLength(1);
    }
  });

  /* ── I5. Identity is per-message, not per-batch ──────────────────────── */

  it("I5 — two messages in ONE delivery become two distinct events", async () => {
    const a = msgId("batch-a");
    const b = msgId("batch-b");
    const payload = delivery(a, "message A");
    // Add a second message to the same change value.
    (payload.entry[0]!.changes[0]!.value as { messages: unknown[] }).messages.push({
      from: "94770000502", id: b, timestamp: "1787000300", type: "text", text: { body: "message B" },
    });

    const { status } = await postWebhook(payload);
    expect(status).toBe(200);

    const svc = serviceClient();
    for (const id of [a, b]) {
      const { data } = await svc.from("source_events").select("id,raw_payload").eq("provider_message_id", id);
      expect(data ?? [], `${id} missing`).toHaveLength(1);
      // Each row must carry only ITS message, never the whole batch — a batch can span
      // companies, and storing it whole would put another company's text in this row.
      const rawText = JSON.stringify((data as { raw_payload: unknown }[])[0]!.raw_payload);
      const other = id === a ? "message B" : "message A";
      expect(rawText.includes(other), `${id} stored another message's content`).toBe(false);
    }
  });

  /* ── I6. The subscription handshake ──────────────────────────────────── */

  it("I6 — the GET challenge succeeds only with the correct verify token", async () => {
    const good = await fetch(
      `${APP}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=hst-challenge`,
    );
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("hst-challenge");

    const bad = await fetch(
      `${APP}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=hst-challenge`,
    );
    expect(bad.status).toBe(403);
  });

  /* ── I7. Nothing left the machine ────────────────────────────────────── */

  it("I7 — no outbound provider request escaped during the whole package", async () => {
    // The net guard is the authority. If the application had tried to reach Meta, the
    // attempt would have been refused and recorded, and a real send would be impossible.
    const svc = serviceClient();
    const { data } = await svc
      .from("message_outbox")
      .select("id,status")
      .in("status", ["sent"])
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
    // Anything "sent" during this run would mean a delivery path believed it reached Meta.
    expect(data ?? [], "a message was marked sent during an offline campaign").toHaveLength(0);
  });
});
