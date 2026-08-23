/**
 * GOV-002 — Directive acknowledgement and escalation sweep.
 *
 * Cron-triggered evaluation of unacknowledged management directives that are past
 * their response window. Each overdue directive advances one step up its escalation
 * chain (status becomes 'escalated') or, if the chain is empty/exhausted, becomes
 * 'overdue'. Every transition writes an append-only audit event.
 *
 * Audit actions produced: management_directive.escalated, management_directive.overdue.
 *
 * Secured by CRON_SECRET (fail-closed). Does not send messages; only updates rows
 * and audits.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { evaluateDirectiveEscalation, type EscalatableDirective } from "@/modules/governance/directive-escalation";
import { log } from "@/lib/log";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — directive-escalation refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }

  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const now = new Date();

  const { data: directives, error: readError } = await db
    .from("management_directives")
    .select("id, company_id, status, response_required_by, escalation_chain, escalation_level, acknowledged_at")
    .in("status", ["issued", "overdue", "escalated"])
    .lt("response_required_by", now.toISOString())
    .is("acknowledged_at", null)
    .order("response_required_by", { ascending: true })
    .limit(1000);

  if (readError) {
    log("error", "directive-escalation read failed", { event: "directive_escalation.read_failed", error: readError.message });
    return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });
  }

  let escalated = 0;
  let overdue = 0;
  let unchanged = 0;

  for (const raw of directives ?? []) {
    const directive: EscalatableDirective = {
      id: raw.id as string,
      status: raw.status as EscalatableDirective["status"],
      response_required_by: raw.response_required_by as string,
      escalation_chain: Array.isArray(raw.escalation_chain) ? (raw.escalation_chain as string[]) : null,
      escalation_level: Number(raw.escalation_level ?? 0),
      acknowledged_at: raw.acknowledged_at as string | null | undefined,
    };

    const decision = evaluateDirectiveEscalation(directive, now);
    if (!decision) {
      unchanged++;
      continue;
    }

    const update: Record<string, unknown> = {
      status: decision.newStatus,
      escalation_level: decision.escalation_level,
      escalated_at: decision.escalated_at,
      escalation_reason: decision.escalation_reason,
    };
    if (decision.newStatus === "escalated") {
      update.escalated_to = decision.escalated_to;
    }

    const { error: updError } = await db
      .from("management_directives")
      .update(update)
      .eq("id", directive.id)
      .eq("status", directive.status)
      .eq("escalation_level", directive.escalation_level);

    if (updError) {
      log("error", "directive-escalation update failed", { event: "directive_escalation.update_failed", directiveId: directive.id, error: updError.message });
      continue;
    }

    await writeAudit({
      companyId: raw.company_id as string,
      actorId: "system",
      actorType: "system",
      action: decision.auditAction,
      entityType: "management_directive",
      entityId: directive.id,
      payload: {
        level: decision.escalation_level,
        escalated_to: decision.escalated_to,
        reason: decision.escalation_reason,
        previous_status: directive.status,
      },
    });

    if (decision.newStatus === "escalated") escalated++;
    else overdue++;
  }

  return NextResponse.json({ ok: true, evaluated: (directives ?? []).length, escalated, overdue, unchanged });
}
