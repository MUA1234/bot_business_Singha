/**
 * GET /api/v1/mobile/health
 *
 * Stable, versioned health check for mobile clients. Public and read-only.
 */
import { NextResponse } from "next/server";
import { mobileHealthResponse } from "@/lib/mobile/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json(mobileHealthResponse());
}
