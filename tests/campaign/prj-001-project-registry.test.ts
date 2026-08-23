/**
 * PRJ-001 — Reusable project registry with lifecycle states.
 *
 * The operations projects page must be a real runtime entrypoint that lists
 * company-scoped projects and their lifecycle status.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/operations/projects/page.tsx";
const OPS_HOME = "src/app/app/operations/page.tsx";

describe("PRJ-001 — project registry surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const opsHome = readFileSync(OPS_HOME, "utf8");

  it("has a real runtime entrypoint under /app/operations/projects", () => {
    expect(page).toContain("export default async function ProjectsPage");
  });

  it("queries the projects table", () => {
    expect(page).toContain('from("projects")');
  });

  it("is company-scoped", () => {
    expect(page).toContain("requireDepartment(\"operations\")");
    expect(page).toContain("company_id");
  });

  it("renders project lifecycle status", () => {
    expect(page).toMatch(/Project registry/);
    expect(page).toContain("status");
    expect(page).toContain("active");
    expect(page).toContain("on_hold");
    expect(page).toContain("completed");
  });

  it("links the operations home to the projects page", () => {
    expect(opsHome).toContain('/app/operations/projects');
  });
});
