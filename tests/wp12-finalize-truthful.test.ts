/**
 * WP12 external-review correction A — the REAL tryFinalizeAndSend() state machine, exercised with a
 * fake Supabase client (no live DB). Proves the review regressions are fixed:
 *   - terminal states (sent/accepted/rejected) perform ZERO writes and never resend;
 *   - a `queued` quotation is never re-priced/reset and is not re-enqueued or re-historied;
 *   - enqueue `unavailable` leaves the quotation retryable (nonterminal), never claims queued/sent;
 *   - a fresh `ready` enqueue transitions ready→queued exactly once;
 *   - provider failure (drain does not complete) never marks the quotation sent;
 *   - a drain exception is reported, not swallowed into a false success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ box: { store: undefined as any, writes: [] as any[] }, enqueueMock: vi.fn(), drainMock: vi.fn() }));

vi.mock("@/lib/outbox-enqueue", () => ({ enqueueOutbox: H.enqueueMock }));
vi.mock("@/events/outbox-drain", () => ({ drainOutbox: H.drainMock }));
vi.mock("@/config/env", () => ({ env: { appBaseUrl: "https://x.example" } }));
vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => makeDb(H.box) }));

function makeDb(box: any) {
  const store = box.store;
  function qb(table: string) {
    let mode: "select" | "update" = "select";
    let payload: any = null;
    const filters: Array<[string, any]> = [];
    const inl: Array<[string, any[]]> = [];
    function rows() {
      let rs: any[] = table === "quotation_items" ? store.items.slice() : Object.values(store[table] ?? {});
      for (const [c, v] of filters) rs = rs.filter((r) => r[c] === v);
      for (const [c, vs] of inl) rs = rs.filter((r) => vs.includes(r[c]));
      return rs;
    }
    function run() {
      if (mode === "update") {
        const rs = rows();
        box.writes.push({ op: "update", table, payload, rows: rs.length });
        for (const r of rs) Object.assign(r, payload);
        return { data: rs, error: null };
      }
      return { data: rows(), error: null };
    }
    const api: any = {
      select() { return api; },
      update(obj: any) { mode = "update"; payload = obj; return api; },
      insert(obj: any) { box.writes.push({ op: "insert", table, payload: obj }); return Promise.resolve({ error: null }); },
      eq(c: string, v: any) { filters.push([c, v]); return api; },
      in(c: string, v: any[]) { inl.push([c, v]); return api; },
      maybeSingle() { const rs = rows(); return Promise.resolve({ data: rs[0] ?? null, error: null }); },
      single() { const rs = rows(); return Promise.resolve({ data: rs[0] ?? null, error: rs[0] ? null : { message: "no rows" } }); },
      then(resolve: any, reject: any) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return api;
  }
  return { from: qb };
}

function seed(status: string, opts: { priced?: boolean } = {}) {
  const priced = opts.priced ?? true;
  H.box.store = {
    quotations: { q1: { id: "q1", company_id: "co", quote_number: "SQ-1", currency: "LKR", total: 100, status, public_token: "tok", order_id: "o1" } },
    orders: { o1: { id: "o1", company_id: "co", customer_phone: "94711", customer_name: "C", conversation_id: "cv1" } },
    items: [{ quotation_id: "q1", company_id: "co", unit_price: priced ? 100 : null, line_total: priced ? 100 : null, status: priced ? "priced" : "needs_confirmation" }],
  };
  H.box.writes = [];
}
const qStatus = () => H.box.store.quotations.q1.status;

import { tryFinalizeAndSend } from "@/lib/quotations";

describe("WP12 tryFinalizeAndSend truthful state machine (correction A)", () => {
  beforeEach(() => { H.enqueueMock.mockReset(); H.drainMock.mockReset(); H.drainMock.mockResolvedValue({ ok: true, considered: 0, sent: 0, failed: 0, dead: 0, errors: 0 }); });

  it.each(["sent", "accepted", "rejected"])("a %s quotation performs zero writes and never resends", async (st) => {
    seed(st);
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("terminal");
    expect(r.sent).toBe(st === "sent");
    expect(H.box.writes).toHaveLength(0);        // no refresh, no queue, no history
    expect(H.enqueueMock).not.toHaveBeenCalled();
    expect(H.drainMock).not.toHaveBeenCalled();
  });

  it("a fresh ready quotation enqueues once and transitions ready→queued (no history written here)", async () => {
    seed("ready");
    H.enqueueMock.mockResolvedValue("enqueued");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(H.enqueueMock).toHaveBeenCalledTimes(1);
    expect(qStatus()).toBe("queued");
    expect(r.sent).toBe(false); // drain did not complete it
    expect(r.status).toBe("queued");
    // No outbound wa_messages history is inserted at finalize time.
    expect(H.box.writes.some((w) => w.op === "insert" && w.table === "wa_messages")).toBe(false);
  });

  it("a queued quotation is NOT re-priced or re-enqueued; it reconciles via drain", async () => {
    seed("queued");
    // Simulate the inline drain durably completing the send (as the fenced RPC would).
    H.drainMock.mockImplementation(async () => { H.box.store.quotations.q1.status = "sent"; return { ok: true, considered: 1, sent: 1, failed: 0, dead: 0, errors: 0 }; });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(H.enqueueMock).not.toHaveBeenCalled();               // no re-enqueue
    expect(H.box.writes.some((w) => w.op === "update" && w.table === "quotation_items")).toBe(false); // not re-priced
    expect(H.drainMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(true);
    expect(r.status).toBe("sent");
  });

  it("enqueue `unavailable` keeps the quotation retryable (stays ready), never claims queued/sent", async () => {
    seed("ready");
    H.enqueueMock.mockResolvedValue("unavailable");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("enqueue_unavailable");
    expect(qStatus()).toBe("ready");            // NOT queued
    expect(H.drainMock).not.toHaveBeenCalled();
  });

  it("provider failure (drain does not complete) never marks the quotation sent", async () => {
    seed("ready");
    H.enqueueMock.mockResolvedValue("enqueued");
    H.drainMock.mockResolvedValue({ ok: false, considered: 1, sent: 0, failed: 1, dead: 0, errors: 0 });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.status).toBe("queued");            // truthful: queued, not sent
  });

  it("a drain exception is reported, not swallowed into a false success", async () => {
    seed("ready");
    H.enqueueMock.mockResolvedValue("enqueued");
    H.drainMock.mockRejectedValue(new Error("boom"));
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("drain_failed");
    expect(r.status).toBe("queued");
  });

  it("awaiting_price (an unpriced item) returns without queuing", async () => {
    seed("draft", { priced: false });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("awaiting_price");
    expect(H.enqueueMock).not.toHaveBeenCalled();
  });
});
