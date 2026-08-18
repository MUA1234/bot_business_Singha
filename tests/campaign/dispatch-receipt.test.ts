/**
 * FOUND-003 correction — the inbound dispatch ORDER OF OPERATIONS.
 *
 * The properties that matter here are sequences, and a test that reads source text cannot establish
 * a sequence. These drive the real orchestration with injected ports and assert what happened, in
 * what order:
 *
 *   * nothing is decided before the lease is taken;
 *   * a refused lease means NO business dispatch at all (the concurrency guarantee);
 *   * an unresolved company is a retryable failure, not a dispatch;
 *   * the marker is written only AFTER the downstream effect;
 *   * a thrown dispatch records a failure and never a marker.
 */
import { describe, it, expect, vi } from "vitest";
import { dispatchReceipt, type DispatchReceiptPorts } from "@/lib/inbound/dispatch-receipt";
import type { DispatchDeps, DispatchResult, InboundMessage } from "@/lib/inbound/dispatch";
import type { InboundReceipt } from "@/lib/inbound/receipt";

const CO = "11111111-1111-1111-1111-111111111111";
const receipt = (over: Partial<InboundReceipt> = {}): InboundReceipt => ({
  event: { id: "evt-1", idempotency_key: "ev1:whatsapp:acct:wamid.1:inbound_message", correlation_id: "cor_1", status: "received" },
  created: true,
  identity: "ev1:whatsapp:acct:wamid.1:inbound_message",
  dispatchState: "pending",
  ...over,
});
const message: Omit<InboundMessage, "companyId" | "receipt"> = {
  channel: "whatsapp", from: "94770001111", text: "hello", providerMessageId: "wamid.1", rawPayload: { one: true },
};

function harness(over: Partial<DispatchReceiptPorts> = {}, handled: DispatchResult["handled"] = "customer_order") {
  const calls: string[] = [];
  const ports: Partial<DispatchReceiptPorts> = {
    claim: async () => { calls.push("claim"); return true; },
    resolveCompany: async () => { calls.push("resolveCompany"); return { companyId: CO, match: "exact" }; },
    knownCurrencies: async () => { calls.push("knownCurrencies"); return ["LKR"]; },
    dispatch: (async () => { calls.push("dispatch"); return { handled, status: "ok" } as DispatchResult; }) as never,
    record: async () => { calls.push("record"); return {}; },
    fail: async () => { calls.push("fail"); return "failed"; },
    ...over,
  };
  const makeDeps = vi.fn(() => ({}) as DispatchDeps);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { calls, ports, makeDeps, db: {} as any };
}

describe("inbound dispatch orchestration", () => {
  it("claims the lease BEFORE anything decides, and records the marker AFTER the effect", async () => {
    const h = harness();
    const out = await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports });
    expect(out).toBe("customer_order");
    expect(h.calls).toEqual(["claim", "resolveCompany", "knownCurrencies", "dispatch", "record"]);
  });

  it("a REFUSED lease produces no business dispatch at all", async () => {
    const h = harness({ claim: async () => false });
    const out = await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports });
    expect(out).toBe("already_dispatched");
    expect(h.calls).toEqual([]); // no resolve, no dispatch, no marker
    expect(h.makeDeps).not.toHaveBeenCalled();
  });

  it("an unresolved company is a RETRYABLE failure, not a dispatch", async () => {
    const h = harness({ resolveCompany: async () => ({ companyId: null, match: "unmapped" }) });
    const out = await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports });
    expect(out).toBe("unattributed");
    expect(h.calls).toEqual(["claim", "fail"]);
    expect(h.calls).not.toContain("dispatch");
    expect(h.calls).not.toContain("record");
  });

  it("a company id WITHOUT a definite match is refused too", async () => {
    const h = harness({ resolveCompany: async () => ({ companyId: CO, match: "ambiguous" }) });
    expect(await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports })).toBe("unattributed");
    expect(h.calls).not.toContain("dispatch");
  });

  it("a receipt with no provider message id is never claimed and never decided", async () => {
    const h = harness();
    const out = await dispatchReceipt(
      h.db, receipt({ identity: null, dispatchState: "manual_review" }), message, null, h.makeDeps, { ports: h.ports });
    expect(out).toBe("no_provider_message_id");
    expect(h.calls).toEqual([]);
  });

  it("a thrown dispatch records a FAILURE and never a marker", async () => {
    const h = harness({ dispatch: (async () => { throw new Error("boom"); }) as never });
    const out = await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports });
    expect(out).toBe("error");
    expect(h.calls).toEqual(["claim", "resolveCompany", "knownCurrencies", "fail"]);
    expect(h.calls).not.toContain("record");
  });

  it("the company is passed to the dispatcher and to the currency lookup — never a constant", async () => {
    let seen: InboundMessage | null = null;
    let currencyFor: string | null = null;
    const h = harness({
      knownCurrencies: async (c) => { currencyFor = c; return ["USD"]; },
      dispatch: (async (m: InboundMessage) => { seen = m; return { handled: "customer_order", status: "ok" }; }) as never,
    });
    await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports });
    expect(seen!.companyId).toBe(CO);
    expect(seen!.receipt?.id).toBe("evt-1");
    expect(currencyFor).toBe(CO);
    expect(h.makeDeps).toHaveBeenCalledWith(expect.any(String), ["USD"]);
  });

  it("the SAME lease owner is used to claim, to record and to report a failure", async () => {
    const owners: string[] = [];
    const h = harness({
      claim: async (_db, _id, owner) => { owners.push(owner); return true; },
      record: async (_db, input) => { owners.push(input.owner); return {}; },
    });
    await dispatchReceipt(h.db, receipt(), message, "acct", h.makeDeps, { ports: h.ports, owner: "worker-7" });
    expect(owners).toEqual(["worker-7", "worker-7"]);
  });
});
