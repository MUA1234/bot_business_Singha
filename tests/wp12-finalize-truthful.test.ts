/**
 * WP12 external-review correction A + second-review — the REAL tryFinalizeAndSend() state machine
 * and outbox-state reconciliation, exercised with a fake Supabase client (no live DB).
 *
 * Proves:
 *   - terminal states (sent/accepted/rejected) perform ZERO writes and never resend;
 *   - a `queued` quotation is never re-priced/reset and is not re-enqueued or re-historied;
 *   - the existing outbox row is loaded company+source-scoped and reconciled by its REAL state —
 *     pending/failed → drain; processing → wait; dead → surfaced; sent → already-sent (distinct);
 *   - ready→queued recovery when a durable row exists but the status update was lost;
 *   - enqueue `unavailable`, and a missing company+source-scoped row, both fail closed (retryable),
 *     never claiming queued/sent;
 *   - a drain exception is reported, not swallowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { outboundIdempotencyKey } from "@/events/outbox";

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

const OB_KEY = outboundIdempotencyKey("whatsapp", "quotation:q1");
function seed(status: string, opts: { priced?: boolean; outbox?: string } = {}) {
  const priced = opts.priced ?? true;
  H.box.store = {
    quotations: { q1: { id: "q1", company_id: "co", quote_number: "SQ-1", currency: "LKR", total: 100, status, public_token: "tok", order_id: "o1" } },
    orders: { o1: { id: "o1", company_id: "co", customer_phone: "94711", customer_name: "C", conversation_id: "cv1" } },
    items: [{ quotation_id: "q1", company_id: "co", unit_price: priced ? 100 : null, line_total: priced ? 100 : null, status: priced ? "priced" : "needs_confirmation" }],
    message_outbox: {} as any,
  };
  if (opts.outbox) H.box.store.message_outbox[OB_KEY] = { id: OB_KEY, company_id: "co", idempotency_key: OB_KEY, source_type: "quotation", source_id: "q1", status: opts.outbox };
  H.box.writes = [];
}
const qStatus = () => H.box.store.quotations.q1.status;

import { tryFinalizeAndSend } from "@/lib/quotations";

describe("WP12 tryFinalizeAndSend — state machine + outbox reconciliation", () => {
  beforeEach(() => {
    H.enqueueMock.mockReset();
    H.drainMock.mockReset();
    H.drainMock.mockResolvedValue({ ok: true, considered: 0, sent: 0, failed: 0, dead: 0, errors: 0 });
    // Default enqueue: insert a fresh pending outbox row (as the real enqueue would) and return enqueued.
    H.enqueueMock.mockImplementation(async (e: any) => {
      const k = outboundIdempotencyKey("whatsapp", e.dedupeKey);
      H.box.store.message_outbox[k] = { id: k, company_id: e.companyId, idempotency_key: k, source_type: e.sourceType, source_id: e.sourceId, status: "pending" };
      return "enqueued";
    });
  });

  it.each(["sent", "accepted", "rejected"])("a %s quotation performs zero writes and never resends", async (st) => {
    seed(st);
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("terminal");
    expect(r.sent).toBe(st === "sent");
    expect(H.box.writes).toHaveLength(0);
    expect(H.enqueueMock).not.toHaveBeenCalled();
    expect(H.drainMock).not.toHaveBeenCalled();
  });

  it("a fresh ready quotation enqueues once, transitions ready→queued, writes no history here", async () => {
    seed("ready");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(H.enqueueMock).toHaveBeenCalledTimes(1);
    expect(qStatus()).toBe("queued");
    expect(r.sent).toBe(false);
    expect(r.status).toBe("queued");
    expect(H.box.writes.some((w) => w.op === "insert" && w.table === "wa_messages")).toBe(false);
  });

  it("a queued quotation is NOT re-priced or re-enqueued; a pending outbox row is drained to completion", async () => {
    seed("queued", { outbox: "pending" });
    H.drainMock.mockImplementation(async () => { H.box.store.quotations.q1.status = "sent"; return { ok: true, considered: 1, sent: 1, failed: 0, dead: 0, errors: 0 }; });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(H.enqueueMock).not.toHaveBeenCalled();
    expect(H.box.writes.some((w) => w.op === "update" && w.table === "quotation_items")).toBe(false); // not re-priced
    expect(H.drainMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(true);
    expect(r.status).toBe("sent");
  });

  it("outbox states reconcile distinctly: processing waits, dead is surfaced, sent is already-sent (no drain)", async () => {
    for (const [obState, reason] of [["processing", "processing"], ["dead", "dead"], ["sent", "already_sent"]] as const) {
      seed("queued", { outbox: obState });
      const r = await tryFinalizeAndSend("co", "q1");
      expect(H.drainMock, obState).not.toHaveBeenCalled(); // none of these three drain
      expect(r.reason, obState).toBe(reason);
      expect(r.sent, obState).toBe(false); // quotation still 'queued' in all three
      H.drainMock.mockClear();
    }
  });

  it("a failed(due) outbox row is drained (retried), not treated as terminal", async () => {
    seed("queued", { outbox: "failed" });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(H.drainMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("queued");
  });

  it("ready→queued recovery: a pre-existing outbox row (duplicate enqueue) recovers a stuck 'ready'", async () => {
    seed("ready", { outbox: "pending" });
    H.enqueueMock.mockResolvedValue("duplicate"); // row already existed; enqueue is a no-op
    const r = await tryFinalizeAndSend("co", "q1");
    expect(qStatus()).toBe("queued"); // recovered
    expect(r.status).toBe("queued");
  });

  it("enqueue `unavailable` keeps the quotation retryable (stays ready), never claims queued/sent", async () => {
    seed("ready");
    H.enqueueMock.mockResolvedValue("unavailable");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("enqueue_unavailable");
    expect(qStatus()).toBe("ready");
    expect(H.drainMock).not.toHaveBeenCalled();
  });

  it("a missing company+source-scoped outbox row (key clash) fails closed", async () => {
    seed("ready");
    H.enqueueMock.mockResolvedValue("enqueued"); // but insert NOTHING → the scoped row is absent
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("outbox_not_found");
    expect(qStatus()).toBe("ready"); // not advanced
  });

  it("provider failure (drain does not complete) never marks the quotation sent", async () => {
    seed("ready");
    H.drainMock.mockResolvedValue({ ok: false, considered: 1, sent: 0, failed: 1, dead: 0, errors: 0 });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.status).toBe("queued");
  });

  it("a drain exception is reported, not swallowed into a false success", async () => {
    seed("ready");
    H.drainMock.mockRejectedValue(new Error("boom"));
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("drain_failed");
    expect(r.status).toBe("queued");
  });

  it("refreshQuotationStatus never changes a queued or terminal status (hard guard)", async () => {
    const { refreshQuotationStatus } = await import("@/lib/quotations");
    for (const st of ["queued", "sent", "accepted", "rejected"]) {
      seed(st, { priced: false }); // an unpriced item would normally force awaiting_price
      await refreshQuotationStatus("co", "q1");
      expect(qStatus(), st).toBe(st); // status unchanged
    }
  });

  it("awaiting_price (an unpriced item) returns without queuing", async () => {
    seed("draft", { priced: false });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("awaiting_price");
    expect(H.enqueueMock).not.toHaveBeenCalled();
  });
});
