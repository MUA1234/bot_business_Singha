/**
 * Email ingestion webhook — INTEGRATION BOUNDARY (stub).
 *
 * Same contract as the WhatsApp route: verify authenticity, then persist-then-
 * enqueue idempotently. Email provider (inbound-parse) choice + its signing
 * secret are a configuration decision, so this is left as a documented stub. The
 * ingestion logic it will call (ingestSourceEvent) is already built and tested.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  // TODO(config): verify provider signature, then:
  //   await ingestSourceEvent({ source: "email", providerMessageId, rawPayload, body }, store, queue)
  return NextResponse.json(
    { ok: false, error: "email ingestion not configured — see CONFIGURATION_GUIDE.md" },
    { status: 501 },
  );
}
