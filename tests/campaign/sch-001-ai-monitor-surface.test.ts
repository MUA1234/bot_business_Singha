/**
 * SCH-001 — Scheduled conversation analysis.
 *
 * The AI monitor cron route must be a real runtime entrypoint that is CRON_SECRET-gated,
 * reads WhatsApp conversations with new inbound activity, calls the conversation analysis
 * service, updates the analysed timestamp, and writes an audit record.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE = "src/app/api/cron/ai-monitor/route.ts";

describe("SCH-001 — AI monitor cron surface", () => {
  const route = readFileSync(ROUTE, "utf8");

  it("has a real runtime entrypoint under /api/cron/ai-monitor", () => {
    expect(route).toContain("export async function GET");
  });

  it("is fail-closed on missing or wrong CRON_SECRET", () => {
    expect(route).toContain("CRON_SECRET");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain('status: 401');
  });

  it("reads wa_conversations with new inbound activity since last analysis", () => {
    expect(route).toContain('from("wa_conversations")');
    expect(route).toContain("last_inbound_at");
    expect(route).toContain("ai_analyzed_at");
  });

  it("calls the conversation analysis service and bounds the batch", () => {
    expect(route).toContain("analyzeConversationThread");
    expect(route).toContain(".slice(0, BATCH)");
    expect(route).toContain("const BATCH = 15");
  });

  it("updates ai_analyzed_at and writes a monitor.analyzed audit event", () => {
    expect(route).toContain('update({ ai_analyzed_at:');
    expect(route).toContain('action: "monitor.analyzed"');
    expect(route).toContain("writeAudit");
  });
});
