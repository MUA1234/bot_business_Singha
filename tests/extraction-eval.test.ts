import { describe, it, expect } from "vitest";
import { parseAiExtraction } from "@/schemas/ai-extraction";
import { EXTRACTION_CASES, baseExtraction } from "@/ai/evals/extraction";

describe("extraction schema gate (§WP5.8 dataset)", () => {
  for (const c of EXTRACTION_CASES) {
    it(c.name, () => {
      expect(parseAiExtraction(c.raw).ok).toBe(c.expectValid);
    });
  }
});

describe("uncertainty is preserved through the schema", () => {
  it("captures low confidence, missing fields and the clarify recommendation", () => {
    const res = parseAiExtraction(
      baseExtraction({
        amount: null,
        confidence: { overall: 0.15 },
        missing_fields: ["amount", "counterparty"],
        risk_flags: ["low_confidence", "missing_evidence"],
        recommended_action: "request_clarification",
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.confidence.overall).toBeLessThan(0.3);
      expect(res.value.missing_fields).toContain("amount");
      expect(res.value.risk_flags).toContain("low_confidence");
      expect(res.value.recommended_action).toBe("request_clarification");
    }
  });

  it("a prompt-injection flag survives as data, not an instruction", () => {
    const res = parseAiExtraction(baseExtraction({ risk_flags: ["prompt_injection_detected"], recommended_action: "flag_for_review" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.risk_flags).toContain("prompt_injection_detected");
  });
});
