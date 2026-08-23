import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MOBILE_API_VERSION,
  mobileHealthResponse,
  mobileConfigResponse,
  vapidPublicKeyResponse,
} from "@/lib/mobile/api";
import { PushSubscriptionSchema, normalizeSubscription } from "@/lib/mobile/push";

const MIGRATION = "src/db/migrations/0108_push_subscriptions.sql";

describe("mobile API helpers (MOB-003)", () => {
  it("exposes a stable v1 version constant", () => {
    expect(MOBILE_API_VERSION).toBe("v1");
  });

  it("health response includes version, status, serverTime and API list", () => {
    const h = mobileHealthResponse();
    expect(h.version).toBe("v1");
    expect(h.status).toBe("ok");
    expect(typeof h.serverTime).toBe("string");
    expect(h.apis).toContain("/api/v1/mobile/health");
    expect(h.apis).toContain("/api/v1/mobile/push-subscription");
  });

  it("config response declares supported versions and push feature", () => {
    const c = mobileConfigResponse();
    expect(c.version).toBe("v1");
    expect(c.supportedVersions).toContain("v1");
    expect(typeof c.features.push).toBe("boolean");
  });

  it("VAPID public key response is null when no key is configured", () => {
    const v = vapidPublicKeyResponse();
    expect(v.publicKey).toBeNull();
  });

  it("PushSubscriptionSchema accepts a valid Web Push subscription", () => {
    const s = {
      endpoint: "https://fcm.googleapis.com/fcm/send/example",
      keys: { p256dh: "dGVzdA==", auth: "dGVzdA==" },
    };
    expect(PushSubscriptionSchema.safeParse(s).success).toBe(true);
  });

  it("normalizeSubscription throws on invalid input", () => {
    expect(() => normalizeSubscription({ endpoint: "not-a-url" })).toThrow();
    expect(() => normalizeSubscription(null)).toThrow();
  });
});

describe("mobile API migration (MOB-003)", () => {
  it("creates a push_subscriptions table with company/user scoping and RLS", () => {
    const m = readFileSync(MIGRATION, "utf8");
    expect(m).toContain("create table if not exists push_subscriptions");
    expect(m).toContain("company_id uuid not null");
    expect(m).toContain("user_id uuid not null");
    expect(m).toContain("endpoint");
    expect(m).toContain("p256dh");
    expect(m).toContain("auth");
    expect(m).toContain("enable row level security");
    expect(m).toContain("auth.uid() = user_id");
  });
});
