import { describe, it, expect } from "vitest";
import { priceTable, computeCostUsd, type TokenPrice } from "@/ai/pricing";

describe("priceTable", () => {
  it("includes the static defaults", () => {
    const t = priceTable({});
    expect(t["gpt-4o-mini"]).toEqual({ input: 0.15, output: 0.6 });
    expect(t["gpt-5.6-sol"]).toBeUndefined(); // no env price → not present
  });

  it("adds gpt-5.6-sol when env prices are configured", () => {
    const t = priceTable({
      OPENAI_PRICE_GPT56_INPUT_PER_MTOK: "3",
      OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK: "12",
    });
    expect(t["gpt-5.6-sol"]).toEqual({ input: 3, output: 12 });
  });

  it("ignores malformed/negative env prices", () => {
    expect(priceTable({ OPENAI_PRICE_GPT56_INPUT_PER_MTOK: "abc", OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK: "1" })["gpt-5.6-sol"]).toBeUndefined();
    expect(priceTable({ OPENAI_PRICE_GPT56_INPUT_PER_MTOK: "-1", OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK: "1" })["gpt-5.6-sol"]).toBeUndefined();
  });
});

describe("computeCostUsd", () => {
  const prices: Record<string, TokenPrice> = { "gpt-5.6-sol": { input: 3, output: 12 } };

  it("computes cost from injected prices (6dp string, no float in ledger)", () => {
    // 1,000,000 input @3 + 500,000 output @12 = 3 + 6 = 9.000000
    expect(computeCostUsd("gpt-5.6-sol", 1_000_000, 500_000, prices)).toBe("9.000000");
  });

  it("scales small token counts correctly", () => {
    // 1200 in @3 + 800 out @12 = 0.0036 + 0.0096 = 0.0132
    expect(computeCostUsd("gpt-5.6-sol", 1200, 800, prices)).toBe("0.013200");
  });

  it("records an explicit 0 for an unpriced model (no guessing)", () => {
    expect(computeCostUsd("gpt-5.6-sol", 1000, 1000, {})).toBe("0");
    expect(computeCostUsd("unknown-model", 1000, 1000, prices)).toBe("0");
  });
});
