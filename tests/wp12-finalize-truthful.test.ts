/**
 * WP12 — the REAL tryFinalizeAndSend() orchestration, exercised with a fake Supabase client (no live
 * DB). The enqueue race itself is now closed ATOMICALLY inside the `enqueue_quotation_outbox` RPC
 * (migration 0063) and is proven with two real PostgreSQL connections in
 * tests/integration/wp12-atomic-enqueue.test.ts. Here we prove the wrapper's orchestration around that
 * RPC:
 *   - terminal states (sent/accepted/rejected) perform ZERO writes, never call the RPC, never resend;
 *   - the message body is built from the FRESH total (no JS Number) and passed to the RPC;
 *   - each atomic result is honoured — terminal/not_ready/stale/inconsistent NEVER drain or send;
 *     'enqueued'/'duplicate' reconcile the exact outbox row by its real state;
 *   - the sent-outbox / quotation inconsistency reconciles or fails closed (never already_sent+false);
 *   - a drain exception is reported, not swallowed;
 *   - refreshQuotationStatus's guarded update never mutates a queued/terminal quotation (status OR total).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { outboundIdempotencyKey } from "@/events/outbox";

const H = vi.hoisted(() => ({
  box: { store: undefined as any, writes: [] as any[] },
  enqueueQMock: vi.fn(), // mocks the enqueue_quotation_outbox RPC result
  drainMock: vi.fn(),
  reconcileMock: vi.fn(),
}));

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
  return {
    from: qb,
    rpc: async (name: string, args: any) => {
      if (name === "enqueue_quotation_outbox") {
        const res = await H.enqueueQMock(args);
        // Model the atomic side effects the real RPC performs for enqueued/duplicate, so the wrapper's
        // subsequent row load + reconcile can proceed. (terminal/not_ready/stale/inconsistent do nothing.)
        if (res === "enqueued" || res === "duplicate") {
          const k = args.p_idempotency_key;
          if (!store.message_outbox[k]) {
            store.message_outbox[k] = { id: k, company_id: args.p_company, idempotency_key: k, source_type: "quotation", source_id: args.p_quotation, status: "pending" };
          }
          const q = store.quotations.q1;
          if (q && q.status === "ready") q.status = "queued"; // ready→queued coupled with the insert
        }
        return { data: res, error: null };
      }
      if (name === "reconcile_quotation_from_outbox") return { data: await H.reconcileMock(args), error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
}

const OB_KEY = outboundIdempotencyKey("whatsapp", "quotation:q1");
function seed(status: string, opts: { priced?: boolean; outbox?: string; total?: number } = {}) {
  const priced = opts.priced ?? true;
  H.box.store = {
    quotations: { q1: { id: "q1", company_id: "co", quote_number: "SQ-1", currency: "LKR", total: opts.total ?? 100, status, public_token: "tok", order_id: "o1" } },
    orders: { o1: { id: "o1", company_id: "co", customer_phone: "94711", customer_name: "C", conversation_id: "cv1" } },
    items: [{ quotation_id: "q1", company_id: "co", unit_price: priced ? 100 : null, line_total: priced ? 100 : null, status: priced ? "priced" : "needs_confirmation", currency: "LKR" }],
    message_outbox: {} as any,
  };
  if (opts.outbox) H.box.store.message_outbox[OB_KEY] = { id: OB_KEY, company_id: "co", idempotency_key: OB_KEY, source_type: "quotation", source_id: "q1", status: opts.outbox };
  H.box.writes = [];
}
const qStatus = () => H.box.store.quotations.q1.status;
const outboxCount = () => Object.keys(H.box.store.message_outbox).length;

import { tryFinalizeAndSend } from "@/lib/quotations";

describe("WP12 tryFinalizeAndSend — orchestration around the atomic enqueue RPC", () => {
  beforeEach(() => {
    H.enqueueQMock.mockReset();
    H.drainMock.mockReset();
    H.reconcileMock.mockReset();
    H.reconcileMock.mockResolvedValue(false);
    H.drainMock.mockResolvedValue({ ok: true, considered: 0, sent: 0, failed: 0, dead: 0, errors: 0 });
    H.enqueueQMock.mockResolvedValue("enqueued"); // default happy path
  });

  it.each(["sent", "accepted", "rejected"])("a %s quotation performs zero writes, never calls the RPC, never resends", async (st) => {
    seed(st);
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("terminal");
    expect(r.sent).toBe(st === "sent");
    expect(H.box.writes).toHaveLength(0);
    expect(H.enqueueQMock).not.toHaveBeenCalled();
    expect(H.drainMock).not.toHaveBeenCalled();
  });

  it("a fresh ready quotation: the RPC enqueues (ready→queued), a pending row is drained to sent", async () => {
    seed("ready");
    H.drainMock.mockImplementation(async () => { H.box.store.quotations.q1.status = "sent"; return { ok: true, considered: 1, sent: 1, failed: 0, dead: 0, errors: 0 }; });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(H.enqueueQMock).toHaveBeenCalledTimes(1);
    expect(qStatus()).toBe("sent");
    expect(r.sent).toBe(true);
    // no outbound wa_messages history is written here (only the fenced completion RPC writes it)
    expect(H.box.writes.some((w) => w.op === "insert" && w.table === "wa_messages")).toBe(false);
  });

  it("the message body is built from the FRESH total (no JS Number) and passed to the RPC", async () => {
    seed("draft", { total: 0 }); // stale/zero total; the priced item recomputes it to 100 in the refresh
    await tryFinalizeAndSend("co", "q1");
    expect(H.enqueueQMock).toHaveBeenCalledTimes(1);
    const args = H.enqueueQMock.mock.calls[0]![0];
    expect(args.p_body).toContain("LKR 100.00"); // the newly-calculated total, formatted without Number
    expect(args.p_body).not.toMatch(/LKR 0(\.00)?\b/);
    // the same authoritative total (numeric string, as the DB returns it) the RPC validates under lock:
    expect(String(args.p_expected_total)).toBe("100.00");
  });

  // ── each atomic result is honoured; terminal/not_ready/stale/inconsistent NEVER drain or send ──

  it("RPC 'terminal' (a race won by a terminal transition) → zero drain, zero new outbox row", async () => {
    seed("ready");
    // Model the race: the RPC observed a terminal transition under its lock and created nothing.
    H.enqueueQMock.mockImplementation(async () => { H.box.store.quotations.q1.status = "sent"; return "terminal"; });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("terminal");
    expect(r.sent).toBe(true);
    expect(H.drainMock).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it("RPC 'not_ready' → zero drain, no send, retryable", async () => {
    seed("ready");
    H.enqueueQMock.mockResolvedValue("not_ready");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("not_ready");
    expect(r.sent).toBe(false);
    expect(H.drainMock).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it("RPC 'stale' (total moved under the lock) → NOT queued, zero drain, retryable", async () => {
    seed("ready");
    H.enqueueQMock.mockResolvedValue("stale");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("stale");
    expect(r.sent).toBe(false);
    expect(H.drainMock).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it("RPC 'inconsistent' (cross-company/source key) → fail closed, zero drain, operator log", async () => {
    seed("ready");
    H.enqueueQMock.mockResolvedValue("inconsistent");
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("outbox_source_inconsistent");
    expect(r.sent).toBe(false);
    expect(H.drainMock).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it("RPC 'duplicate' on an already-queued quotation → reconcile the EXISTING row, no new enqueue", async () => {
    seed("queued", { outbox: "pending" });
    H.enqueueQMock.mockResolvedValue("duplicate");
    H.drainMock.mockImplementation(async () => { H.box.store.quotations.q1.status = "sent"; return { ok: true, considered: 1, sent: 1, failed: 0, dead: 0, errors: 0 }; });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(outboxCount()).toBe(1);        // still exactly one row
    expect(H.drainMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(true);
  });

  // ── reconcile by the outbox row's real state ──

  it("a pending row is drained; a failed(due) row is drained; processing waits; dead is surfaced", async () => {
    for (const [obState, drains, reason] of [["pending", true, undefined], ["failed", true, undefined], ["processing", false, "processing"], ["dead", false, "dead"]] as const) {
      seed("queued", { outbox: obState });
      H.enqueueQMock.mockResolvedValue("duplicate");
      const r = await tryFinalizeAndSend("co", "q1");
      expect(H.drainMock.mock.calls.length > 0, obState).toBe(drains);
      if (reason) expect(r.reason, obState).toBe(reason);
      H.drainMock.mockClear();
    }
  });

  it("sent outbox + already-sent quotation → already_sent (sent:true); never with sent=false", async () => {
    seed("queued", { outbox: "sent" });
    H.enqueueQMock.mockResolvedValue("duplicate");
    H.box.store.quotations.q1.status = "sent"; // consistent
    const r = await tryFinalizeAndSend("co", "q1");
    // terminal fast-path: quotation already sent → sent:true, reason terminal (no reconcile needed)
    expect(r.sent).toBe(true);
    expect(H.drainMock).not.toHaveBeenCalled();
  });

  it("sent outbox + not-yet-sent quotation reconciles to sent (sent:true), else fails closed — never already_sent+false", async () => {
    // inconsistent → reconciled
    seed("queued", { outbox: "sent" });
    H.enqueueQMock.mockResolvedValue("duplicate");
    H.reconcileMock.mockImplementation(async () => { H.box.store.quotations.q1.status = "sent"; return true; });
    let r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(true);
    expect(r.reason).toBe("reconciled");

    // inconsistent → cannot reconcile → fail closed
    seed("queued", { outbox: "sent" });
    H.enqueueQMock.mockResolvedValue("duplicate");
    H.reconcileMock.mockResolvedValue(false);
    r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("outbox_source_inconsistent");
    expect(r.reason).not.toBe("already_sent");
  });

  it("a drain exception is reported, not swallowed into a false success", async () => {
    seed("ready");
    H.drainMock.mockRejectedValue(new Error("boom"));
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("drain_failed");
  });

  it("an RPC error / null result keeps the quotation retryable (enqueue_unavailable), never queued/sent", async () => {
    seed("ready");
    H.enqueueQMock.mockResolvedValue(null); // null data → wrapper treats it as unavailable (retryable)
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("enqueue_unavailable");
    expect(r.sent).toBe(false);
    expect(H.drainMock).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it("awaiting_price (an unpriced item) returns without calling the RPC", async () => {
    seed("draft", { priced: false });
    const r = await tryFinalizeAndSend("co", "q1");
    expect(r.reason).toBe("awaiting_price");
    expect(H.enqueueQMock).not.toHaveBeenCalled();
  });

  // ── refreshQuotationStatus guard (unchanged behaviour): never mutates a queued/terminal quotation ──

  it("refreshQuotationStatus never changes a queued or terminal status (hard guard)", async () => {
    const { refreshQuotationStatus } = await import("@/lib/quotations");
    for (const st of ["queued", "sent", "accepted", "rejected"]) {
      seed(st, { priced: false });
      await refreshQuotationStatus("co", "q1");
      expect(qStatus(), st).toBe(st);
    }
  });

  it("refreshQuotationStatus leaves a queued/terminal quotation's TOTALS untouched, not just its status", async () => {
    const { refreshQuotationStatus } = await import("@/lib/quotations");
    for (const st of ["queued", "sent", "accepted", "rejected"]) {
      seed(st);
      H.box.store.quotations.q1.total = 999;
      await refreshQuotationStatus("co", "q1");
      expect(qStatus(), st).toBe(st);
      expect(H.box.store.quotations.q1.total, st).toBe(999);
      const touched = H.box.writes.filter((w) => w.op === "update" && w.table === "quotations" && w.rows > 0);
      expect(touched, st).toHaveLength(0);
    }
  });
});
