/**
 * WRK-002 — Current and future workload with historical capacity.
 *
 * The HR capacity page must be a real runtime entrypoint that lists active
 * employees, reads assigned tasks, and surfaces planned vs actual vs remaining
 * effort using the deterministic capacity engine. Historical snapshots and
 * contracted-hour modelling remain out of scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/hr/capacity/page.tsx";
const HR_HOME = "src/app/app/hr/page.tsx";

describe("WRK-002 — capacity surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const hrHome = readFileSync(HR_HOME, "utf8");

  it("has a real runtime entrypoint under /app/hr/capacity", () => {
    expect(page).toContain("export default async function CapacityPage");
  });

  it("queries active employees and assigned tasks scoped to the company", () => {
    expect(page).toContain('from("profiles")');
    expect(page).toContain('from("tasks")');
    expect(page).toContain("company_id");
    expect(page).toContain("assigned_to");
  });

  it("uses the deterministic capacity-detail engine", () => {
    expect(page).toContain('from "@/modules/work/capacity-detail"');
    expect(page).toContain("computeCapacityDetail");
  });

  it("surfaces planned, actual, remaining and utilization status", () => {
    expect(page).toMatch(/Planned/);
    expect(page).toMatch(/Actual/);
    expect(page).toMatch(/Remaining/);
    expect(page).toContain("utilizationPct");
    expect(page).toContain("overloaded");
  });

  it("is reachable from the HR home and reads capacity snapshots", () => {
    expect(hrHome).toContain('/app/hr/capacity');
    expect(hrHome).toContain('from("capacity_snapshots")');
  });
});
