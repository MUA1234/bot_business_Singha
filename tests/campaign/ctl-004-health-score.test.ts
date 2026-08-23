/**
 * CTL-004 — Explainable business-health score surface.
 *
 * Verifies the health score page and pure helpers are wired and expose
 * inspectable weights, components and deterministic scoring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/command/health/page.tsx";
const MODULE = "src/modules/management/health-score.ts";

describe("CTL-004 — explainable business-health score surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const module = readFileSync(MODULE, "utf8");

  it("imports deterministic health-score helpers", () => {
    expect(page).toContain("computeHealthScore");
    expect(page).toContain("healthScoreStatusTone");
  });

  it("loads the signals needed for the score", () => {
    expect(page).toContain('from("bank_accounts")');
    expect(page).toContain('from("cash_accounts")');
    expect(page).toContain('from("payments")');
    expect(page).toContain('from("customer_invoices")');
    expect(page).toContain('from("supplier_bills")');
    expect(page).toContain('from("tasks")');
    expect(page).toContain('from("capacity_snapshots")');
    expect(page).toContain('from("risks")');
    expect(page).toContain('from("incidents")');
    expect(page).toContain('from("obligations")');
  });

  it("exports pure deterministic helpers", () => {
    expect(module).toContain("export function computeHealthScore");
    expect(module).toContain("export function healthScoreWeights");
    expect(module).toContain("export function healthScoreStatusTone");
  });

  it("exposes inspectable weights and components", () => {
    expect(module).toContain("weights");
    expect(module).toContain("components");
    expect(module).toContain("contribution");
  });

  it("renders the score, status, breakdown table and issues", () => {
    expect(page).toContain("Health score");
    expect(page).toContain("Score breakdown");
    expect(page).toContain("health.issues");
    expect(page).toContain("health.components");
  });

  it("links from the Command Centre", () => {
    const command = readFileSync("src/app/app/command/page.tsx", "utf8");
    expect(command).toContain('href="/app/command/health"');
  });
});
