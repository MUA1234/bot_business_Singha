/**
 * GET /api/v1/mobile/vapid-public-key
 *
 * Exposes the VAPID public key so a service worker can subscribe to push
 * notifications. Safe to expose; the private key stays server-only.
 */
import { NextResponse } from "next/server";
import { vapidPublicKeyResponse } from "@/lib/mobile/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json(vapidPublicKeyResponse());
}
