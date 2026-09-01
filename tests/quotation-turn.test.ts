/**
 * Customer-facing WhatsApp order-intake turn (src/ai/quotation.ts).
 *
 * These are regression tests for a LIVE production failure on 2026-09-01: the model returned
 * the customer fields flat and the item text under `item`, so (a) the collected name was
 * silently discarded and the bot asked for it a second time, and (b) the item-bearing turn
 * failed validation, so no order and no quotation were ever created while the conversation
 * still looked healthy. The intake turn had NO test coverage at all before this file.
 *
 * Offline only — the transport is injected, no network, no model id assertions beyond the
 * gateway's own routing table.
 */
import { describe, it, expect } from "vitest";
import { runQuotationTurn, normalizeTurnShape, QUOTATION_TURN_JSON_SCHEMA } from "@/ai/quotation";
import type { CompletionRequest, CompletionTransport } from "@/ai/gateway";

/** Transport that replays one canned body and records what it was asked for. */
function transportReturning(text: string): { t: CompletionTransport; seen: CompletionRequest[] } {
  const seen: CompletionRequest[] = [];
  return {
    seen,
    t: {
      async complete(req) {
        seen.push(req);
        return { text, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: "0" };
      },
    },
  };
}

const INPUT = {
  message: "I need 25 steel roofing sheets and 10 bags of cement",
  state: { name: "Nuwan Perera", address: "42 Galle Road, Colombo 03" },
};

describe("quotation turn — contract shape", () => {
  it("accepts the canonical nested shape", async () => {
    const { t } = transportReturning(
      JSON.stringify({
        reply: "Thanks!",
        customer: { name: "Nuwan Perera", address: "42 Galle Road", email: null },
        items: [{ description: "steel roofing sheets", quantity: 25 }],
        ready_to_quote: true,
        needs_more_info: [],
      }),
    );
    const r = await runQuotationTurn(t, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turn.customer.name).toBe("Nuwan Perera");
    expect(r.turn.items[0]?.description).toBe("steel roofing sheets");
    expect(r.turn.ready_to_quote).toBe(true);
  });

  // The exact body the live model returned for "My name is Nuwan Perera".
  it("recovers the customer name when the model returns it FLAT (the asked-twice bug)", async () => {
    const { t } = transportReturning(
      JSON.stringify({
        name: "Nuwan Perera",
        address: null,
        email: null,
        items: [],
        needs_more_info: ["address"],
        ready_to_quote: false,
        reply: "Thank you, Nuwan.",
      }),
    );
    const r = await runQuotationTurn(t, { message: "My name is Nuwan Perera", state: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turn.customer.name).toBe("Nuwan Perera"); // previously dropped → name asked again
  });

  // The exact body the live model returned for the item message.
  it("recovers items when the model uses `item` instead of `description`", async () => {
    const { t } = transportReturning(
      JSON.stringify({
        ready_to_quote: true,
        items: [
          { item: "Steel roofing sheets", quantity: 25 },
          { item: "Cement bags", quantity: 10 },
        ],
        needs_more_info: [],
        reply: "Thank you, Nuwan.",
      }),
    );
    const r = await runQuotationTurn(t, INPUT);
    expect(r.ok).toBe(true); // previously validation_failed → no order, no quotation
    if (!r.ok) return;
    expect(r.turn.items.map((i) => i.description)).toEqual(["Steel roofing sheets", "Cement bags"]);
    expect(r.turn.items[1]?.quantity).toBe(10);
  });

  it("prefers a nested customer value over a stray flat one", () => {
    const out = normalizeTurnShape({ customer: { name: "Nested" }, name: "Flat" }) as {
      customer: { name: string };
    };
    expect(out.customer.name).toBe("Nested");
  });

  it("coerces a stringified quantity and maps qty", () => {
    const out = normalizeTurnShape({ items: [{ item: "pipes", qty: "12" }] }) as {
      items: { description: string; quantity: number }[];
    };
    expect(out.items[0]).toMatchObject({ description: "pipes", quantity: 12 });
  });

  it("leaves an unrecognised shape alone for Zod to reject", async () => {
    const { t } = transportReturning(JSON.stringify({ nonsense: true }));
    const r = await runQuotationTurn(t, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^validation_failed/);
  });
});

describe("quotation turn — failure reporting", () => {
  it("reports an empty model body distinctly (not as a validation failure)", async () => {
    const { t } = transportReturning("");
    const r = await runQuotationTurn(t, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^no_json_output/);
  });

  it("reports a transport error with its message", async () => {
    const t: CompletionTransport = {
      async complete() {
        throw new Error("OpenAI 429: rate limited");
      },
    };
    const r = await runQuotationTurn(t, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("429");
  });
});

describe("quotation turn — provider-enforced schema", () => {
  it("sends the strict json schema with the request", async () => {
    const { t, seen } = transportReturning(
      JSON.stringify({ reply: "ok", customer: { name: null, address: null, email: null }, items: [], ready_to_quote: false, needs_more_info: [] }),
    );
    await runQuotationTurn(t, INPUT);
    expect(seen[0]?.jsonSchema?.name).toBe("quotation_turn");
  });

  it("the json schema mirrors the Zod contract and carries NO price field (D-017)", () => {
    const props = QUOTATION_TURN_JSON_SCHEMA.schema.properties;
    expect(Object.keys(props).sort()).toEqual(["customer", "items", "needs_more_info", "ready_to_quote", "reply"]);
    expect(JSON.stringify(QUOTATION_TURN_JSON_SCHEMA)).not.toMatch(/price|total|cost|discount/i);
  });
});
