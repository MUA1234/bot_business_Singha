/**
 * R1 §3 / OF-001 — the scheduled inbound dispatch drain.
 *
 * Provider redelivery was the only thing re-driving a failed dispatch. That is not a retry
 * mechanism the system controls: it is bounded by how long the provider happens to keep trying, it
 * does nothing for a receipt whose backoff outlives the redelivery window, and it does not exist at
 * all for a channel without redelivery.
 *
 * These drive the real orchestration with injected ports, because the properties under test are
 * ordering, deadlines, concurrency and OUTCOME ACCOUNTING — none of which a source-text assertion
 * can establish. The live lease, crash-recovery and tenant-isolation behaviour is proven against a
 * disposable local PostgreSQL in tests/integration/dispatch-drain.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { drainInboundDispatch, type DrainDeps, type DrainOutcome, type DrainableReceipt } from "@/events/dispatch-drain";

const receipt = (id: string): DrainableReceipt => ({
  id, source: "whatsapp", provider_message_id: `wamid.${id}`, provider_account_id: "acct-1",
  // THE SHAPE THE ADAPTER ACTUALLY STORES: Meta's own message, where `text` is `{ body }`. The
  // earlier fixture used a flat `{from, text}` that nothing has written since R1 §6, which is why
  // this file kept passing while the real drain destroyed every message body it retried.
  raw_payload: {
    id: `wamid.${id}`, from: "94770001111", timestamp: "1755500000",
    type: "text", text: { body: "hello" },
  },
  correlation_id: `cor_${id}`, dispatch_attempts: 1,
});

function harness(over: Partial<DrainDeps> = {}, batch: DrainableReceipt[] = [receipt("a"), receipt("b")]) {
  let clock = 0;
  const released: string[] = [];
  const dispatched: string[] = [];
  const deps: DrainDeps = {
    claim: async () => batch,
    dispatch: async (r) => { dispatched.push(r.id); return "customer_order"; },
    release: async (id) => { released.push(id); },
    now: () => clock,
    ...over,
  };
  return { deps, released, dispatched, tick: (ms: number) => { clock += ms; }, setClock: (v: number) => { clock = v; } };
}

describe("scheduled inbound dispatch drain", () => {
  it("claims a bounded batch and reports what each receipt became", async () => {
    const h = harness();
    const r = await drainInboundDispatch(h.deps, { owner: "w1" });
    expect(r.claimed).toBe(2);
    expect(r.byOutcome).toEqual({ customer_order: 2 });
    expect(r.partial).toBe(false);
    expect(h.dispatched.sort()).toEqual(["a", "b"]);
  });

  it("the batch limit is BOUNDED — a caller cannot ask for an unbounded sweep", async () => {
    const seen: number[] = [];
    const h = harness({ claim: async (limit) => { seen.push(limit); return []; } });
    await drainInboundDispatch(h.deps, { owner: "w", limit: 100_000 });
    await drainInboundDispatch(h.deps, { owner: "w", limit: 0 });
    expect(seen).toEqual([200, 1]);
  });

  it("OUTSTANDING work is never reported as a clean sweep", async () => {
    for (const outcome of ["error", "retry_pending", "unattributed"] as DrainOutcome[]) {
      const h = harness({ dispatch: async () => outcome }, [receipt("a")]);
      const r = await drainInboundDispatch(h.deps, { owner: "w" });
      expect(r.partial, outcome).toBe(true);
      expect(r.byOutcome[outcome], outcome).toBe(1);
    }
  });

  it("a settled outcome IS a clean sweep", async () => {
    for (const outcome of ["customer_order", "manual_review", "already_dispatched"] as DrainOutcome[]) {
      const h = harness({ dispatch: async () => outcome }, [receipt("a")]);
      expect((await drainInboundDispatch(h.deps, { owner: "w" })).partial, outcome).toBe(false);
    }
  });

  it("DEADLINE: unstarted work is RELEASED uncharged, not failed", async () => {
    // The first receipt takes the whole budget; the rest must be handed back, not dead-lettered.
    const h = harness({}, [receipt("a"), receipt("b"), receipt("c")]);
    let first = true;
    h.deps.dispatch = async (r) => {
      if (first) { first = false; h.setClock(60_000); }
      h.dispatched.push(r.id);
      return "customer_order";
    };
    const r = await drainInboundDispatch(h.deps, { owner: "w", deadlineMs: 45_000, concurrency: 1 });
    expect(h.dispatched).toEqual(["a"]);
    expect(h.released.sort()).toEqual(["b", "c"]);
    expect(r.released).toBe(2);
    expect(r.byOutcome.released_deadline).toBe(2);
    expect(r.partial).toBe(true);   // the run did not finish its batch and says so
  });

  it("a release that fails is COUNTED, and the run still reports partial", async () => {
    // deadlineMs 0 means "already out of time" on the first item (the option uses ??, so 0 is
    // respected rather than falling back to the default).
    const h = harness({ release: async () => { throw new Error("db down"); } }, [receipt("a")]);
    const r = await drainInboundDispatch(h.deps, { owner: "w", deadlineMs: 0 });
    expect(r.released).toBe(0);
    expect(r.errors).toBe(1);
    expect(r.partial).toBe(true);
  });

  it("a receipt that THROWS outside the orchestration is counted, and the batch continues", async () => {
    const h = harness({}, [receipt("a"), receipt("b")]);
    h.deps.dispatch = async (r) => {
      if (r.id === "a") throw new Error("boom");
      return "customer_order";
    };
    const r = await drainInboundDispatch(h.deps, { owner: "w", concurrency: 1 });
    expect(r.errors).toBe(1);
    expect(r.byOutcome.customer_order).toBe(1); // the poison item did not stop the healthy one
    expect(r.partial).toBe(true);
  });

  it("a POISON receipt mixed with healthy work does not starve the batch", async () => {
    const batch = [receipt("poison"), ...["h1", "h2", "h3"].map(receipt)];
    const h = harness({}, batch);
    h.deps.dispatch = async (r) => {
      if (r.id === "poison") throw new Error("always fails");
      return "customer_order";
    };
    const r = await drainInboundDispatch(h.deps, { owner: "w", concurrency: 2 });
    expect(r.byOutcome.customer_order).toBe(3);
    expect(r.errors).toBe(1);
  });

  it("CONCURRENCY is bounded, and every receipt is handled EXACTLY once", async () => {
    const batch = Array.from({ length: 20 }, (_, i) => receipt(`r${i}`));
    let inFlight = 0, peak = 0;
    const handled: string[] = [];
    const h = harness({}, batch);
    h.deps.dispatch = async (r) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 1));
      handled.push(r.id);
      inFlight--;
      return "customer_order";
    };
    const r = await drainInboundDispatch(h.deps, { owner: "w", concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(handled.length).toBe(20);
    expect(new Set(handled).size).toBe(20);  // no receipt processed twice
    expect(r.byOutcome.customer_order).toBe(20);
  });

  it("concurrency is CAPPED even when a caller asks for more", async () => {
    const batch = Array.from({ length: 40 }, (_, i) => receipt(`r${i}`));
    let inFlight = 0, peak = 0;
    const h = harness({}, batch);
    h.deps.dispatch = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 1));
      inFlight--;
      return "customer_order";
    };
    await drainInboundDispatch(h.deps, { owner: "w", concurrency: 1000 });
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("a failed CLAIM strands nothing and is never reported as an empty success", async () => {
    const h = harness({ claim: async () => { throw new Error("claim exploded"); } });
    const r = await drainInboundDispatch(h.deps, { owner: "w" });
    expect(r.claimed).toBe(0);
    expect(r.partial).toBe(true);
    expect(h.dispatched).toEqual([]);
  });

  it("an EMPTY queue is a clean, complete run", async () => {
    const h = harness({}, []);
    const r = await drainInboundDispatch(h.deps, { owner: "w" });
    expect(r.claimed).toBe(0);
    expect(r.partial).toBe(false);
    expect(r.byOutcome).toEqual({});
  });

  it("the owner identity is carried to the claim, the dispatch and the release", async () => {
    const owners: string[] = [];
    const h = harness({}, [receipt("a")]);
    h.deps.claim = async (_l, o) => { owners.push(o); return [receipt("a")]; };
    h.deps.dispatch = async (_r, o) => { owners.push(o); return "customer_order"; };
    await drainInboundDispatch(h.deps, { owner: "worker-42" });
    expect(owners).toEqual(["worker-42", "worker-42"]);
  });

  it("MORE ROWS THAN ONE BATCH: a run drains its batch and leaves the rest for the next", async () => {
    // The claim is bounded, so a backlog larger than the limit is drained across runs — which is
    // what keeps a single invocation inside its deadline.
    const all = Array.from({ length: 60 }, (_, i) => receipt(`r${i}`));
    let offset = 0;
    const h = harness({ claim: async (limit) => all.slice(offset, offset += limit) });
    const first = await drainInboundDispatch(h.deps, { owner: "w", limit: 25 });
    const second = await drainInboundDispatch(h.deps, { owner: "w", limit: 25 });
    const third = await drainInboundDispatch(h.deps, { owner: "w", limit: 25 });
    expect([first.claimed, second.claimed, third.claimed]).toEqual([25, 25, 10]);
    expect(first.partial || second.partial || third.partial).toBe(false);
  });
});
