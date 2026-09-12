/**
 * Email ingestion webhook — THE INTEGRATION BOUNDARY.
 *
 * Live since 2026-09-12. Same contract as the WhatsApp route, and the same order, which is
 * the whole point of guide invariant #9: verify authenticity → PERSIST → only then enqueue.
 * A failed process must never lose the original event, and a duplicate delivery must never
 * create a second downstream record.
 *
 * What it does NOT do, deliberately: it does not reply, does not run AI, does not create an
 * order. It records the event and hands it to the durable worker. Email is an input and
 * evidence, never truth (CLAUDE.md core principles).
 *
 * UNROUTABLE MAIL IS STORED, NOT DROPPED. The company is resolved from the address the mail
 * was delivered TO — never guessed, because attributing mail to the wrong company is the
 * cross-company leakage CLAUDE.md calls a critical failure. But an unmapped address is a
 * CONFIGURATION gap, not a reason to lose evidence: the event is persisted with a NULL
 * company and closed out `failed`, exactly as the WhatsApp route treats an unmapped business
 * number (migration 0070's rationale). It is then visible in `/api/health` and replayable
 * once the address is mapped, instead of surviving only as a log line.
 *
 * CONFIGURATION (the only reason this can still be closed):
 *   - `EMAIL_WEBHOOK_SECRET` — shared secret for the HMAC-SHA256 signature. UNSET = the
 *     endpoint refuses everything, because an unauthenticated ingestion endpoint is an open
 *     door into the event log (D-007 fail-closed).
 *   - `EMAIL_WEBHOOK_SIGNATURE_HEADER` — optional; defaults to `x-signature-256`.
 *   - `companies.inbound_email_address` — the routing key (migration 0071).
 */
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { completeSourceEvent, makeSupabaseSourceEventStore } from "@/db/source-event-store";
import { ingestSourceEvent } from "@/events/source-event";
import {
  verifyEmailSignature,
  normalizeInboundEmail,
  DEFAULT_EMAIL_SIGNATURE_HEADER,
} from "@/lib/email-inbound";
import { inngest } from "@/inngest/client";
import { log } from "@/lib/log";

export const runtime = "nodejs"; // node:crypto for signature verification

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (!secret || secret.trim() === "") {
    // 503 "temporarily unavailable": the route is wired, the shared secret is absent. Closed
    // and said plainly, rather than accepting unauthenticated mail into the event log.
    log("info", "email webhook called but not configured", { event: "email.not_configured" });
    return NextResponse.json({ ok: false, error: "email ingestion not configured" }, { status: 503 });
  }

  const rawBody = await req.text(); // raw bytes required for HMAC — verify BEFORE parsing
  const headerName = process.env.EMAIL_WEBHOOK_SIGNATURE_HEADER || DEFAULT_EMAIL_SIGNATURE_HEADER;
  if (!verifyEmailSignature(rawBody, req.headers.get(headerName), secret)) {
    // Hard reject, like the WhatsApp route (D-007). No detail leaks to the caller.
    log("error", "email webhook signature rejected", { event: "email.bad_signature" });
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const normalized = normalizeInboundEmail(payload);
  if (!normalized.ok) {
    // 400, not 500: the provider sent something we cannot route. Retrying is pointless, and
    // the reason is logged so a misconfigured provider is diagnosable rather than silent.
    log("error", "email webhook payload not understood", { event: "email.unparseable", reason: normalized.reason });
    return NextResponse.json({ ok: false, error: normalized.reason }, { status: 400 });
  }
  const email = normalized.email;

  const db = supabaseAdmin();
  const { data: company } = await db
    .from("companies")
    .select("id")
    .eq("inbound_email_address", email.recipient)
    .maybeSingle();
  const companyId = (company?.id as string | undefined) ?? null;

  // PERSIST FIRST, enqueue second. A redelivery of the same provider message id
  // short-circuits at the store's unique idempotency key and never enqueues a second
  // processing job. Unroutable mail is persisted too (company NULL) — but NOT enqueued: the
  // consumer pipeline needs a company to draft against, so queueing it would only
  // dead-letter. It waits in `source_events` as durable, replayable evidence instead.
  let result;
  try {
    result = await ingestSourceEvent(
      {
        source: "email",
        providerMessageId: email.providerMessageId,
        rawPayload: payload,
        body: rawBody,
        companyId,
      },
      makeSupabaseSourceEventStore(db),
      {
        async enqueue(evt) {
          if (!companyId) return;
          await inngest.send({ name: evt.name, data: evt.data });
        },
      },
    );
  } catch (e) {
    // Nothing was durably accepted, so do NOT acknowledge: 503 asks the provider to redeliver,
    // and the idempotency key makes the re-persist a no-op. Same rule as the WhatsApp route.
    log("error", "email source event persist failed", { event: "email.persist_failed", error: (e as Error).message });
    return NextResponse.json({ ok: false, error: "persist failed — retry" }, { status: 503 });
  }

  if (!companyId) {
    // Stored, then named as failed so `/api/health` counts it and an operator can see that
    // mail is arriving at an address no company claims. 202: the delivery was accepted and
    // kept, so the provider must stop retrying — the gap is ours to configure, not theirs.
    await completeSourceEvent(db, result.event.id, {
      status: "failed",
      lastError: `company_unresolved: ${email.recipient}`.slice(0, 500),
    });
    log("error", "inbound email address maps to no company", {
      event: "email.company_unresolved",
      recipient: email.recipient,
      sourceEventId: result.event.id,
    });
    return NextResponse.json({ ok: false, error: "company_unresolved", stored: true }, { status: 202 });
  }

  log("info", "inbound email ingested", {
    event: "email.ingested",
    status: result.status,
    sourceEventId: result.event.id,
    correlationId: result.event.correlation_id,
  });
  return NextResponse.json({ ok: true, status: result.status }, { status: 200 });
}
