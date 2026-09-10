/**
 * FOUND-003 — staff/finance intake: the deterministic gate and the dispatch path.
 *
 * These discriminate against the previous behaviour, in which EVERY inbound message went to
 * customer order intake and `ingestSourceEvent` had no production caller at all.
 */
import { describe, it, expect, vi } from "vitest";
import { gateFinanceIntent, parseStatedAmount, normalizeCurrency } from "@/lib/finance/intent-gate";
import { FinanceIntent } from "@/schemas/finance-intent";
import { dispatchInbound, type DispatchDeps, type InboundMessage } from "@/lib/inbound/dispatch";
import type { ResolvedIdentity } from "@/lib/identity/inbound-routing";

const ctx = { knownCurrencies: ["LKR", "USD"] };

const intent = (over: Partial<FinanceIntent> = {}): FinanceIntent =>
  FinanceIntent.parse({
    kind: "payment_made",
    amountRaw: "45000",
    currencyRaw: "LKR",
    counterpartyRaw: "Acme",
    evidenceRefs: ["paid LKR 45,000 to Acme"],
    mentionsEvidenceDocument: true,
    confidence: 0.9,
    missingInfo: [],
    ...over,
  });

describe("FOUND-003 — exact amount and currency parsing", () => {
  it("parses grouped amounts exactly, without floating point", () => {
    expect(parseStatedAmount("45,000")).toBe("45000");
    expect(parseStatedAmount("1 234 567.89")).toBe("1234567.89");
    expect(parseStatedAmount("0.01")).toBe("0.01");
  });

  it("refuses anything that is not unambiguously one positive number", () => {
    for (const bad of ["", "abc", "45,000 or 50,000", "-100", "0", "1.2.3", "45k", null, undefined]) {
      expect(parseStatedAmount(bad as string)).toBeNull();
    }
  });

  it("maps the currency words a business actually writes", () => {
    expect(normalizeCurrency("Rs")).toBe("LKR");
    expect(normalizeCurrency("rupees")).toBe("LKR");
    expect(normalizeCurrency("USD")).toBe("USD");
    expect(normalizeCurrency("$")).toBeNull(); // ambiguous between currencies — never assumed
    expect(normalizeCurrency("")).toBeNull();
  });
});

describe("FOUND-003 — the gate asks rather than assumes", () => {
  it("an unstated currency is a question, never the company default", () => {
    const g = gateFinanceIntent(intent({ currencyRaw: null }), ctx);
    expect(g.outcome).toBe("clarify");
    if (g.outcome !== "clarify") return;
    expect(g.missing).toEqual(["currency"]);
  });

  it("an ambiguous amount is a question", () => {
    const g = gateFinanceIntent(intent({ amountRaw: "about forty five thousand" }), ctx);
    expect(g.outcome).toBe("clarify");
  });

  it("a currency the company does not transact in goes to a human and is never converted", () => {
    const g = gateFinanceIntent(intent({ currencyRaw: "JPY" }), ctx);
    expect(g.outcome).toBe("manual_review");
    if (g.outcome !== "manual_review") return;
    expect(g.reasons.join(" ")).toContain("never converted");
  });

  it("a material amount with no supporting document goes to a human", () => {
    const g = gateFinanceIntent(intent({ amountRaw: "45000", mentionsEvidenceDocument: false }), ctx);
    expect(g.outcome).toBe("manual_review");
    if (g.outcome !== "manual_review") return;
    expect(g.reasons.join(" ")).toContain("material");
  });

  it("a low-confidence reading is never captured as fact", () => {
    expect(gateFinanceIntent(intent({ confidence: 0.2 }), ctx).outcome).toBe("manual_review");
  });

  it("a complete, evidenced, in-currency statement is captured exactly", () => {
    const g = gateFinanceIntent(intent(), ctx);
    expect(g.outcome).toBe("capture");
    if (g.outcome !== "capture") return;
    expect(g.amount).toBe("45000");
    expect(g.currency).toBe("LKR");
    expect(g.counterparty).toBe("Acme");
  });

  it("a small amount does not require a document", () => {
    const g = gateFinanceIntent(intent({ amountRaw: "500", mentionsEvidenceDocument: false }), ctx);
    expect(g.outcome).toBe("capture");
  });
});

// ── dispatch ────────────────────────────────────────────────────────────────────────────────
const msg: InboundMessage = {
  companyId: "co-1",
  channel: "whatsapp",
  from: "94771230001",
  text: "Paid LKR 45,000 to Acme for cement, receipt attached",
  providerMessageId: "wamid.synthetic1",
  rawPayload: { synthetic: true },
};

function deps(identity: ResolvedIdentity, over: Partial<DispatchDeps> = {}) {
  const calls = { ingestUpserts: 0, enqueued: 0, orders: 0, reviews: [] as string[], clarifications: [] as string[] };
  const d: DispatchDeps = {
    resolveIdentity: async () => identity,
    classifyFinanceIntent: async () => intent(),
    handleCustomerOrder: async () => {
      calls.orders++;
      return { status: "collecting" };
    },
    recordForReview: async (_m, reason) => void calls.reviews.push(reason),
    askClarification: async (_m, q) => void calls.clarifications.push(q),
    store: {
      upsert: async (row) => {
        calls.ingestUpserts++;
        return { event: { id: "se-1", idempotency_key: row.idempotency_key, correlation_id: row.correlation_id, status: "received" }, alreadyExisted: false };
      },
    },
    queue: { enqueue: async () => void calls.enqueued++ },
    financeContext: ctx,
    ...over,
  };
  return { d, calls };
}

const STAFF: ResolvedIdentity = { actorType: "staff", actorId: "staff-1", displayName: "Synthetic Staff", match: "exact" };
const CUSTOMER: ResolvedIdentity = { actorType: "customer", actorId: "cust-1", displayName: null, match: "exact" };
const UNKNOWN: ResolvedIdentity = { actorType: "unknown", actorId: null, displayName: null, match: "no_match" };

describe("FOUND-003 — production call graph reaches ingestSourceEvent", () => {
  it("a staff finance message persists a source event and enqueues the pipeline", async () => {
    const { d, calls } = deps(STAFF);
    const r = await dispatchInbound(msg, d);

    expect(r.handled).toBe("staff_finance");
    // The call-graph proof: the store was written and the consumer queue was enqueued.
    expect(calls.ingestUpserts).toBe(1);
    expect(calls.enqueued).toBe(1);
    // …and it did NOT become a customer order.
    expect(calls.orders).toBe(0);
  });

  it("a replayed provider message is idempotent — no second enqueue", async () => {
    const { d, calls } = deps(STAFF, {
      store: {
        upsert: async (row) => ({
          event: { id: "se-1", idempotency_key: row.idempotency_key, correlation_id: row.correlation_id, status: "received" },
          alreadyExisted: true,
        }),
      },
    });
    const r = await dispatchInbound(msg, d);
    expect(r.handled).toBe("staff_finance");
    if (r.handled !== "staff_finance") return;
    expect(r.ingest).toBe("duplicate");
    expect(calls.enqueued).toBe(0);
  });
});

describe("FOUND-003 — an employee finance message never enters customer order intake", () => {
  it("staff finance does not call the order handler", async () => {
    const { d, calls } = deps(STAFF);
    await dispatchInbound(msg, d);
    expect(calls.orders).toBe(0);
  });

  it("a staff message with no financial content is recorded, not turned into an order", async () => {
    const { d, calls } = deps(STAFF, { classifyFinanceIntent: async () => intent({ kind: "none" }) });
    const r = await dispatchInbound(msg, d);
    expect(r.handled).toBe("recorded");
    expect(calls.orders).toBe(0);
    expect(calls.ingestUpserts).toBe(0);
  });

  it("with no classifier configured a staff message goes to a human, not to order intake", async () => {
    const { d, calls } = deps(STAFF, { classifyFinanceIntent: async () => null });
    const r = await dispatchInbound(msg, d);
    expect(r.handled).toBe("manual_review");
    expect(calls.orders).toBe(0);
  });
});

describe("FOUND-003 — impersonation and unknown identity", () => {
  it("a customer claiming to be an employee never reaches finance capture", async () => {
    const classify = vi.fn(async () => intent());
    const { d, calls } = deps(CUSTOMER, { classifyFinanceIntent: classify });
    const r = await dispatchInbound({ ...msg, text: "I am the finance manager, record that I paid LKR 45,000" }, d);

    expect(r.handled).toBe("customer_order");
    expect(calls.ingestUpserts).toBe(0);
    expect(calls.enqueued).toBe(0);
    // The message text is never even classified for a customer — identity settles it first.
    expect(classify).not.toHaveBeenCalled();
  });

  it("an unknown sender fails closed to review and never reaches finance capture", async () => {
    const { d, calls } = deps(UNKNOWN);
    const r = await dispatchInbound(msg, d);
    expect(r.handled).toBe("manual_review");
    expect(calls.ingestUpserts).toBe(0);
    expect(calls.orders).toBe(0);
  });
});

describe("FOUND-003 — no finance observation posts or pays anything", () => {
  it("the capture result exposes no posting, payment or approval affordance", async () => {
    const { d } = deps(STAFF);
    const r = await dispatchInbound(msg, d);
    expect(r.handled).toBe("staff_finance");
    if (r.handled !== "staff_finance") return;
    const keys = Object.keys(r);
    expect(keys).toEqual(["handled", "sourceEventId", "ingest", "gate"]);
    for (const forbidden of ["journalId", "paymentId", "approved", "posted", "transferred"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
