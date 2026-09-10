/**
 * Authorised human feedback on a management item (R2B runtime, owner Decision 3).
 *
 * This route contains NO learning logic and NO feedback rules. It establishes who is asking,
 * decides whether they may ask, resolves their membership, and calls the one shared service —
 * the same shape as the manual cycle route, and for the same reason: a second implementation of
 * a rule is how two answers to one question appear.
 *
 * Identity rules, all server-side and none of them client-supplied:
 *   * the user comes from the authenticated SERVER SESSION;
 *   * the company comes from that user's profile, resolved server-side; a client-supplied
 *     `companyId` or `actorMembershipId` is REFUSED LOUDLY rather than ignored, so a caller
 *     cannot believe it worked;
 *   * the membership is resolved from (user, company) — feedback is attributed to a membership,
 *     because that is what the learning fold and the accountable-owner column both use;
 *   * the existing `operations.task.work` capability is required. Recording what happened is
 *     part of doing the work, so it is deliberately NOT gated behind the manager capability —
 *     the person who did the job is usually the one who knows how it went.
 */
import { NextResponse } from "next/server";
import { getProfile, resolveCapability } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { recordFeedback, FeedbackRejected } from "@/kernel/people/feedback";
import { makeFeedbackWriter } from "@/kernel/people/feedback-writer";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/** Recording an outcome is part of doing the work, not a management privilege. */
const REQUIRED_CAPABILITY = "operations.task.work";

/** Fields a client may never supply. Server-derived identity is the whole security model here. */
const SERVER_DERIVED = ["companyId", "actorMembershipId", "actorId", "actorType"] as const;

export async function POST(req: Request): Promise<Response> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "a JSON body is required" }, { status: 400 });
  }

  if (body && typeof body === "object") {
    const supplied = SERVER_DERIVED.filter((k) => k in (body as Record<string, unknown>));
    if (supplied.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `${supplied.join(", ")} ${supplied.length === 1 ? "is" : "are"} resolved from the session and may not be supplied`,
        },
        { status: 400 },
      );
    }
  }

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const capability = await resolveCapability(profile.userId, profile.companyId, REQUIRED_CAPABILITY);
  if (capability !== "granted") {
    return NextResponse.json({ ok: false, error: "forbidden", reason: capability }, { status: 403 });
  }

  const db = supabaseAdmin();

  // The membership, resolved from the SESSION user and the SESSION company. An inactive
  // membership yields nothing and the request is refused — a revoked person may not record
  // feedback that will influence future recommendations about their colleagues.
  const { data: membership } = await db
    .from("memberships")
    .select("id")
    .eq("user_id", profile.userId)
    .eq("company_id", profile.companyId)
    .eq("status", "active")
    .maybeSingle();

  if (!membership?.id) {
    return NextResponse.json(
      { ok: false, error: "forbidden", reason: "no active membership in this company" },
      { status: 403 },
    );
  }

  try {
    const result = await recordFeedback(
      { companyId: profile.companyId, actorMembershipId: membership.id },
      body,
      makeFeedbackWriter(db),
    );

    log("info", "management feedback recorded", {
      event: "management_feedback.recorded",
      company: profile.companyId,
      feedbackId: result.feedbackId,
    });

    return NextResponse.json({ ok: true, feedbackId: result.feedbackId }, { status: 201 });
  } catch (e) {
    if (e instanceof FeedbackRejected) {
      return NextResponse.json({ ok: false, error: e.code, detail: e.message }, { status: 400 });
    }
    // A database refusal (company boundary, missing lifecycle evidence, burst limit) is a
    // legitimate answer, not a server fault — but it is never reported as success.
    const message = (e as Error).message ?? "feedback could not be recorded";
    log("warn", "management feedback refused", {
      event: "management_feedback.refused",
      company: profile.companyId,
      reason: message,
    });
    return NextResponse.json({ ok: false, error: "refused", detail: message }, { status: 409 });
  }
}
