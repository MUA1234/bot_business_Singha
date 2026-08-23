/**
 * MOB-003 — Stable versioned mobile API contract.
 *
 * This module defines the canonical v1 response shape and helpers so the mobile
 * surface is explicit, typed and easy to keep backward-compatible.
 */

export const MOBILE_API_VERSION = "v1";

export interface MobileHealthResponse {
  version: string;
  status: "ok" | "degraded" | "unavailable";
  serverTime: string;
  apis: string[];
}

export interface MobileConfigResponse {
  version: string;
  supportedVersions: string[];
  features: {
    push: boolean;
  };
}

export interface VapidPublicKeyResponse {
  publicKey: string | null;
}

export function mobileHealthResponse(): MobileHealthResponse {
  return {
    version: MOBILE_API_VERSION,
    status: "ok",
    serverTime: new Date().toISOString(),
    apis: [
      "/api/v1/mobile/health",
      "/api/v1/mobile/config",
      "/api/v1/mobile/vapid-public-key",
      "/api/v1/mobile/push-subscription",
    ],
  };
}

export function mobileConfigResponse(): MobileConfigResponse {
  return {
    version: MOBILE_API_VERSION,
    supportedVersions: [MOBILE_API_VERSION],
    features: {
      push: !!process.env.VAPID_PUBLIC_KEY,
    },
  };
}

export function vapidPublicKeyResponse(): VapidPublicKeyResponse {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || null,
  };
}
