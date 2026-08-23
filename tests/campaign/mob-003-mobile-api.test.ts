/**
 * MOB-003 — Versioned mobile APIs and push-notification readiness.
 *
 * Verifies stable versioned endpoints exist for a mobile client and the
 * push-subscription groundwork is in place, without fabricating messages.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HEALTH = "src/app/api/v1/mobile/health/route.ts";
const CONFIG = "src/app/api/v1/mobile/config/route.ts";
const VAPID = "src/app/api/v1/mobile/vapid-public-key/route.ts";
const NOTIFICATIONS = "src/app/api/v1/mobile/notifications/route.ts";
const PUSH = "src/app/api/v1/mobile/push/subscribe/route.ts";
const PUSH_ALT = "src/app/api/v1/mobile/push-subscription/route.ts";
const MIGRATION = "src/db/migrations/0108_push_subscriptions.sql";

describe("MOB-003 — mobile API surface", () => {
  it("has a versioned health endpoint", () => {
    const f = readFileSync(HEALTH, "utf8");
    expect(f).toContain("/api/v1/mobile/health");
    expect(f).toContain("export async function GET");
    expect(f).toContain("mobileHealthResponse");
  });

  it("has a versioned config endpoint", () => {
    const f = readFileSync(CONFIG, "utf8");
    expect(f).toContain("/api/v1/mobile/config");
    expect(f).toContain("mobileConfigResponse");
  });

  it("exposes a VAPID public key endpoint", () => {
    const f = readFileSync(VAPID, "utf8");
    expect(f).toContain("/api/v1/mobile/vapid-public-key");
    expect(f).toContain("vapidPublicKeyResponse");
  });

  it("has a versioned notifications list endpoint scoped to company and recipient", () => {
    const f = readFileSync(NOTIFICATIONS, "utf8");
    expect(f).toContain("Versioned mobile notifications list");
    expect(f).toContain("export async function GET");
    expect(f).toContain("getProfile");
    expect(f).toContain('from("notifications")');
    expect(f).toContain("company_id");
    expect(f).toContain("recipient_id");
    expect(f).toContain("apiVersion");
  });

  it("requires authentication on the canonical push-subscription endpoint", () => {
    const f = readFileSync(PUSH, "utf8");
    expect(f).toContain("getProfile");
    expect(f).toContain('"unauthorized"');
    expect(f).toContain("401");
  });

  it("has a push subscription POST endpoint that upserts subscriptions per company/user/endpoint", () => {
    const f = readFileSync(PUSH, "utf8");
    expect(f).toContain("Push notification subscription endpoint");
    expect(f).toContain("export async function POST");
    expect(f).toContain("push_subscriptions");
    expect(f).toContain("upsert");
    expect(f).toContain("onConflict");
    expect(f).toContain("company_id");
    expect(f).toContain("user_id");
    expect(f).toContain("endpoint");
    expect(f).toContain("p256dh");
    expect(f).toContain("auth");
  });

  it("validates the push subscription body with Zod", () => {
    const f = readFileSync(PUSH, "utf8");
    expect(f).toContain("z.object");
    expect(f).toContain("z.string().url()");
    expect(f).toContain("safeParse");
  });

  it("creates a push_subscriptions table with company/user scoping and RLS", () => {
    const m = readFileSync(MIGRATION, "utf8");
    expect(m).toContain("create table if not exists push_subscriptions");
    expect(m).toContain("company_id");
    expect(m).toContain("user_id");
    expect(m).toContain("endpoint");
    expect(m).toContain("p256dh");
    expect(m).toContain("auth");
    expect(m).toContain("enable row level security");
    expect(m).toContain("auth.uid() = user_id");
    expect(m).toContain("references users(id)");
    expect(m).toContain("references companies(id)");
  });

  it("never sends or fabricates push messages in the groundwork", () => {
    const f = readFileSync(PUSH, "utf8");
    expect(f).not.toContain("sendNotification");
    expect(f).not.toContain("webpush");
    const m = readFileSync(MIGRATION, "utf8");
    expect(m).not.toContain("sendNotification");
    expect(m).not.toContain("webpush");
  });

  it("keeps the alternate push-subscription endpoint free of message fabrication", () => {
    const f = readFileSync(PUSH_ALT, "utf8");
    expect(f).toContain("push_subscriptions");
    expect(f).toContain("normalizeSubscription");
    expect(f).not.toContain("sendNotification");
    expect(f).not.toContain("webpush");
  });
});
