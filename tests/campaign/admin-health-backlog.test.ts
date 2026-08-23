/**
 * CTL-003 — the 0069 source_event_backlog RPC must be surfaced on the admin health page.
 *
 * The durable inbound pipeline has a company-scoped backlog RPC; this test proves the admin
 * health dashboard actually calls it and renders every column, without masking a read failure
 * as a calm zero.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/health/page.tsx";

describe("CTL-003 — backlog RPC is surfaced on admin health", () => {
  const page = readFileSync(PAGE, "utf8");

  it("calls the migration 0069 backlog RPC with company scope", () => {
    expect(page).toContain('db.rpc("source_event_backlog"');
    expect(page).toContain("p_company: cid");
  });

  it("renders every backlog column from the RPC", () => {
    expect(page).toMatch(/Source-event backlog/);
    expect(page).toContain("Pending");
    expect(page).toContain("Processing");
    expect(page).toContain("Retry wait");
    expect(page).toContain("Expired lease");
    expect(page).toContain("Dead letter");
    expect(page).toContain("Oldest pending");
  });

  it("uses the probeCount/unavailable contract so a failed RPC is not reported as 0", () => {
    expect(page).toContain("probeBacklog");
    expect(page).toContain("allUnavailable");
    expect(page).toContain("backlog.unavailable");
  });

  it("highlights failure-like backlog states (expired lease, dead letter) as dangerous", () => {
    expect(page).toContain("metricState(backlog.expiredLease)");
    expect(page).toContain("metricState(backlog.deadLetter)");
    expect(page).toContain('"var(--danger)"');
  });
});
