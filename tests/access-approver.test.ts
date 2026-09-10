/**
 * GOV-005 — membership-based approver resolution for separation-of-duties.
 *
 * getApproverForUser must read the active membership, its roles, and the permissions those
 * roles carry. It is the bridge that turns the membership model into the pure Approver type
 * consumed by checkSeparationOfDuties / checkAuthority.
 */
import { describe, it, expect, vi } from "vitest";

/**
 * The mock models the database as PostgREST actually behaves.
 *
 * It previously returned `membership_roles` EMBEDDED inside the memberships
 * row. The real database can never answer that query: `membership_roles` holds
 * two foreign keys into `memberships` (the single-column `membership_id` and
 * the composite `(membership_id, company_id)`), so PostgREST refuses the embed
 * as ambiguous and returns an error with `data: null`.
 *
 * Because the mock supplied a shape the database never produces, this suite
 * passed while `getApproverForUser` returned null for every real user and no
 * approval could be granted through the interface. Roles are therefore served
 * here as their own table read, exactly as the code now performs it.
 */
const makeDb = (rows: any[] | null, permRows: any[] | null = null, roleRows: any[] | null = null) => {
  const membershipResult = { data: rows, error: null };
  let permResult: any = { data: permRows, error: null };
  const roleResult = { data: roleRows ?? [], error: null };
  const makeChain = (result: any): any => ({
    select: vi.fn(() => makeChain(result)),
    eq: vi.fn(() => makeChain(result)),
    in: vi.fn(() => makeChain(result)),
    limit: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    then: (onFulfilled: any) => Promise.resolve(result).then(onFulfilled),
  });
  const db = {
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: "u1" } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === "memberships") return makeChain(membershipResult);
      if (table === "membership_roles") return makeChain(roleResult);
      if (table === "role_permissions") return makeChain(permResult);
      return makeChain({ data: null, error: null });
    }),
    setPermData: (d: any) => { permResult = { data: d, error: null }; },
  };
  return db;
};

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(() => makeDb(null)),
}));

import { getApproverForUser } from "@/lib/access";

describe("getApproverForUser (GOV-005)", () => {
  it("returns null when the user has no active membership in the company", async () => {
    const { supabaseServer } = await import("@/lib/supabase/server");
    (supabaseServer as any).mockReturnValue(makeDb([]));
    const a = await getApproverForUser("u1", "co1");
    expect(a).toBeNull();
  });

  it("returns roles and permissions for an active membership", async () => {
    const { supabaseServer } = await import("@/lib/supabase/server");
    const db = makeDb(
      [{ id: "m1", status: "active" }],
      [{ permission_key: "approve" }, { permission_key: "reject" }],
      [{ role_key: "finance_reviewer" }],
    );
    (supabaseServer as any).mockReturnValue(db);
    const a = await getApproverForUser("u1", "co1");
    expect(a).not.toBeNull();
    expect(a!.user_id).toBe("u1");
    expect(a!.roles).toEqual(["finance_reviewer"]);
    expect(a!.permissions).toContain("approve");
    expect(a!.permissions).toContain("reject");
  });

  it("filters out unknown role/permission keys (defence in depth)", async () => {
    const { supabaseServer } = await import("@/lib/supabase/server");
    const db = makeDb(
      [{ id: "m1", status: "active" }],
      [{ permission_key: "approve" }, { permission_key: "evil_perm" }],
      [{ role_key: "finance_reviewer" }, { role_key: "evil_role" }],
    );
    (supabaseServer as any).mockReturnValue(db);
    const a = await getApproverForUser("u1", "co1");
    expect(a!.roles).toEqual(["finance_reviewer"]);
    expect(a!.permissions).toEqual(["approve"]);
  });

  it("returns empty permissions when the active membership has no roles", async () => {
    const { supabaseServer } = await import("@/lib/supabase/server");
    const db = makeDb([{ id: "m1", status: "active" }], null, []);
    (supabaseServer as any).mockReturnValue(db);
    const a = await getApproverForUser("u1", "co1");
    expect(a!.roles).toEqual([]);
    expect(a!.permissions).toEqual([]);
  });
});
