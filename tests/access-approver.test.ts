/**
 * GOV-005 — membership-based approver resolution for separation-of-duties.
 *
 * getApproverForUser must read the active membership, its roles, and the permissions those
 * roles carry. It is the bridge that turns the membership model into the pure Approver type
 * consumed by checkSeparationOfDuties / checkAuthority.
 */
import { describe, it, expect, vi } from "vitest";

const makeDb = (rows: any[] | null, permRows: any[] | null = null) => {
  const membershipResult = { data: rows, error: null };
  let permResult: any = { data: permRows, error: null };
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
      [{ id: "m1", status: "active", membership_roles: [{ role_key: "finance_reviewer" }] }],
      [{ permission_key: "approve" }, { permission_key: "reject" }],
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
      [{ id: "m1", status: "active", membership_roles: [{ role_key: "finance_reviewer" }, { role_key: "evil_role" }] }],
      [{ permission_key: "approve" }, { permission_key: "evil_perm" }],
    );
    (supabaseServer as any).mockReturnValue(db);
    const a = await getApproverForUser("u1", "co1");
    expect(a!.roles).toEqual(["finance_reviewer"]);
    expect(a!.permissions).toEqual(["approve"]);
  });

  it("returns empty permissions when the active membership has no roles", async () => {
    const { supabaseServer } = await import("@/lib/supabase/server");
    const db = makeDb([{ id: "m1", status: "active", membership_roles: [] }], null);
    (supabaseServer as any).mockReturnValue(db);
    const a = await getApproverForUser("u1", "co1");
    expect(a!.roles).toEqual([]);
    expect(a!.permissions).toEqual([]);
  });
});
