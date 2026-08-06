import { describe, it, expect } from "vitest";
import { aiRunRow } from "@/db/consumer-store";
import type { AiRunRecord } from "@/ai/gateway";

const run: AiRunRecord = {
  ai_run_id: "ai_1",
  route: "management",
  model: "gpt-5.6-sol",
  prompt_version: "mgmt-1.0",
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: "0.0132",
  validation_ok: true,
  confidence_overall: 0.7,
  correlation_id: "cor_x",
  latency_ms: 420,
  source_event_id: "evt-9",
  company_id: "co-a",
};

describe("aiRunRow (§WP5.3 full trail)", () => {
  it("maps the complete trail including company/latency/source-event", () => {
    const row = aiRunRow(run);
    expect(row).toMatchObject({
      id: "ai_1",
      company_id: "co-a",
      route: "management",
      cost_usd: "0.0132",
      input_tokens: 100,
      output_tokens: 50,
      confidence_overall: 0.7,
      correlation_id: "cor_x",
      latency_ms: 420,
      source_event_id: "evt-9",
    });
  });

  it("nulls optional trail fields when absent (never drops the run)", () => {
    const row = aiRunRow({ ...run, company_id: undefined, latency_ms: undefined, source_event_id: undefined, validation_issues: undefined });
    expect(row.company_id).toBeNull();
    expect(row.latency_ms).toBeNull();
    expect(row.source_event_id).toBeNull();
    expect(row.validation_issues).toBeNull();
  });
});
