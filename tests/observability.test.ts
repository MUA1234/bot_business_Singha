import { describe, it, expect } from "vitest";
import { buildLogRecord, redact } from "@/lib/log";
import { probeCount, metricLabel, metricState, value, unavailable } from "@/lib/metric";
import { classifyHealth } from "@/management/ai-manager/health";
import { buildAlerts, topSeverity } from "@/management/ai-manager/alerts";

describe("structured logging + redaction (§WP6.4)", () => {
  it("redacts secret-named keys", () => {
    const out = redact({ user: "sam", apiKey: "abc123", nested: { access_token: "t" } }) as any;
    expect(out.user).toBe("sam");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.nested.access_token).toBe("[redacted]");
  });

  it("redacts secret-shaped values even under innocent keys", () => {
    const out = redact({ note: "key is sk-abcdefghijklmno pushed" }) as any;
    expect(out.note).toContain("[redacted]");
    expect(out.note).not.toContain("sk-abcdefghijklmno");
  });

  it("builds a deterministic record with correlation id and redaction", () => {
    const rec = buildLogRecord("error", "boom token=EAA" + "A".repeat(25), { correlationId: "cor_1", password: "p" }, new Date("2026-08-15T00:00:00Z"));
    expect(rec.ts).toBe("2026-08-15T00:00:00.000Z");
    expect(rec.correlationId).toBe("cor_1");
    expect(rec.fields.password).toBe("[redacted]");
    expect(rec.msg).toContain("[redacted]"); // token in message redacted
  });
});

describe("metric: unavailable vs zero (§WP6.3)", () => {
  it("classifies a thrown query as unavailable, not zero", async () => {
    const m = await probeCount(async () => {
      throw new Error("db down");
    });
    expect(m.state).toBe("unavailable");
    expect(metricLabel(m)).toBe("unavailable");
  });

  it("classifies a returned {error} as unavailable", async () => {
    const m = await probeCount(async () => ({ count: null, error: { message: "denied" } }));
    expect(m.state).toBe("unavailable");
  });

  it("keeps a real zero as zero", async () => {
    const m = await probeCount(async () => ({ count: 0 }));
    expect(metricState(m)).toBe("zero");
    expect(metricLabel(m)).toBe("0");
  });
});

describe("classifyHealth never reports ok when data is unavailable", () => {
  it("raises a warning when any source is unavailable", () => {
    const h = classifyHealth({ failedEvents: value(0), deadLetters: unavailable, outboxFailed: value(0), unprocessedEvents: value(0) });
    expect(h.unavailable).toBe(true);
    expect(h.level).toBe("warn");
    expect(h.issues.join(" ")).toMatch(/unavailable/);
  });

  it("stays critical if a real failure exists even with unavailable data", () => {
    const h = classifyHealth({ failedEvents: value(3), deadLetters: unavailable, outboxFailed: value(0), unprocessedEvents: value(0) });
    expect(h.level).toBe("critical");
  });

  it("is ok when everything reads clean", () => {
    const h = classifyHealth({ failedEvents: value(0), deadLetters: value(0), outboxFailed: value(0), unprocessedEvents: value(0) });
    expect(h.level).toBe("ok");
    expect(h.unavailable).toBe(false);
  });
});

describe("alert engine (§WP6.5)", () => {
  it("ranks critical signals first", () => {
    const alerts = buildAlerts({
      failedEvents: 2,
      deadLetters: 1,
      outboxFailed: 1,
      repeatedAiFailures: 4,
      accountingIntegrityBreaches: 1,
      migrationMismatch: true,
    });
    expect(alerts[0]!.severity).toBe("critical");
    expect(topSeverity(alerts)).toBe("critical");
    // criticals precede warnings
    const firstWarningIdx = alerts.findIndex((a) => a.severity === "warning");
    const lastCriticalIdx = alerts.map((a) => a.severity).lastIndexOf("critical");
    expect(lastCriticalIdx).toBeLessThan(firstWarningIdx);
  });

  it("returns nothing when all clear", () => {
    const alerts = buildAlerts({ failedEvents: 0, deadLetters: 0, outboxFailed: 0, repeatedAiFailures: 0, accountingIntegrityBreaches: 0, migrationMismatch: false });
    expect(alerts).toHaveLength(0);
    expect(topSeverity(alerts)).toBeNull();
  });
});
