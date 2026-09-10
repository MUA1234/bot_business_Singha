/**
 * GET /api/v1/mobile/config
 *
 * Stable mobile client configuration: supported API versions and feature flags.
 * Public and read-only.
 */
import { NextResponse } from "next/server";
import { mobileConfigResponse } from "@/lib/mobile/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json(mobileConfigResponse());
}
