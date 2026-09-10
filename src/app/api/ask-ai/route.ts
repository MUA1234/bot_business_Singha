/**
 * R2D — the authenticated Ask-AI entry point.
 *
 * This route contains no guidance logic. It establishes who is asking, decides whether they may
 * ask, and calls the one shared service — the same shape as the management cycle route, for the
 * same reason: a second implementation here is exactly the failure the kernel exists to prevent.
 *
 * Reads go through the RLS-ENFORCED client, not the service role. Ask-AI already filters
 * evidence by the requester's capabilities, but a filter in application code is a promise;
 * RLS is a boundary. Using the service role here would have made that promise the only thing
 * standing between a bug in the filter and another company's records — and the repository's
 * own service-role allowlist check refused it, correctly.
 *
 * Writing guidance history is a different matter: those tables have no INSERT policy by
 * design, so persistence belongs to a server-side path with its own justification rather than
 * to this route.
 *
 * Identity rules, all server-side:
 *   * the user comes from the authenticated SERVER SESSION, never from the request;
 *   * the company comes from that user's profile, resolved server-side — a client-supplied
 *     company identity is REFUSED, not merely ignored;
 *   * capabilities are resolved server-side and passed to retrieval, which filters evidence
 *     BEFORE the model sees it.
 */
import { NextResponse } from "next/server";
import { getProfile, resolveCapability } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { ask } from "@/kernel/ask-ai/ask";
import { groundedProvider } from "@/kernel/ask-ai/fixtures";
import { LANGUAGES } from "@/kernel/ask-ai/contract";
import { requesterIdentity } from "@/kernel/ask-ai/identity";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Asking about your own work needs no special capability beyond being an active member. */
const BASE_CAPABILITY = "operations.task.view";

/** Capabilities worth resolving, because they widen what evidence a person may see. */
const SCOPE_CAPABILITIES = [
  "operations.task.manage",
  "management.ask_ai.review",
] as const;

const MAX_QUESTION = 2000;

/**
 * The caller's ACTIVE membership in the resolved company.
 *
 * A membership id is not a user id. Substituting one for the other would silently mis-scope
 * every "my work" query and would never match the RLS predicate, which compares against
 * `memberships.id` — so a person would appear to have no guidance and no tasks, for reasons
 * no error message would explain. An absent or suspended membership is a refusal, not a
 * fallback.
 */
async function activeMembershipId(
  db: ReturnType<typeof supabaseServer>, userId: string, companyId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .eq("status", "active")
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/** One question per person per window. Guidance is cheap to ask for and not free to answer. */
const WINDOW_MS = 3_000;
const lastAsk = new Map<string, number>();

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "a JSON body is required" }, { status: 400 });
  }

  // A client-supplied company is refused rather than ignored, so a caller cannot believe it worked.
  if ("companyId" in body || "membershipId" in body) {
    return NextResponse.json(
      { ok: false, error: "identity is resolved from the session and may not be supplied" },
      { status: 400 },
    );
  }

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const base = await resolveCapability(profile.userId, profile.companyId, BASE_CAPABILITY);
  if (base !== "granted") {
    return NextResponse.json({ ok: false, error: "forbidden", reason: base }, { status: 403 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ ok: false, error: "a question is required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION) {
    return NextResponse.json(
      { ok: false, error: `a question may not exceed ${MAX_QUESTION} characters` },
      { status: 413 },
    );
  }

  const language = typeof body.language === "string" ? body.language : undefined;
  if (language && !(LANGUAGES as readonly string[]).includes(language)) {
    return NextResponse.json(
      { ok: false, error: `language must be one of ${LANGUAGES.join(", ")}` },
      { status: 400 },
    );
  }

  const now = Date.now();
  const previous = lastAsk.get(profile.userId) ?? 0;
  if (now - previous < WINDOW_MS) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retryAfterMs: WINDOW_MS - (now - previous) },
      { status: 429 },
    );
  }
  lastAsk.set(profile.userId, now);

  // Resolved server-side. What a person may see is decided here, before any evidence is gathered.
  const capabilities = new Set<string>();
  for (const cap of SCOPE_CAPABILITIES) {
    if ((await resolveCapability(profile.userId, profile.companyId, cap)) === "granted") {
      capabilities.add(cap);
    }
  }

  // RLS-enforced, bound to this request's session: every read below is what THIS person may
  // see, enforced by the database rather than by the code that assembles the context.
  const db = supabaseServer();
  const membershipId = await activeMembershipId(db, profile.userId, profile.companyId);
  if (!membershipId) {
    return NextResponse.json(
      { ok: false, error: "forbidden", reason: "no active membership in this company" },
      { status: 403 },
    );
  }

  try {
    const result = await ask(
      {
        db,
        // Deterministic, and deliberately the only provider wired in this phase: no live or paid
        // model is reachable from here.
        provider: groundedProvider,
      },
      {
        // Built once, from the session. This is the only place the three identities are
        // marked, so it is the only place worth reviewing to know they are right.
        ...requesterIdentity(profile.userId, membershipId, profile.companyId),
        capabilities,
        question,
        language,
        threadId: typeof body.threadId === "string" ? body.threadId : undefined,
      },
    );

    log("info", "ask-ai answered", {
      event: "ask_ai.answered",
      company: profile.companyId,
      correlationId: result.correlationId,
      mode: result.mode,
      persisted: result.persisted,
      // The refusal CODE, never the question and never the answer.
      refusal: result.answer.refusalReason,
    });

    return NextResponse.json(
      {
        ok: true,
        mode: result.mode,
        answer: result.answer,
        persisted: result.persisted,
        threadId: result.threadId,
        notice: result.notice,
        languageFellBack: result.languageFellBack,
        correlationId: result.correlationId,
        // Stated on every response, so review is disclosed rather than discovered.
        managerVisibility:
          result.persisted
            ? "Operational guidance is a company work record and may be reviewed by managers holding the review capability."
            : "This question was not saved to your guidance history.",
      },
      { status: 200 },
    );
  } catch (e) {
    log("error", "ask-ai failed", {
      event: "ask_ai.failed",
      company: profile.companyId,
      error: (e as Error).message,
    });
    // The reason is logged, not returned: a database message can carry fragments of a row.
    return NextResponse.json({ ok: false, error: "ask_failed" }, { status: 500 });
  }
}
