import { describe, it, expect } from "vitest";
import { missingConfig, outboxAgeLevel, ledgerIntegrityLevel, backlogLevel, worstLevel } from "@/lib/health-signals";
import { buildAlerts, stampSeen } from "@/management/ai-manager/alerts";

describe("health signals (WP E)", () => {
  it("missingConfig reports absent mandatory keys", () => {
    expect(missingConfig({ A: true, B: false }, ["A", "B", "C"])).toEqual(["B", "C"]);
    expect(missingConfig({ A: true }, ["A"])).toEqual([]);
  });

  it("outboxAgeLevel escalates with age", () => {
    expect(outboxAgeLevel(null)).toBe("ok");
    expect(outboxAgeLevel(5)).toBe("ok");
    expect(outboxAgeLevel(30)).toBe("warn");
    expect(outboxAgeLevel(120)).toBe("crit");
  });

  it("ledgerIntegrityLevel is critical on ANY breach and clean otherwise", () => {
    expect(ledgerIntegrityLevel({ imbalancedJournals: 0, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 })).toEqual({ level: "ok", issues: [] });
    const r = ledgerIntegrityLevel({ imbalancedJournals: 2, headerLineMismatch: 0, orphanedLines: 1, lockedPeriodPostings: 0 });
    expect(r.level).toBe("crit");
    expect(r.issues.length).toBe(2);
  });

  it("backlogLevel and worstLevel combine correctly", () => {
    expect(backlogLevel({ overdueTasks: 5, followUpBacklog: 0, unanalysedConversations: 3 })).toBe("ok");
    expect(backlogLevel({ overdueTasks: 25, followUpBacklog: 0, unanalysedConversations: 0 })).toBe("warn");
    expect(backlogLevel({ overdueTasks: 0, followUpBacklog: 200, unanalysedConversations: 0 })).toBe("crit");
    expect(worstLevel(["ok", "warn", "ok"])).toBe("warn");
    expect(worstLevel(["ok", "warn", "crit"])).toBe("crit");
    expect(worstLevel(["ok", "ok"])).toBe("ok");
  });
});

describe("alerts carry owner + runbook + first/last-seen (WP E.6)", () => {
  it("every alert has an owner and runbook", () => {
    const alerts = buildAlerts({ failedEvents: 1, deadLetters: 1, outboxFailed: 0, repeatedAiFailures: 0, accountingIntegrityBreaches: 1, migrationMismatch: false });
    for (const a of alerts) {
      expect(a.owner).toBeTruthy();
      expect(a.runbook).toMatch(/RUNBOOK|MIGRATION_STATE/);
    }
  });

  it("stampSeen preserves firstSeen and refreshes lastSeen", () => {
    const alerts = buildAlerts({ failedEvents: 1, deadLetters: 0, outboxFailed: 0, repeatedAiFailures: 0, accountingIntegrityBreaches: 0, migrationMismatch: false });
    const now = new Date("2026-08-07T10:00:00Z");
    const stamped = stampSeen(alerts, { failed_events: { firstSeen: "2026-08-01T00:00:00.000Z" } }, now);
    const a = stamped.find((x) => x.key === "failed_events")!;
    expect(a.firstSeen).toBe("2026-08-01T00:00:00.000Z"); // preserved
    expect(a.lastSeen).toBe("2026-08-07T10:00:00.000Z"); // refreshed
  });

  it("stampSeen sets firstSeen=now for a newly-seen alert", () => {
    const alerts = buildAlerts({ failedEvents: 0, deadLetters: 1, outboxFailed: 0, repeatedAiFailures: 0, accountingIntegrityBreaches: 0, migrationMismatch: false });
    const now = new Date("2026-08-07T10:00:00Z");
    const stamped = stampSeen(alerts, {}, now);
    expect(stamped[0]!.firstSeen).toBe("2026-08-07T10:00:00.000Z");
  });
});
