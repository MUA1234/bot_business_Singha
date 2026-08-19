/**
 * R1 §4 / OF-002 — the production consumer for a captured finance event.
 *
 * `/api/cron/inbound-sweeper` returned `no_processor` for everything, so after migration 0076
 * narrowed claiming to exactly the finance captures, every captured finance message was released
 * back to the queue forever. The pipeline it needed already existed; this connects the sweeper to
 * THAT pipeline rather than growing a second one.
 *
 * These drive the real processor with injected ports: what matters is which outcome each situation
 * produces, and that none of them is a fake success.
 */
import { describe, it, expect, vi } from "vitest";
import { makeFinanceCaptureProcessor, AWAITING_CLASSIFIER, type FinanceCaptureDeps } from "@/events/finance-capture-processor";
import { RetryableExtractionError } from "@/inngest/processing";
import type { SweepableEvent } from "@/events/inbound-sweeper";

const CO = "11111111-1111-1111-1111-111111111111";
const event: SweepableEvent = { id: "evt-1", company_id: CO, source: "whatsapp", attempts: 0 };

const harness = (over: Partial<FinanceCaptureDeps> = {}) => {
  const queued: unknown[] = [];
  const deps: FinanceCaptureDeps = {
    extractionConfigured: () => true,
    companyOf: async () => CO,
    queueForReview: async (i) => { queued.push(i); },
    process: async () => ({ source_event_id: "evt-1", financial_event_id: "fe-1", outcome: "awaiting_approval", ai_ok: true }),
    ...over,
  };
  return { deps, queued, run: makeFinanceCaptureProcessor(deps) };
};

describe("finance capture processor", () => {
  it("a capture WITHOUT a company is refused outright — never processed with a null scope", async () => {
    const h = harness({ companyOf: async () => null });
    const out = await h.run(event);
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ code: "capture_without_company", retryable: false });
    // Duplicate scoring, policy and approval are ALL company-scoped: processing with a null company
    // would silently disable every one of them.
  });

  it("NO PROVIDER: a person gets an actionable queue item, and nothing is reported as processed", async () => {
    const h = harness({ extractionConfigured: () => false });
    const out = await h.run(event);
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ code: "extraction_not_configured", unprocessable: true });
    expect(h.queued).toEqual([{
      sourceEventId: "evt-1",
      companyId: CO,
      reasonCode: AWAITING_CLASSIFIER,
      reasonDetail: expect.stringContaining("no model provider is configured"),
    }]);
  });

  it("no provider → `unprocessable`, which the sweeper RELEASES rather than dead-letters", async () => {
    // The distinction that matters: `retryable: false` would destroy the capture within one cron
    // interval, which is exactly the defect this package exists to fix.
    const h = harness({ extractionConfigured: () => false });
    const out = await h.run(event);
    expect((out as { retryable?: boolean }).retryable).toBeUndefined();
    expect((out as { unprocessable?: boolean }).unprocessable).toBe(true);
  });

  it("the pipeline is REUSED, with the receipt's own id and no model-chosen scope", async () => {
    const seen: unknown[] = [];
    const h = harness({ process: async (i) => { seen.push(i); return { source_event_id: i.source_event_id, financial_event_id: "fe-9", outcome: "approved", ai_ok: true }; } });
    const out = await h.run(event);
    expect(out.ok).toBe(true);
    expect(seen).toEqual([{ source_event_id: "evt-1", correlation_id: "sweep_evt-1" }]);
  });

  it("EVERY pipeline outcome is a real outcome — the receipt is done, the financial event carries on", async () => {
    for (const outcome of ["approved", "awaiting_approval", "awaiting_information", "awaiting_evidence", "duplicate", "rejected"] as const) {
      const h = harness({ process: async () => ({ source_event_id: "evt-1", financial_event_id: "fe-1", outcome, ai_ok: true }) });
      expect((await h.run(event)).ok, outcome).toBe(true);
    }
  });

  it("a TRANSPORT failure is retried; it is not a verdict about the message", async () => {
    const h = harness({ process: async () => { throw new RetryableExtractionError("upstream 503"); } });
    const out = await h.run(event);
    expect(out).toMatchObject({ ok: false, code: "extraction_transport", retryable: true });
  });

  it("any other throw is retried under the sweeper's bounded budget, never swallowed", async () => {
    const h = harness({ process: async () => { throw new Error("kaboom"); } });
    const out = await h.run(event);
    expect(out).toMatchObject({ ok: false, code: "processor_error", retryable: true });
    expect((out as { message: string }).message).toContain("kaboom");
  });

  it("a queue-write failure is NOT swallowed into a success", async () => {
    const h = harness({
      extractionConfigured: () => false,
      queueForReview: async () => { throw new Error("queue down"); },
    });
    // It propagates: the sweeper turns a throwing processor into a failure rather than a silent pass.
    await expect(h.run(event)).rejects.toThrow(/queue down/);
  });

  it("the company comes from the ROW, not from the event the sweeper handed over", async () => {
    const spy = vi.fn(async () => CO);
    const h = harness({ companyOf: spy });
    await h.run({ ...event, company_id: "00000000-0000-0000-0000-00000000dead" });
    expect(spy).toHaveBeenCalledWith("evt-1");
  });
});
