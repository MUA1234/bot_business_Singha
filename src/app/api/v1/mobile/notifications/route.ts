/**
 * MOB-003 — Versioned mobile notifications list.
 *
 * Returns the authenticated user's in-app notifications, newest first. This is a
 * stable, versioned read surface for a mobile client.
 */
import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseReadClient();
  const { data, error } = await db
    .from("notifications")
    .select("id, type, title, body, link, is_read, created_at")
    .eq("company_id", profile.companyId)
    .eq("recipient_id", profile.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    apiVersion: "v1",
    notifications: data ?? [],
  });
}
