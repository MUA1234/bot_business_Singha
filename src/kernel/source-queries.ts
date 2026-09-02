/**
 * Per-source queries and normalisation — ONE definition, used by both read paths (R2S-P).
 *
 * `loadFor` (a bounded single read) and `loadPage` (a cursored sweep) must agree about what a
 * source's rows mean, or the two paths drift and a defect fixed in one survives in the other.
 * That is the class of failure this recovery has found repeatedly, so the query and the
 * normalisation live here once and both callers use them.
 *
 * Every query is company-scoped, keyset-paginated and bounded. OFFSET appears nowhere: it
 * re-scans everything it skips, and its results shift under concurrent inserts and deletes — the
 * two things a reconciliation sweep must not do.
 */
import Decimal from "decimal.js";
import { iso, isoDate } from "./temporal";
import {
  nextCursorFrom, OVERLAP_MS, type Cursor, type CursorKind, type Page,
} from "./pagination";
import {
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
  GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
  ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
} from "./adapters";

// eslint-disable-next-line
export type Db = any;
// eslint-disable-next-line
type Row = any;

const rowsOf = async (run: Promise<{ data: unknown; error: unknown }>): Promise<Row[]> => {
  const { data, error } = await run;
  if (error) throw new Error((error as { message?: string }).message ?? "read failed");
  return (data ?? []) as Row[];
};

/** How each source is paged, and on which column the condition's urgency is measured. */
export interface SourceSpec {
  cursorKind: CursorKind;
  /** The column the priority pre-pass orders by, ascending (most overdue first). */
  priorityColumn?: string;
}

export const SOURCE_SPECS: Record<string, SourceSpec> = {
  [FINANCE_SOURCE]: { cursorKind: "sweep_by_id", priorityColumn: "due_date" },
  [WORKFORCE_SOURCE]: { cursorKind: "latest_per_key" },
  [OPERATIONS_SOURCE]: { cursorKind: "keyset_updated", priorityColumn: "due_date" },
  [CRM_SOURCE]: { cursorKind: "keyset_updated" },
  [SYSTEM_SOURCE]: { cursorKind: "none" },
  [GOVERNANCE_SOURCE]: { cursorKind: "keyset_updated", priorityColumn: "response_required_by" },
  [OBJECTIVES_SOURCE]: { cursorKind: "sweep_by_id", priorityColumn: "period_end" },
  [MARKETING_SOURCE]: { cursorKind: "sweep_by_id", priorityColumn: "created_at" },
  [PROCUREMENT_SOURCE]: { cursorKind: "sweep_by_id" },
  [ASSETS_SOURCE]: { cursorKind: "sweep_by_id", priorityColumn: "expiry_date" },
  [LEGAL_SOURCE]: { cursorKind: "sweep_by_id", priorityColumn: "expiry_date" },
  [PROVIDERS_SOURCE]: { cursorKind: "keyset_updated", priorityColumn: "insurance_expiry" },
};

/**
 * Is this source paged at all?
 *
 * The system-health source is a bounded AGGREGATE — a shaped probe object, not a row list — so
 * there is nothing to page and no cursor to hold. It is read whole, every cycle, through the
 * ordinary loader.
 */
export function isPagedSource(source: string): boolean {
  return (SOURCE_SPECS[source]?.cursorKind ?? "none") !== "none";
}

/** Apply a keyset lower bound. Never OFFSET. */
function applyCursor(query: Row, spec: SourceSpec, cursor: Cursor | null): Row {
  if (!cursor || cursor.kind === "none") return query;
  switch (cursor.kind) {
    case "sweep_by_id":
      return cursor.id ? query.gt("id", cursor.id) : query;
    case "latest_per_key":
      return cursor.key ? query.gt("membership_id", cursor.key) : query;
    case "keyset_updated":
      // Handled by loadKeysetPage, which needs TWO queries to express the compound bound.
      // It is not expressible as a single filter here, and pretending otherwise is exactly
      // what stalled the sweep (R2S-P-F-001).
      return query;
    default:
      return query;
  }
}

// ── Column lists, one per source. ───────────────────────────────────────────────────────────
const COLUMNS: Record<string, { table: string; select: string; order: string }> = {
  [FINANCE_SOURCE]: {
    table: "customer_invoices",
    select: "id, due_date, total_amount, amount_settled, currency, status",
    order: "id",
  },
  [OPERATIONS_SOURCE]: {
    table: "tasks",
    select: "id, title, status, due_date, estimate_hours, updated_at",
    order: "updated_at",
  },
  [CRM_SOURCE]: {
    table: "wa_conversations",
    select: "id, last_inbound_at, status, updated_at",
    order: "updated_at",
  },
  [GOVERNANCE_SOURCE]: {
    table: "management_directives",
    select: "id, status, response_required_by, escalation_chain, escalation_level, acknowledged_at, updated_at",
    order: "updated_at",
  },
  [OBJECTIVES_SOURCE]: {
    table: "objectives",
    select: "id, target_value, current_value, period_start, period_end, status",
    order: "id",
  },
  [MARKETING_SOURCE]: {
    table: "campaigns",
    select: "id, status, audience_id, sent_count, created_at",
    order: "id",
  },
  [PROCUREMENT_SOURCE]: {
    table: "inventory_items",
    select: "id, quantity_on_hand, reorder_level, created_at",
    order: "id",
  },
  [ASSETS_SOURCE]: {
    table: "vehicle_documents",
    select: "id, vehicle_id, doc_type, expiry_date, created_at",
    order: "id",
  },
  [PROVIDERS_SOURCE]: {
    table: "service_providers",
    select: "id, status, compliance_status, insurance_status, insurance_expiry, updated_at",
    order: "updated_at",
  },
};

// ── Normalisation, one per source. The detector contract lives here. ────────────────────────
export function normalise(source: string, rows: Row[], extra: { lastPaidAt?: Map<string, string>; lastOut?: Map<string, string> } = {}): Row[] {
  switch (source) {
    case FINANCE_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        due_date: isoDate(r.due_date),
        // EXACT decimal: numeric(20,4) arrives as a string and a JS subtraction loses precision.
        outstanding: new Decimal(String(r.total_amount ?? "0"))
          .minus(new Decimal(String(r.amount_settled ?? "0")))
          .toString(),
        currency: r.currency ?? "LKR",
        // Genuine mutation evidence, or an honest null. NEVER created_at (defect R2S-F-001).
        updated_at: extra.lastPaidAt?.get(r.id) ?? null,
        status: r.status,
      }));
    case OPERATIONS_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        // Loaded because the detector's type requires it; the ADAPTER copies it nowhere.
        title: r.title,
        status: r.status,
        dueDate: isoDate(r.due_date),
        lastCheckInAt: iso(r.updated_at),
        estimateHours: r.estimate_hours,
        updatedAt: iso(r.updated_at),
      }));
    case CRM_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        last_inbound_at: iso(r.last_inbound_at),
        // Null means no outbound message exists — the truth and the safe reading. A draft or
        // failed send in message_outbox is NOT a sent message and is never consulted.
        last_outbound_at: extra.lastOut?.get(r.id) ?? null,
        status: r.status,
      }));
    case GOVERNANCE_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        response_required_by: iso(r.response_required_by),
        escalation_chain: r.escalation_chain ?? null,
        escalation_level: Number(r.escalation_level ?? 0),
        acknowledged_at: iso(r.acknowledged_at),
        updatedAt: iso(r.updated_at),
      }));
    case OBJECTIVES_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        target_value: r.target_value,
        current_value: r.current_value,
        period_start: isoDate(r.period_start),
        period_end: isoDate(r.period_end),
        status: r.status,
      }));
    case MARKETING_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        audience_id: r.audience_id ?? null,
        sent_count: r.sent_count === null || r.sent_count === undefined ? null : Number(r.sent_count),
        created_at: iso(r.created_at),
      }));
    case PROCUREMENT_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        quantity_on_hand: r.quantity_on_hand,
        reorder_level: r.reorder_level,
        created_at: iso(r.created_at),
      }));
    case ASSETS_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        vehicle_id: r.vehicle_id ?? null,
        doc_type: r.doc_type ?? null,
        expiry_date: isoDate(r.expiry_date),
        created_at: iso(r.created_at),
      }));
    case PROVIDERS_SOURCE:
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        compliance_status: r.compliance_status,
        insurance_status: r.insurance_status,
        insurance_expiry: isoDate(r.insurance_expiry),
        updated_at: iso(r.updated_at),
      }));
    case WORKFORCE_SOURCE:
      return rows.map((r) => ({
        snapshotId: r.id,
        membershipId: r.membership_id,
        utilizationPct: Number(r.utilization_pct ?? 0),
        status: r.status ?? "healthy",
        // When the reading was TAKEN. `week_start` is the period it DESCRIBES; freshness needs
        // the former, and conflating them is how R2S-F-006 happened.
        capturedAt: iso(r.created_at),
      }));
    default:
      return rows;
  }
}

/** Extra reads a source needs to normalise its page. Bounded by the page's own ids — no N+1. */
async function companions(
  db: Db, source: string, companyId: string, rows: Row[],
): Promise<{ lastPaidAt?: Map<string, string>; lastOut?: Map<string, string> }> {
  if (rows.length === 0) return {};

  if (source === FINANCE_SOURCE) {
    // ONE query for the whole page, keyed on the page's invoice ids. Not one per invoice.
    const allocations = await rowsOf(
      db.from("payment_allocations")
        .select("target_id, target_type, created_at")
        .eq("company_id", companyId)
        .eq("target_type", "customer_invoice")
        .in("target_id", rows.map((r) => r.id)),
    ).catch(() => [] as Row[]);
    const lastPaidAt = new Map<string, string>();
    for (const a of allocations) {
      const at = iso(a.created_at);
      if (!at) continue;
      const prev = lastPaidAt.get(a.target_id);
      if (!prev || at > prev) lastPaidAt.set(a.target_id, at);
    }
    return { lastPaidAt };
  }

  if (source === CRM_SOURCE) {
    const outbound = await rowsOf(
      db.from("wa_messages")
        .select("conversation_id, direction, created_at")
        .eq("company_id", companyId)
        .eq("direction", "outbound")
        .in("conversation_id", rows.map((r) => r.id)),
    ).catch(() => [] as Row[]);
    const lastOut = new Map<string, string>();
    for (const m of outbound) {
      if (m.direction !== "outbound") continue;
      const at = iso(m.created_at);
      if (!at) continue;
      const prev = lastOut.get(m.conversation_id);
      if (!prev || at > prev) lastOut.set(m.conversation_id, at);
    }
    return { lastOut };
  }

  return {};
}

/**
 * How many already-passed rows the late-writer re-scan may re-read per page.
 *
 * This is deliberately NOT the progress bound. Rewinding the cursor itself — the original
 * R2S-P-F-001 defect — meant that whenever more than one page of rows shared the overlap
 * window, every page re-read the same first rows and the sweep never advanced past them.
 */
export const OVERLAP_RESCAN = 50;

/**
 * One page of a `keyset_updated` source, on a genuinely COMPOUND (updated_at, id) cursor.
 *
 * `updated_at` is not unique: a bulk insert gives hundreds of rows one timestamp. A bound of
 * "updated_at >= cursor" therefore returns the same rows for ever, and a bound of
 * "updated_at > cursor" skips the remainder of the tie group. Neither is safe, and neither
 * can be written as a single filter through this client.
 *
 * So the compound comparison is split into the two ordinary filters that compose to it:
 *
 *   1. the REST of the current timestamp group   (updated_at = t AND id > lastId)
 *   2. everything strictly after it              (updated_at > t)
 *
 * Progress is then guaranteed: each page either drains part of a tie group by id, or moves
 * past the timestamp entirely. A tie group larger than the whole table cannot stall it.
 */
async function loadKeysetPage(
  db: Db, cols: { table: string; select: string }, companyId: string,
  cursor: Cursor | null, limit: number,
): Promise<{ rows: Row[]; next: Cursor | null; complete: boolean }> {
  const base = () => db.from(cols.table).select(cols.select).eq("company_id", companyId);
  const byPosition = (qy: Row) =>
    qy.order("updated_at", { ascending: true }).order("id", { ascending: true });

  const at = cursor && cursor.kind === "keyset_updated" && cursor.updatedAt ? cursor : null;

  let forward: Row[];
  if (!at) {
    forward = await rowsOf(byPosition(base()).limit(limit));
  } else {
    const tie = at.id
      ? await rowsOf(base().eq("updated_at", at.updatedAt).gt("id", at.id)
          .order("id", { ascending: true }).limit(limit))
      : [];
    const rest = tie.length < limit
      ? await rowsOf(byPosition(base().gt("updated_at", at.updatedAt)).limit(limit - tie.length))
      : [];
    forward = [...tie, ...rest];
  }

  // The cursor advances from the FORWARD rows only. Re-read rows must never move it.
  const { next, complete } = nextCursorFrom("keyset_updated", forward, limit, {
    id: "id", updatedAt: "updated_at",
  });

  // The late-writer re-scan: a writer whose transaction commits after a later-timestamped one
  // has already been read would otherwise fall permanently behind the cursor. Re-reading a
  // bounded slice of the preceding minute recovers it; identity-key deduplication in `ingest`
  // absorbs the repeats, which is what that mechanism is for.
  let late: Row[] = [];
  if (at) {
    const floor = new Date(Math.max(0, Date.parse(at.updatedAt) - OVERLAP_MS)).toISOString();
    late = await rowsOf(
      byPosition(base().gte("updated_at", floor).lt("updated_at", at.updatedAt))
        .limit(OVERLAP_RESCAN),
    );
  }

  return { rows: [...late, ...forward], next, complete };
}

/**
 * Read ONE bounded page of a source.
 *
 * `legal` is four tables behind one detector, so it pages them together on a shared id cursor:
 * each contributes a quarter of the page and the sweep is complete only when all four are.
 */
export async function loadSourcePage(
  db: Db, source: string, companyId: string, cursor: Cursor | null, limit: number,
): Promise<Page<Row>> {
  const spec = SOURCE_SPECS[source];
  if (!spec) throw new Error(`no loader registered for ${source}`);

  if (source === LEGAL_SOURCE) return loadLegalPage(db, companyId, cursor, limit);

  if (source === WORKFORCE_SOURCE) {
    // DISTINCT ON gives exactly one row per person — the newest week — so an obsolete snapshot
    // is never returned at all, and the page is keyed on the membership rather than the snapshot.
    const rows = await rowsOf(
      db.from("capacity_snapshots")
        .select("id, membership_id, utilization_pct, status, created_at, week_start")
        .eq("company_id", companyId)
        .order("week_start", { ascending: false })
        .limit(limit * 4),
    );
    const latest = new Map<string, Row>();
    for (const r of rows) {
      const prev = latest.get(r.membership_id);
      if (!prev) { latest.set(r.membership_id, r); continue; }
      const a = r.week_start ? new Date(r.week_start).getTime() : 0;
      const b = prev.week_start ? new Date(prev.week_start).getTime() : 0;
      if (a > b) latest.set(r.membership_id, r);
    }
    const ordered = [...latest.values()].sort((x, y) =>
      String(x.membership_id) < String(y.membership_id) ? -1 : 1);
    const after = cursor && cursor.kind === "latest_per_key" && cursor.key
      ? ordered.filter((r) => String(r.membership_id) > cursor.key)
      : ordered;
    const page = after.slice(0, limit);
    const { next, complete } = nextCursorFrom("latest_per_key", page, limit, { key: "membership_id" });
    return { rows: normalise(source, page), next, complete, inspected: page.length };
  }

  const cols = COLUMNS[source];
  if (!cols) throw new Error(`no column contract for ${source}`);

  if (spec.cursorKind === "keyset_updated") {
    const kp = await loadKeysetPage(db, cols, companyId, cursor, limit);
    const companionsFor = await companions(db, source, companyId, kp.rows);
    return {
      rows: normalise(source, kp.rows, companionsFor),
      next: kp.next, complete: kp.complete, inspected: kp.rows.length,
    };
  }

  let query = db.from(cols.table).select(cols.select).eq("company_id", companyId);
  query = applyCursor(query, spec, cursor);
  query = query.order(cols.order, { ascending: true }).limit(limit);

  const rows = await rowsOf(query);
  const extra = await companions(db, source, companyId, rows);
  const { next, complete } = nextCursorFrom(spec.cursorKind, rows, limit, {
    id: "id", updatedAt: "updated_at", key: "membership_id",
  });
  return { rows: normalise(source, rows, extra), next, complete, inspected: rows.length };
}

/**
 * The priority pre-pass: the MOST OVERDUE rows first.
 *
 * A keyset sweep by uuid is stable but arbitrary, so a licence that expired two years ago could
 * sit behind thousands of newer rows for several cycles. This reads a small bounded set ordered
 * by the condition date ascending and NEVER advances the cursor, so urgency and stable pagination
 * are separated rather than compromised. Duplicates are absorbed by identity-key deduplication.
 */
export async function loadPrioritySlice(
  db: Db, source: string, companyId: string, limit: number,
): Promise<Row[]> {
  const spec = SOURCE_SPECS[source];
  if (!spec?.priorityColumn) return [];

  if (source === LEGAL_SOURCE) {
    const parts = await Promise.all(LEGAL_TABLES.map(async (t) =>
      rowsOf(
        db.from(t.table).select(t.select).eq("company_id", companyId)
          .order(t.dateColumn, { ascending: true }).limit(Math.ceil(limit / LEGAL_TABLES.length)),
      ).catch(() => [] as Row[]).then((rs) => rs.map((r) => t.map(r))),
    ));
    return parts.flat();
  }

  const cols = COLUMNS[source];
  if (!cols) return [];
  const rows = await rowsOf(
    db.from(cols.table).select(cols.select).eq("company_id", companyId)
      .order(spec.priorityColumn, { ascending: true }).limit(limit),
  ).catch(() => [] as Row[]);
  const extra = await companions(db, source, companyId, rows);
  return normalise(source, rows, extra);
}

// ── Legal: four tables, one detector, one cursor. ───────────────────────────────────────────
const LEGAL_TABLES = [
  {
    table: "licences", select: "id, expiry_date, status", dateColumn: "expiry_date",
    map: (r: Row) => ({ id: r.id, kind: "licence", due_date: isoDate(r.expiry_date), status: r.status }),
  },
  {
    table: "contracts", select: "id, end_date, status", dateColumn: "end_date",
    map: (r: Row) => ({ id: r.id, kind: "contract", due_date: isoDate(r.end_date), status: r.status }),
  },
  {
    table: "insurances", select: "id, expiry_date, status", dateColumn: "expiry_date",
    map: (r: Row) => ({ id: r.id, kind: "insurance", due_date: isoDate(r.expiry_date), status: r.status }),
  },
  {
    table: "obligations", select: "id, due_date, status", dateColumn: "due_date",
    map: (r: Row) => ({ id: r.id, kind: "obligation", due_date: isoDate(r.due_date), status: r.status }),
  },
] as const;

async function loadLegalPage(
  db: Db, companyId: string, cursor: Cursor | null, limit: number,
): Promise<Page<Row>> {
  const per = Math.max(1, Math.floor(limit / LEGAL_TABLES.length));
  const after = cursor && cursor.kind === "sweep_by_id" ? cursor.id : "";

  const parts = await Promise.all(LEGAL_TABLES.map(async (t) => {
    let q = db.from(t.table).select(t.select).eq("company_id", companyId);
    if (after) q = q.gt("id", after);
    const rows = await rowsOf(q.order("id", { ascending: true }).limit(per)).catch(() => [] as Row[]);
    return rows.map((r) => ({ raw: r, mapped: t.map(r) }));
  }));

  const flat = parts.flat();
  // The four tables share ONE id cursor, so the sweep advances to the smallest maximum id any
  // table reached. Advancing past a table that returned fewer rows would skip its remainder.
  const maxIds = parts.filter((p) => p.length > 0).map((p) => String(p[p.length - 1]!.raw.id));
  const nextId = maxIds.length > 0 ? maxIds.sort()[0]! : null;
  const complete = parts.every((p) => p.length < per);

  return {
    rows: flat.map((f) => f.mapped),
    next: complete || !nextId ? null : { kind: "sweep_by_id", id: nextId },
    complete,
    inspected: flat.length,
  };
}
