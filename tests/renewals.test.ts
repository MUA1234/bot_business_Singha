import { describe, it, expect } from "vitest";
import { renewalStatus, detectRenewals, type RenewalItem } from "@/management/ai-manager/renewals";

const NOW = new Date("2026-08-05T00:00:00Z");
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe("renewal / expiry detector (change plan §9.3, §9.4)", () => {
  it("classifies status", () => {
    expect(renewalStatus(null, NOW)).toBe("none");
    expect(renewalStatus(iso(-1), NOW)).toBe("expired");
    expect(renewalStatus(iso(10), NOW)).toBe("due_soon");
    expect(renewalStatus(iso(120), NOW)).toBe("upcoming");
  });

  it("returns only expired + due-soon, worst-first", () => {
    const items: RenewalItem[] = [
      { id: "a", label: "insurance", dueDate: iso(120) }, // upcoming — excluded
      { id: "b", label: "permit", dueDate: iso(-5) }, // expired
      { id: "c", label: "licence", dueDate: iso(10) }, // due soon
      { id: "d", label: "none", dueDate: null }, // excluded
    ];
    const alerts = detectRenewals(items, NOW);
    expect(alerts.map((a) => a.id)).toEqual(["b", "c"]);
    expect(alerts[0]?.severity).toBe("critical");
    expect(alerts[1]?.severity).toBe("warn");
  });

  it("respects a custom soon window", () => {
    const alerts = detectRenewals([{ id: "x", label: "x", dueDate: iso(45) }], NOW, 60);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe("due_soon");
  });
});
