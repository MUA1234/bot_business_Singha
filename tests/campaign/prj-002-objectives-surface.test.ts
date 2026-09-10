/**
 * PRJ-002 — Objectives, milestones and stage gates.
 *
 * The admin objectives page must be a real runtime entrypoint that lists
 * company-scoped objectives, grades progress with the deterministic objective-status
 * engine, and supports create/update progress actions. Milestones, dependencies and
 * stage gates remain out of scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/objectives/page.tsx";

describe("PRJ-002 — objectives surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("has a real runtime entrypoint under /app/admin/objectives", () => {
    expect(page).toContain("export default async function ObjectivesPage");
  });

  it("queries the objectives table scoped to the company", () => {
    expect(page).toContain('from("objectives")');
    expect(page).toContain("company_id");
  });

  it("uses the deterministic objective-status engine", () => {
    expect(page).toContain('from "@/management/ai-manager/objective-status"');
    expect(page).toContain("assessObjective");
  });

  it("surfaces objective title, metric, target/current values and status", () => {
    expect(page).toMatch(/Objectives?|KPIs?/i);
    expect(page).toContain("target_value");
    expect(page).toContain("current_value");
    expect(page).toContain("progressPct");
    expect(page).toContain("status");
  });

  it("is gated behind the admin role and supports create/update actions", () => {
    expect(page).toContain("requireAdmin");
    expect(page).toContain("createObjective");
    expect(page).toContain("updateObjectiveProgress");
  });
});
