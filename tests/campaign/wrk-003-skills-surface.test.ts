/**
 * WRK-003 — Skills, certifications and expiry.
 *
 * The HR staff directory must be a real runtime entrypoint that lists employees
 * with their skills, and the employee record must display and allow editing of
 * skills. Certification expiry and renewal-task creation remain out of scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const LIST_PAGE = "src/app/app/hr/staff/page.tsx";
const DETAIL_PAGE = "src/app/app/hr/staff/[id]/page.tsx";

describe("WRK-003 — skills surface", () => {
  const list = readFileSync(LIST_PAGE, "utf8");
  const detail = readFileSync(DETAIL_PAGE, "utf8");

  it("has a real runtime entrypoint under /app/hr/staff", () => {
    expect(list).toContain("export default async function StaffPage");
  });

  it("queries active employees and surfaces their skills", () => {
    expect(list).toContain('from("profiles")');
    expect(list).toContain("skills");
    expect(list).toContain("company_id");
    expect(list).toMatch(/Skills/);
  });

  it("links from the staff list to the employee record", () => {
    expect(list).toContain('/app/hr/staff/');
  });

  it("shows skills on the employee record and allows editing", () => {
    expect(detail).toContain("skills");
    expect(detail).toContain("updateEmployeeDetails");
    expect(detail).toMatch(/Skills/);
    expect(detail).toContain("company_id");
  });

  it("is gated behind the HR department", () => {
    expect(list).toContain('requireDepartment("hr")');
    expect(detail).toContain('requireDepartment("hr")');
  });
});
