/**
 * MOB-003 — Push notification subscription endpoint.
 *
 * Stores a Web Push subscription for the authenticated user. The subscription can
 * later be used by a server-side push sender. This endpoint only stores the
 * subscription — it does not send pushes.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function POST(req: Request): Promise<Response> {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = SubscribeBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid subscription" }, { status: 400 });
  }

  const { endpoint, keys } = parsed.data;
  const db = supabaseWriteClient();

  const { error } = await db
    .from("push_subscriptions")
    .upsert(
      {
        company_id: profile.companyId,
        user_id: profile.userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id, user_id, endpoint" },
    );

  if (error) {
    log("error", "push subscription store failed", { event: "push.subscribe_failed", error: error.message, userId: profile.userId });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  log("info", "push subscription stored", { event: "push.subscribed", userId: profile.userId, companyId: profile.companyId });

  return NextResponse.json({ ok: true, apiVersion: "v1" });
}
