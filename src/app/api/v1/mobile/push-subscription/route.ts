/**
 * /api/v1/mobile/push-subscription
 *
 * POST: register a Web Push subscription for the authenticated user.
 * GET:  list the authenticated user's subscriptions.
 * DELETE: remove a subscription by endpoint.
 *
 * The endpoint is authenticated via Supabase session cookies. It never sends a
 * push; it only persists the subscription safely for a future sender.
 */
import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { normalizeSubscription } from "@/lib/mobile/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const db = supabaseServer();
  const { data: subscriptions, error } = await db
    .from("push_subscriptions")
    .select("id, company_id, endpoint, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  return NextResponse.json({ ok: true, subscriptions: subscriptions ?? [] });
}

export async function POST(req: Request): Promise<Response> {
  const db = supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  let sub;
  try {
    sub = normalizeSubscription(body);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-subscription" }, { status: 422 });
  }

  // Resolve an active company membership for the user. A user may belong to
  // multiple companies; we pick the first active one. The mobile client can
  // later send a target company_id if multi-company push is needed.
  const admin = supabaseAdmin();
  const { data: membership } = await admin
    .from("memberships")
    .select("company_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ ok: false, error: "no-active-membership" }, { status: 403 });
  }

  const { error } = await admin.from("push_subscriptions").upsert(
    {
      company_id: membership.company_id,
      user_id: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: "storage-failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(req: Request): Promise<Response> {
  const db = supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  let endpoint: string;
  try {
    const body = await req.json();
    endpoint = String((body as { endpoint?: string }).endpoint ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  if (!endpoint) {
    return NextResponse.json({ ok: false, error: "endpoint-required" }, { status: 422 });
  }

  const { error } = await db.from("push_subscriptions").delete().eq("endpoint", endpoint);

  if (error) {
    return NextResponse.json({ ok: false, error: "delete-failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
