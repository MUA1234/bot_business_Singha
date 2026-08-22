/**
 * Scheduled inbound sweeper — the production-reachable path that actually retries failed inbound
 * processing (migration 0069 + src/events/inbound-sweeper.ts).
 *
 * Until this route existed, "the message is retried" was a claim with nothing behind it: the
 * WhatsApp webhook acknowledges 200 whatever happens, and nothing re-drove an unprocessed row.
 *
 * Secured by CRON_SECRET, fail-closed (a missing secret refuses to run). Returns counts only —
 * never a recipient, a body, or another company's data. The response reports partial failure and
 * remaining backlog truthfully rather than a bare "ok".
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { sweepInbound, type SweepableEvent } from "@/events/inbound-sweeper";
import { makeFinanceCaptureProcessor } from "@/events/finance-capture-processor";
import { processSourceEvent, type ConsumerDeps } from "@/inngest/processing";
import { AiGateway, MODEL_ROUTES } from "@/ai/gateway";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { ModelPolicyExecutor, ModelPolicyRouter, ModelProviderRegistry } from "@/ai/model-policy-router";
import { serviceClient } from "@/db/client";
import { loadAiTaskBudget, makeSupabaseConsumerStore, makeSupabaseCostLedger, makeSupabaseModelAttemptTelemetry } from "@/db/consumer-store";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Identifies this worker's lease. A restart takes a new identity; expired leases are recoverable. */
function workerId(): string {
  return `inbound-sweeper:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}:${process.pid}`;
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — inbound sweeper refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const owner = workerId();

  const result = await sweepInbound(
    {
      async claim(limit, o, leaseSeconds) {
        const { data, error } = await db.rpc("claim_source_events", {
          p_limit: limit,
          p_owner: o,
          p_lease_seconds: leaseSeconds,
        });
        if (error) throw new Error(error.message);
        return (data ?? []) as SweepableEvent[];
      },
      async complete(id, o) {
        const { error } = await db.rpc("complete_source_event", { p_id: id, p_owner: o });
        if (error) throw new Error(error.message);
      },
      async fail(id, o, code, message, maxAttempts) {
        const { data, error } = await db.rpc("fail_source_event", {
          p_id: id,
          p_owner: o,
          p_error_code: code,
          p_error: message,
          p_max_attempts: maxAttempts,
        });
        if (error) throw new Error(error.message);
        return String(data ?? "retry_wait");
      },
      async release(id, o) {
        const { error } = await db.rpc("release_source_event", { p_id: id, p_owner: o });
        if (error) throw new Error(error.message);
      },
      // R1 §4 — the REAL consumer. This used to return `no_processor` for everything, which
      // (after 0076 narrowed claiming to exactly the finance captures) released every captured
      // finance message back to the queue forever. It now runs the SAME pipeline the Inngest
      // consumer runs: extraction → deterministic action → drafted financial event → policy →
      // approval → audit. No parallel implementation, and no model output choosing a company, an
      // authority level, a ledger account or a permission to pay.
      process: makeFinanceCaptureProcessor({
        extractionConfigured: () => Boolean(process.env.OPENAI_API_KEY),
        async companyOf(id) {
          const { data, error } = await db.from("source_events").select("company_id").eq("id", id).maybeSingle();
          if (error) throw new Error(error.message);
          return (data?.company_id as string | null) ?? null;
        },
        async queueForReview(input) {
          const { error } = await db.rpc("record_inbound_review", {
            p_company: input.companyId,
            p_channel: "whatsapp",
            p_provider_message_id: `source_event:${input.sourceEventId}`,
            p_reason_code: input.reasonCode,
            p_reason_detail: input.reasonDetail,
            p_source_event: input.sourceEventId,
          });
          if (error) throw new Error(error.message);
        },
        process: (i) => {
          const svc = serviceClient();
          const consumer: ConsumerDeps = {
            gateway: (() => {
              const transport = makeOpenAiTransport();
              const registry = new ModelProviderRegistry([{
                candidate: { provider: "openai", model: MODEL_ROUTES.extraction.model, tasks: ["extraction"], estimatedCostUsd: "0.02", latencyMs: 30_000 },
                transport,
              }]);
              return new AiGateway(transport, makeSupabaseCostLedger(svc), {
                executor: new ModelPolicyExecutor(registry, new ModelPolicyRouter(registry.candidates()), makeSupabaseModelAttemptTelemetry(svc)),
                loadBudget: (companyId) => loadAiTaskBudget(svc, companyId, "extraction"),
              });
            })(),
            ...makeSupabaseConsumerStore(svc),
          };
          return processSourceEvent(i, consumer);
        },
      }),
    },
    { owner, limit: 25, leaseSeconds: 120, maxAttempts: 5 },
  );

  if (result.partialFailure) {
    log("warn", "inbound sweep completed with failures", {
      event: "inbound.sweep_partial",
      claimed: result.claimed,
      completed: result.completed,
      deadLettered: result.deadLettered,
    });
  }

  return NextResponse.json({
    ok: !result.partialFailure,
    claimed: result.claimed,
    completed: result.completed,
    retryScheduled: result.retryScheduled,
    deadLettered: result.deadLettered,
    released: result.released,
    partialFailure: result.partialFailure,
  });
}
