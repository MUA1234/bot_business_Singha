/**
 * Regression tests for the constants that were compiled into the pipeline (migration 0069).
 *
 * Found while verifying a live order on 2026-09-01: the order reached the database correctly,
 * but BOTH price confirmations went to `sales` because the department was the literal
 * `"sales"`, and the company was the literal `DEFAULT_COMPANY_ID`. Neither was routing — both
 * were constants that happened to be right for the pilot company.
 */
import { describe, it, expect } from "vitest";
import { resolveRouteDepartment } from "@/lib/quotations";
import { extractTextMessages } from "@/lib/whatsapp-inbound";

const ACTIVE = ["admin", "sales", "finance", "procurement", "fleet", "operations"] as const;

describe("price-confirmation department routing", () => {
  it("uses the matched catalogue product's department first", () => {
    expect(resolveRouteDepartment("procurement", "finance", "sales", ACTIVE)).toBe("procurement");
  });

  it("falls back to the company default when the product names none", () => {
    expect(resolveRouteDepartment(null, "finance", undefined, ACTIVE)).toBe("finance");
  });

  it("falls back to an explicit caller override before the historical default", () => {
    expect(resolveRouteDepartment(null, null, "fleet", ACTIVE)).toBe("fleet");
  });

  it("keeps today's behaviour when nothing is configured", () => {
    // A company that configures nothing must behave exactly as before this change.
    expect(resolveRouteDepartment(null, null, undefined, ACTIVE)).toBe("sales");
  });

  it("REFUSES a department that is not in the active catalogue", () => {
    // Routing to a queue no dashboard renders strands the customer silently — worse than
    // the old constant, because it looks routed.
    expect(resolveRouteDepartment("warehouse", null, undefined, ACTIVE)).toBe("sales");
    expect(resolveRouteDepartment(null, "legal", null, ACTIVE)).toBe("sales");
  });

  it("skips an invalid product department and still honours a valid company default", () => {
    expect(resolveRouteDepartment("nonsense", "finance", undefined, ACTIVE)).toBe("finance");
  });
});

describe("inbound webhook — company routing key", () => {
  const payload = {
    entry: [
      {
        id: "WABA_123",
        changes: [
          {
            value: {
              metadata: { display_phone_number: "94701135556", phone_number_id: "1275751638951205" },
              messages: [{ id: "wamid.A", from: "94713147470", type: "text", text: { body: "Hi" } }],
            },
          },
        ],
      },
    ],
  };

  it("carries the receiving phone_number_id and WABA id through", () => {
    const [m] = extractTextMessages(payload);
    // Without this the pipeline cannot know which company was messaged, which is exactly
    // why it fell back to a hardcoded company id.
    expect(m).toMatchObject({
      id: "wamid.A",
      from: "94713147470",
      text: "Hi",
      phoneNumberId: "1275751638951205",
      wabaId: "WABA_123",
    });
  });

  it("yields null (never a guess) when Meta omits the metadata", () => {
    const [m] = extractTextMessages({
      entry: [{ changes: [{ value: { messages: [{ id: "x", from: "y", type: "text", text: { body: "z" } }] } }] }],
    });
    expect(m?.phoneNumberId).toBeNull();
    expect(m?.wabaId).toBeNull();
  });

  it("ignores non-text and malformed events without throwing", () => {
    expect(extractTextMessages({ entry: [{ changes: [{ value: { messages: [{ id: "1", from: "2", type: "image" }] } }] }] })).toEqual([]);
    expect(extractTextMessages({})).toEqual([]);
    expect(extractTextMessages(null)).toEqual([]);
    expect(extractTextMessages({ entry: [{ changes: [{ value: { statuses: [{ id: "s" }] } }] }] })).toEqual([]);
  });

  it("tags each message in a multi-number batch with its own receiving number", () => {
    const multi = {
      entry: [
        { id: "W1", changes: [{ value: { metadata: { phone_number_id: "NUM_A" }, messages: [{ id: "a", from: "1", type: "text", text: { body: "A" } }] } }] },
        { id: "W2", changes: [{ value: { metadata: { phone_number_id: "NUM_B" }, messages: [{ id: "b", from: "2", type: "text", text: { body: "B" } }] } }] },
      ],
    };
    expect(extractTextMessages(multi).map((m) => m.phoneNumberId)).toEqual(["NUM_A", "NUM_B"]);
  });
});
