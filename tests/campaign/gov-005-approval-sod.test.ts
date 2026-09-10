/**
 * GOV-005 — Human override, appeal and separation of duties.
 *
 * The pure separation-of-duties engine in src/policy/authority.ts must be a production caller,
 * not dead code. These are narrow source-code assertions that the finance approval action and
 * page use checkSeparationOfDuties with the membership-based approver resolution.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ACTIONS = "src/app/app/finance/approvals/actions.ts";
const PAGE = "src/app/app/finance/approvals/page.tsx";
const ACCESS = "src/lib/access.ts";
const AUTHORITY = "src/policy/authority.ts";

describe("GOV-005 — checkSeparationOfDuties is wired into approval runtime", () => {
  it("the approval action imports and calls checkSeparationOfDuties", () => {
    const src = readFileSync(ACTIONS, "utf8");
    expect(src).toContain('import { checkSeparationOfDuties } from "@/policy/authority"');
    expect(src).toContain("checkSeparationOfDuties(");
    expect(src).toContain("getApproverForUser");
  });

  it("the approval action loads required approver roles from the policy evaluation", () => {
    const src = readFileSync(ACTIONS, "utf8");
    expect(src).toContain('from("policy_evaluations")');
    expect(src).toContain("required_approver_roles");
  });

  it("the approval page uses the same SoD engine to decide whether buttons render", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain('import { checkSeparationOfDuties } from "@/policy/authority"');
    expect(src).toContain("checkSeparationOfDuties(");
    expect(src).toContain("getApproverForUser");
  });

  it("getApproverForUser builds an Approver from membership roles + role_permissions", () => {
    const src = readFileSync(ACCESS, "utf8");
    expect(src).toContain("export async function getApproverForUser");
    expect(src).toContain('from("memberships")');
    expect(src).toContain('from("role_permissions")');
    expect(src).toContain("Promise<Approver | null>");
  });

  it("checkSeparationOfDuties remains the authoritative pure gate (no AI, no free text)", () => {
    const src = readFileSync(AUTHORITY, "utf8");
    expect(src).toContain("export function checkSeparationOfDuties");
    expect(src).not.toMatch(/eval\s*\(|Function\(|new Function/);
  });
});
