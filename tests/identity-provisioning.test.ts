/**
 * Tests for the employee membership-identity provisioning added on 2026-09-11.
 *
 * The live defect: the admin panel wrote a `profiles` row only. Migration 0010 had backfilled
 * `users`/`memberships`/`membership_roles` once at migration time, so the five employees
 * created afterwards (2026-09-01) existed for login but were invisible to `has_membership()`,
 * `has_capability()` and `lib/access.ts` — they would be denied outright the moment
 * `RLS_READS`/`RLS_WRITES` become the enforcement path (D-019).
 */
import { describe, it, expect } from "vitest";
import {
  membershipStatusFor,
  provisionEmployeeIdentity,
  rolesForEmployee,
  ROLE_STAFF,
  ROLE_SYSTEM_ADMIN,
  setEmployeeIdentityActive,
} from "@/lib/identity-provisioning";

/**
 * Minimal fake of the Supabase query-builder surface these functions use. Each terminal call
 * records what was written and resolves to a plain `{ data, error }` — never to the builder
 * itself, which would make `await` recurse forever.
 */
interface Recorded {
  table: string;
  op: string;
  payload: unknown;
  filters: Record<string, unknown>;
}

function fakeDb(opts: { failOn?: string } = {}) {
  const calls: Recorded[] = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const settle = (op: string, payload: unknown) => {
      calls.push({ table, op, payload, filters });
      const failed = opts.failOn === table;
      return {
        data: failed ? null : { id: `${table}-row-1` },
        error: failed ? { message: `${table} exploded` } : null,
      };
    };
    const builder = (op: string, payload: unknown) => {
      const result = settle(op, payload);
      const chain: any = {
        select: () => chain,
        maybeSingle: () => Promise.resolve(result),
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return chain;
        },
        // Thenable so a bare `await` on the builder yields the result, not the builder.
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return chain;
    };
    return {
      upsert: (payload: unknown) => builder("upsert", payload),
      update: (payload: unknown) => builder("update", payload),
      insert: (payload: unknown) => builder("insert", payload),
    };
  };
  return { db: { from } as any, calls };
}

describe("rolesForEmployee", () => {
  it("grants every employee the submitter role", () => {
    expect(rolesForEmployee(false)).toEqual([ROLE_STAFF]);
  });
  it("additionally grants an admin the system administrator role", () => {
    expect(rolesForEmployee(true)).toEqual([ROLE_STAFF, ROLE_SYSTEM_ADMIN]);
  });
});

describe("membershipStatusFor", () => {
  it("maps an active profile to an active membership and an inactive one to suspended", () => {
    expect(membershipStatusFor(true)).toBe("active");
    expect(membershipStatusFor(false)).toBe("suspended");
  });
});

describe("provisionEmployeeIdentity", () => {
  it("writes users, memberships and membership_roles — the three tables the defect skipped", async () => {
    const { db, calls } = fakeDb();
    const res = await provisionEmployeeIdentity(db, {
      userId: "u1",
      companyId: "c1",
      fullName: "Kamal",
      isAdmin: false,
    });
    expect(res.ok).toBe(true);
    const tables = calls.map((c) => c.table);
    expect(tables).toContain("users");
    expect(tables).toContain("memberships");
    expect(tables).toContain("membership_roles");
  });

  it("scopes every membership row with the company id (service role bypasses RLS)", async () => {
    const { db, calls } = fakeDb();
    await provisionEmployeeIdentity(db, { userId: "u1", companyId: "c1", isAdmin: true });
    const mem = calls.find((c) => c.table === "memberships");
    expect(mem?.payload).toMatchObject({ company_id: "c1", user_id: "u1", status: "active" });
    const roles = calls.find((c) => c.table === "membership_roles");
    expect(roles?.payload).toEqual([
      { membership_id: "memberships-row-1", company_id: "c1", role_key: ROLE_STAFF },
      { membership_id: "memberships-row-1", company_id: "c1", role_key: ROLE_SYSTEM_ADMIN },
    ]);
  });

  it("reports a failure instead of claiming success, so the caller can roll back", async () => {
    const { db } = fakeDb({ failOn: "memberships" });
    const res = await provisionEmployeeIdentity(db, { userId: "u1", companyId: "c1", isAdmin: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("memberships");
  });

  it("creates a suspended membership for an inactive employee", async () => {
    const { db, calls } = fakeDb();
    await provisionEmployeeIdentity(db, { userId: "u1", companyId: "c1", isAdmin: false, isActive: false });
    expect(calls.find((c) => c.table === "memberships")?.payload).toMatchObject({ status: "suspended" });
  });
});

describe("setEmployeeIdentityActive", () => {
  it("suspends the membership when a profile is deactivated", async () => {
    const { db, calls } = fakeDb();
    const res = await setEmployeeIdentityActive(db, { userId: "u1", companyId: "c1", isActive: false });
    expect(res.ok).toBe(true);
    const mem = calls.find((c) => c.table === "memberships");
    expect(mem?.op).toBe("update");
    expect(mem?.payload).toEqual({ status: "suspended" });
    // Company-scoped, never a bare user id.
    expect(mem?.filters).toMatchObject({ user_id: "u1", company_id: "c1" });
  });

  it("reactivates both models together", async () => {
    const { db, calls } = fakeDb();
    await setEmployeeIdentityActive(db, { userId: "u1", companyId: "c1", isActive: true });
    expect(calls.find((c) => c.table === "memberships")?.payload).toEqual({ status: "active" });
    expect(calls.find((c) => c.table === "users")?.payload).toEqual({ is_active: true });
  });
});
