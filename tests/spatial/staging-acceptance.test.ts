/**
 * Staging acceptance tests for the spatial workspace.
 *
 * These tests verify role-based capability filtering and tenant isolation
 * against a real Supabase-compatible environment. They skip unless the required
 * service-role credentials are supplied via environment variables.
 *
 * Required env:
 *   SPATIAL_SCREENSHOT_SUPABASE_URL       (or NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)
 *   SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY   (or SUPABASE_SERVICE_ROLE_KEY)
 *   SPATIAL_SCREENSHOT_ANON_KEY           (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   SPATIAL_SCREENSHOT_OWNER_PASSWORD
 *   SPATIAL_SCREENSHOT_MANAGER_PASSWORD
 *   SPATIAL_SCREENSHOT_STAFF_PASSWORD
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WINDOW_SPECS } from "@/components/spatial/windowSpecs";
import { seedForStaging } from "../../scripts/verify/staging-seed.mjs";

const url =
  process.env.SPATIAL_SCREENSHOT_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL;
const serviceRoleKey =
  process.env.SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey =
  process.env.SPATIAL_SCREENSHOT_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";
const enabled = !!(url && serviceRoleKey && anonKey);

const WINDOW_TYPES = WINDOW_SPECS.map((s) => s.type);

function requiredModuleCapabilities(type: string): string[] {
  return WINDOW_SPECS.find((s) => s.type === type)?.requiredCapabilities ?? [];
}

async function signIn(supabase: SupabaseClient, email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in failed for ${email}: ${error.message}`);
  return data.session;
}

function sessionClient(session: { access_token: string; refresh_token: string }) {
  if (!url) throw new Error("Missing Supabase URL");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
}

describe("spatial workspace staging acceptance", () => {
  let seeded: Awaited<ReturnType<typeof seedForStaging>> | undefined;
  let admin: SupabaseClient | undefined;

  beforeAll(async () => {
    if (!enabled) return;
    admin = createClient(url!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    seeded = await seedForStaging();
  });

  afterAll(async () => {
    if (admin) {
      await admin.auth.signOut();
    }
  });

  it("skips when no staging database is configured", () => {
    if (!enabled) {
      expect(enabled).toBe(false);
    }
  });

  describe("role capability filtering", () => {
    it("owner can open every registered module", async () => {
      if (!enabled || !seeded) return;
      const allowed = await resolveAllowedModules(admin!, seeded.companyId, seeded.owner.id);
      expect(allowed).toEqual(expect.arrayContaining(WINDOW_TYPES));
      expect(allowed).toHaveLength(WINDOW_TYPES.length);
    });

    it("manager is blocked from finance, approvals, vehicles, purchase-orders and risks", async () => {
      if (!enabled || !seeded) return;
      const allowed = await resolveAllowedModules(admin!, seeded.companyId, seeded.manager.id);
      expect(allowed).toContain("command");
      expect(allowed).toContain("tasks");
      expect(allowed).toContain("projects");
      expect(allowed).toContain("customers");
      expect(allowed).toContain("staff");
      expect(allowed).not.toContain("finance");
      expect(allowed).not.toContain("approvals");
      expect(allowed).not.toContain("vehicles");
      expect(allowed).not.toContain("purchase-orders");
      expect(allowed).not.toContain("risks");
    });

    it("staff can only open unrestricted and task modules", async () => {
      if (!enabled || !seeded) return;
      const allowed = await resolveAllowedModules(admin!, seeded.companyId, seeded.staff.id);
      expect(allowed).toEqual(["command", "ai-recommendations", "tasks", "system-health"]);
    });
  });

  describe("tenant isolation", () => {
    it("signed-in owner only sees tasks from their own company", async () => {
      if (!enabled || !seeded) return;
      const session = await signIn(admin!, seeded!.ownerEmail, seeded!.ownerPassword);
      const client = sessionClient(session);

      const { data: tasks, error } = await client
        .from("tasks")
        .select("id, company_id")
        .order("created_at", { ascending: false })
        .limit(100);

      expect(error).toBeNull();
      expect(tasks?.length).toBeGreaterThan(0);
      for (const t of tasks ?? []) {
        expect(t.company_id).toBe(seeded.companyId);
      }
    });

    it("signed-in staff cannot read the owner's journal entries", async () => {
      if (!enabled || !seeded) return;
      const session = await signIn(admin!, seeded!.staffEmail, seeded!.staffPassword);
      const client = sessionClient(session);

      const { data: journals, error } = await client
        .from("journal_entries")
        .select("id, company_id")
        .limit(100);

      expect(error).toBeNull();
      expect(journals ?? []).toHaveLength(0);
    });

    it("a task seeded for another company is invisible to all seeded users", async () => {
      if (!enabled || !seeded) return;
      const otherCompanyId = "00000000-0000-0000-0000-00000000dead";
      // Service role inserts an isolated task row (does not commit a journal).
      const { data: task, error: insertErr } = await admin!
        .from("tasks")
        .insert({
          company_id: otherCompanyId,
          title: "[staging-acceptance] cross-tenant probe",
          status: "in_progress",
          priority: 3,
        })
        .select("id")
        .single();

      expect(insertErr).toBeNull();

      for (const email of [seeded!.ownerEmail, seeded!.managerEmail, seeded!.staffEmail]) {
        const password = email === seeded!.ownerEmail
          ? seeded!.ownerPassword
          : email === seeded!.managerEmail
            ? seeded!.managerPassword
            : seeded!.staffPassword;
        const session = await signIn(admin!, email, password);
        const client = sessionClient(session);
        const { data } = await client
          .from("tasks")
          .select("id")
          .eq("id", task!.id)
          .maybeSingle();
        expect(data).toBeNull();
      }

      // Clean up the probe row using service role.
      await admin!.from("tasks").delete().eq("id", task!.id);
    });
  });
});

async function resolveAllowedModules(
  admin: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<string[]> {
  const { data: memberships } = await admin
    .from("memberships")
    .select("id, status")
    .eq("user_id", userId)
    .eq("company_id", companyId);

  if (!memberships || memberships.length === 0) return [];
  const activeIds = memberships.filter((m) => m.status === "active").map((m) => m.id);
  if (activeIds.length === 0) return [];

  const { data: roleRows } = await admin
    .from("membership_roles")
    .select("role_key")
    .in("membership_id", activeIds);

  const roleKeys = [...new Set((roleRows ?? []).map((r) => r.role_key))];
  const { data: permRows } = await admin
    .from("role_permissions")
    .select("permission_key")
    .in("role_key", roleKeys);

  const granted = new Set((permRows ?? []).map((p) => p.permission_key));

  const allowed: string[] = [];
  for (const spec of WINDOW_SPECS) {
    const required = spec.requiredCapabilities ?? [];
    if (required.length === 0 || required.every((cap) => granted.has(cap))) {
      allowed.push(spec.type);
    }
  }
  return allowed;
}
