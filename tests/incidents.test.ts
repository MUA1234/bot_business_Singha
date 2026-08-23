/**
 * RSK-005 — Incident log pure helpers.
 */
import { describe, it, expect } from "vitest";
import { isOpenIncident, severityBadgeClass, sortIncidentsBySeverity } from "@/modules/legal/incidents";

describe("incident helpers", () => {
  it("identifies open incident statuses", () => {
    expect(isOpenIncident("open")).toBe(true);
    expect(isOpenIncident("investigating")).toBe(true);
    expect(isOpenIncident("resolved")).toBe(false);
    expect(isOpenIncident("closed")).toBe(false);
  });

  it("maps severity to badge classes", () => {
    expect(severityBadgeClass("critical")).toBe("danger");
    expect(severityBadgeClass("high")).toBe("warn");
    expect(severityBadgeClass("medium")).toBe("info");
    expect(severityBadgeClass("low")).toBe("");
  });

  it("sorts incidents by severity descending then occurred_at descending", () => {
    const rows = [
      { id: "a", severity: "low" as const, occurred_at: "2026-01-03T00:00:00Z" },
      { id: "b", severity: "critical" as const, occurred_at: "2026-01-01T00:00:00Z" },
      { id: "c", severity: "high" as const, occurred_at: "2026-01-04T00:00:00Z" },
      { id: "d", severity: "critical" as const, occurred_at: "2026-01-05T00:00:00Z" },
    ];
    const sorted = sortIncidentsBySeverity(rows);
    expect(sorted.map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
  });
});
