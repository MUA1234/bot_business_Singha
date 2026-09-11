/**
 * Regression tests for a LIVE lockout found on 2026-09-11.
 *
 * Four production accounts (`shanaka`, `thilak`, `kamal`, `nambi`) were created in the
 * `admin` DEPARTMENT without admin RIGHTS. Login redirected on department alone
 * (`/app/admin`), and `/app/admin` gates on `requireAdmin()`, which bounced a non-admin back
 * to `/app/${p.department}` — i.e. `/app/admin` again. An infinite redirect: those four
 * employees could not open the application at all.
 *
 * `landingPathFor` is now the single resolver every gate and redirect shares, so the loop is
 * structurally impossible rather than avoided by convention.
 */
import { describe, it, expect } from "vitest";
import {
  ADMIN_DEPARTMENT,
  DEPARTMENTS,
  landingPathFor,
  navDepartmentFor,
  PERSONAL_DEPARTMENT,
} from "@/lib/departments";

describe("landingPathFor", () => {
  it("sends an admin to the admin dashboard", () => {
    expect(landingPathFor({ isAdmin: true, department: "admin" })).toBe("/app/admin");
    // An admin filed under another department still administers.
    expect(landingPathFor({ isAdmin: true, department: "finance" })).toBe("/app/admin");
  });

  it("never sends a non-admin to the admin dashboard (the live lockout)", () => {
    const path = landingPathFor({ isAdmin: false, department: ADMIN_DEPARTMENT });
    expect(path).not.toBe("/app/admin");
    expect(path).toBe("/app/me");
  });

  it("sends a department member to their own dashboard", () => {
    expect(landingPathFor({ isAdmin: false, department: "sales" })).toBe("/app/sales");
    expect(landingPathFor({ isAdmin: false, department: "finance" })).toBe("/app/finance");
  });

  it("falls back to the personal surface for an unknown or missing department", () => {
    expect(landingPathFor({ isAdmin: false, department: "warehouse" })).toBe("/app/me");
    expect(landingPathFor({ isAdmin: false, department: null })).toBe("/app/me");
    expect(landingPathFor({ isAdmin: false, department: undefined })).toBe("/app/me");
  });

  it("resolves to a page that does NOT redirect again, for every catalogued department", () => {
    // The loop existed because a landing page could itself bounce. For a non-admin the target
    // must never be an admin-gated path.
    for (const d of DEPARTMENTS) {
      const path = landingPathFor({ isAdmin: false, department: d.key });
      expect(path.startsWith("/app/admin")).toBe(false);
    }
  });
});

describe("navDepartmentFor", () => {
  it("gives a non-admin in the admin department the personal nav, not the admin nav", () => {
    const dept = navDepartmentFor({ isAdmin: false, department: ADMIN_DEPARTMENT });
    expect(dept.key).toBe(PERSONAL_DEPARTMENT.key);
    // Every link it offers must be openable by a non-admin.
    for (const item of dept.nav) expect(item.href.startsWith("/app/admin")).toBe(false);
  });

  it("gives an admin the admin nav and a member their own", () => {
    expect(navDepartmentFor({ isAdmin: true, department: "sales" }).key).toBe("admin");
    expect(navDepartmentFor({ isAdmin: false, department: "sales" }).key).toBe("sales");
  });

  it("falls back to the personal nav for an unknown department", () => {
    expect(navDepartmentFor({ isAdmin: false, department: "warehouse" }).key).toBe(PERSONAL_DEPARTMENT.key);
  });
});
