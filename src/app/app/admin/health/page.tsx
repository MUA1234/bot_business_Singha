/**
 * System Health (Architecture V2 change plan §13 / OBSERVABILITY). Admin-only view
 * of operational counters — failed/unprocessed events, dead letters, outbox failures,
 * AI runs & cost. Uses the pure health summariser. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { classifyHealth } from "@/management/ai-manager/health";
import { decSum } from "@/lib/money";
import { probeCount, metricLabel, metricState, metricNumber, value, unavailable, type Metric } from "@/lib/metric";
import { buildAlerts } from "@/management/ai-manager/alerts";
import { findUnbalancedJournals } from "@/modules/finance/ledger-integrity";
import { ConditionInstrument, type ConditionSegment } from "@/components/os/ConditionInstrument";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import type { SupabaseClient } from "@supabase/supabase-js";

export const metadata = { title: "System Health — Singha Central" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

interface BacklogMetrics {
  pending: Metric;
  processing: Metric;
  retryWait: Metric;
  expiredLease: Metric;
  deadLetter: Metric;
  oldestPendingAt: string | null;
  unavailable: boolean;
}

async function probeBacklog(db: SupabaseClient, cid: string): Promise<BacklogMetrics> {
  try {
    const r = await db.rpc("source_event_backlog", { p_company: cid } as any);
    if (r.error) return allUnavailable();
    const row = (r.data as any[])[0];
    if (!row) {
      return {
        pending: value(0),
        processing: value(0),
        retryWait: value(0),
        expiredLease: value(0),
        deadLetter: value(0),
        oldestPendingAt: null,
        unavailable: false,
      };
    }
    return {
      pending: value(Number(row.pending ?? 0)),
      processing: value(Number(row.processing ?? 0)),
      retryWait: value(Number(row.retry_wait ?? 0)),
      expiredLease: value(Number(row.expired_lease ?? 0)),
      deadLetter: value(Number(row.dead_letter ?? 0)),
      oldestPendingAt: row.oldest_pending_at ?? null,
      unavailable: false,
    };
  } catch {
    return allUnavailable();
  }
}

function allUnavailable(): BacklogMetrics {
  const u = unavailable;
  return { pending: u, processing: u, retryWait: u, expiredLease: u, deadLetter: u, oldestPendingAt: null, unavailable: true };
}

interface AlertRow {
  key: string;
  severity: "critical" | "warning" | "info";
  message: string;
}

export default async function HealthPage() {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const cid = admin.companyId;

  const [failedEvents, unprocessedEvents, deadLetters, outboxFailed, outboxPending, aiRuns, audits, backlog] = await Promise.all([
    probeCount(() => db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "failed") as any),
    probeCount(() => db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["received", "processing"]) as any),
    // Company scope is not optional here: `db` is the service-role client, which bypasses row
    // security today, so an unscoped count returns every tenant's dead letters — and it feeds
    // classifyHealth/buildAlerts below, so another company's incident drove this dashboard to
    // CRITICAL. `company_id` on this table is nullable with no backfill, so an unattributed row is
    // included rather than dropped: scoping must not turn a loud wrong number into a silent zero.
    probeCount(() => db.from("dead_letter_events").select("id", { count: "exact", head: true }).or(`company_id.eq.${cid},company_id.is.null`).is("resolved_at", null) as any),
    probeCount(() => db.from("message_outbox").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["failed", "dead"]) as any),
    probeCount(() => db.from("message_outbox").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending") as any),
    rows<any>(() => db.from("ai_runs").select("cost_usd, validation_ok").eq("company_id", cid).limit(2000) as any),
    probeCount(() => db.from("audit_events").select("id", { count: "exact", head: true }).eq("company_id", cid) as any),
    probeBacklog(db, cid),
  ]);

  const aiCost = decSum(aiRuns.map((r: any) => r.cost_usd));
  // §WP6.3 — distinguishes healthy / zero / unavailable / error instead of masking as 0.
  const health = classifyHealth({ failedEvents, deadLetters, outboxFailed, unprocessedEvents });
  const healthVariant = health.level === "critical" ? "danger" : health.level === "warn" ? "warn" : "ok";

  // §WP6.5 — ranked, actionable alerts. Additional signals: repeated AI failures and
  // accounting-integrity (unbalanced posted journals — should never happen).
  const aiFailures = (aiRuns as any[]).filter((r: any) => r.validation_ok === false).length;
  const journalLines = await rows<any>(() =>
    db.from("journal_lines").select("journal_id, debit, credit").eq("company_id", cid).limit(5000) as any,
  );
  const integrityBreaches = findUnbalancedJournals(journalLines).length;
  const alerts = buildAlerts({
    failedEvents: metricNumber(failedEvents) ?? 0,
    deadLetters: metricNumber(deadLetters) ?? 0,
    outboxFailed: metricNumber(outboxFailed) ?? 0,
    repeatedAiFailures: aiFailures,
    accountingIntegrityBreaches: integrityBreaches,
    migrationMismatch: false,
  });

  // OF-016 — a payment paused as a suspected duplicate is WORK WAITING ON A PERSON, and it is
  // invisible to every other signal on this page: it is not a failure, not a dead letter, not
  // unprocessed, and it has no approval request. Read straight from the evidence table so the
  // operations view stays truthful even for an admin who cannot resolve them.
  // probeCount, NOT rows() — this is the §WP6.3 rule and the first version broke it. `rows()`
  // catches and returns [], so a database error rendered the tile as a calm "0" while payments sat
  // paused: exactly the outage-hiding pattern `Metric` exists to prevent. Reproduced against a
  // database without the table, which is the realistic "app deployed, hosted DB not yet migrated"
  // window this repository is in right now.
  // Distinct paused PAYMENTS, for the same reason the finance tiles count them that way: one
  // payment resembling two earlier ones raises two rows, and this tile is labelled in payments.
  // A head-count cannot express DISTINCT, so read the ids and reduce — still through probeCount's
  // contract, so a failed read is `unavailable`, never a reassuring 0 (§WP6.3).
  const pausedDuplicates = await probeCount(async () => {
    const r = await (db.from("duplicate_reviews").select("financial_event_id")
      .eq("company_id", cid).eq("state", "open") as any);
    if (r.error) return { count: null, error: r.error };
    const ids = ((r.data ?? []) as { financial_event_id: string }[]).map((x) => x.financial_event_id);
    return { count: new Set(ids).size };
  });

  const tiles = [
    {
      k: "Paused — suspected duplicates",
      v: metricLabel(pausedDuplicates),
      danger: metricState(pausedDuplicates) === "nonzero",
    },
    { k: "Failed events", v: metricLabel(failedEvents), danger: metricState(failedEvents) === "nonzero" },
    { k: "Dead letters", v: metricLabel(deadLetters), danger: metricState(deadLetters) === "nonzero" },
    { k: "Outbox failed", v: metricLabel(outboxFailed), danger: metricState(outboxFailed) === "nonzero" },
    { k: "Awaiting processing", v: metricLabel(unprocessedEvents), danger: false },
    { k: "Outbox pending", v: metricLabel(outboxPending), danger: false },
    { k: "AI runs", v: String(aiRuns.length), danger: false },
  ];

  const oldestPendingLabel = backlog.unavailable
    ? "unavailable"
    : backlog.oldestPendingAt
      ? new Date(backlog.oldestPendingAt).toLocaleString("en-GB", { timeZone: "UTC" })
      : "—";

  const alertColumns: DataTableColumn<AlertRow>[] = [
    {
      key: "severity",
      header: "Severity",
      render: (a) => <Badge variant={a.severity === "critical" ? "danger" : a.severity === "warning" ? "warn" : "info"}>{a.severity}</Badge>,
    },
    { key: "message", header: "Message", render: (a) => a.message },
  ];

  // ── The condition instrument ────────────────────────────────────────────
  // Segments are REAL counts. A signal whose probe failed is counted as
  // "cannot say", never as zero — the whole point of the Metric contract is
  // that a failed read must not render as a calm zero. Any unavailable probe
  // marks the instrument degraded, which suppresses the all-clear entirely.
  const probes: Metric[] = [
    pausedDuplicates,
    failedEvents,
    deadLetters,
    outboxFailed,
    unprocessedEvents,
    outboxPending,
    audits,
  ];
  const unreadable = probes.filter((m) => metricState(m) === "unavailable").length;
  const quiet = probes.filter((m) => metricState(m) === "zero").length;
  const degraded = unreadable > 0 || backlog.unavailable;

  const criticalAlerts = (alerts as AlertRow[]).filter((a) => a.severity === "critical").length;
  const warningAlerts = (alerts as AlertRow[]).filter((a) => a.severity === "warning").length;
  const infoAlerts = (alerts as AlertRow[]).length - criticalAlerts - warningAlerts;

  const segments: ConditionSegment[] = [
    { key: "critical", label: "Critical alerts", count: criticalAlerts, tone: "critical" },
    { key: "warning", label: "Warnings", count: warningAlerts, tone: "warn" },
    { key: "info", label: "Informational", count: infoAlerts, tone: "info" },
    { key: "unreadable", label: "Signals that could not be read", count: unreadable, tone: "blocked" },
    { key: "quiet", label: "Signals reading zero", count: quiet, tone: "ok" },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Platform"
        title="System health"
        lede="Queues, failures, backlog and AI cost. A signal that could not be read is reported as unreadable, never as a reassuring zero — this screen will not show green because a component merely rendered."
        actions={<Link className="btn ghost sm" href="/app/admin">Admin</Link>}
      />

      {degraded && (
        <StateNote kind="partial" title="Some signals could not be read">
          {unreadable > 0 && `${unreadable} probe(s) failed. `}
          {backlog.unavailable && "The source-event backlog RPC did not answer. "}
          No all-clear can be given while a signal is unreadable: an unreadable signal is not the
          same as a healthy one.
        </StateNote>
      )}

      <div className="centre">
        <div className="card pad-lg">
          <ConditionInstrument segments={segments} degraded={degraded} label="Now" />
          <div className="mt-3 row wrap gap-2 center">
            <Badge variant={healthVariant}>{health.level.toUpperCase()}</Badge>
          </div>
        </div>

        <div className="stack gap-2">
          <div className="card">
            <Section title="What is wrong" meta={`${health.issues.length} issue(s)`} />
            {health.issues.length === 0 ? (
              degraded ? (
                <StateNote kind="partial" title="No issues listed, but the read was incomplete">
                  The summariser found no issue in the signals it COULD read.
                </StateNote>
              ) : (
                <StateNote kind="empty" title="No issues detected">
                  Every signal on this page read successfully and none is in a failure state.
                </StateNote>
              )
            ) : (
              <div className="stack gap-2">
                {health.issues.map((i, idx) => (
                  <Signal key={idx} kind={health.level === "critical" ? "critical" : "warn"}>
                    {i}
                  </Signal>
                ))}
              </div>
            )}
          </div>

          {alerts.length > 0 && (
            <div className="card">
              <Section title="Alerts" meta={`${alerts.length}`} />
              <DataTable columns={alertColumns} rows={alerts as AlertRow[]} keyExtractor={(a) => a.key} />
            </div>
          )}
        </div>
      </div>

      {/* ── SIGNALS ─────────────────────────────────────────────────────── */}
      <Section title="Signals" meta="a dash means the probe failed, not that the count is zero" />
      <div className="field-matters">
        {tiles.map((t) => (
          <Matter
            key={t.k}
            kind="Signal"
            kindIcon={t.danger ? "alert-triangle" : "activity"}
            band={t.danger ? "critical" : "normal"}
            title={t.k}
            value={t.v}
            valueTone={t.danger ? "critical" : undefined}
            footer={
              t.v === "unavailable" ? (
                <Signal kind="blocked">Could not be read — this is not a zero</Signal>
              ) : t.danger ? (
                <Signal kind="critical">Needs attention</Signal>
              ) : (
                <Signal kind="ok">Quiet</Signal>
              )
            }
          />
        ))}
      </div>

      <Section title="Cost and audit" />
      <div className="grid cols-2">
        <div className="card stat">
          <div className="k">AI cost (USD)</div>
          <div className="v">${aiCost.toFixed(4)}</div>
          <div className="d">Across {aiRuns.length} recorded run(s)</div>
        </div>
        <div className="card stat">
          <div className="k">Audit events</div>
          <div className="v">{metricLabel(audits)}</div>
          <div className="d">
            {metricState(audits) === "unavailable" ? (
              <Signal kind="blocked">Could not be read</Signal>
            ) : (
              "Recorded in this company"
            )}
          </div>
        </div>
      </div>

      {/* CTL-003 — surface the migration 0069 backlog RPC so the operator sees the durable inbound pipeline. */}
      <Section title="Source-event backlog" meta="the durable inbound pipeline" />
      {backlog.unavailable ? (
        <StateNote kind="error" title="The backlog could not be read">
          The <code>source_event_backlog</code> RPC did not answer. The inbound pipeline may be fine
          or it may be stalled — this screen cannot tell, and will not guess.
        </StateNote>
      ) : (
        <div className="grid cols-3">
          <div className="card stat">
            <div className="k">Pending</div>
            <div className="v">{metricLabel(backlog.pending)}</div>
          </div>
          <div className="card stat">
            <div className="k">Processing</div>
            <div className="v">{metricLabel(backlog.processing)}</div>
          </div>
          <div className="card stat">
            <div className="k">Retry wait</div>
            <div className="v">{metricLabel(backlog.retryWait)}</div>
          </div>
          <div className="card stat">
            <div className="k">Expired lease</div>
            <div className="v" style={{ color: metricState(backlog.expiredLease) === "nonzero" ? "var(--danger)" : undefined }}>
              {metricLabel(backlog.expiredLease)}
            </div>
            <div className="d">
              {metricState(backlog.expiredLease) === "nonzero" && (
                <Signal kind="critical">Work was leased and never finished</Signal>
              )}
            </div>
          </div>
          <div className="card stat">
            <div className="k">Dead letter</div>
            <div className="v" style={{ color: metricState(backlog.deadLetter) === "nonzero" ? "var(--danger)" : undefined }}>
              {metricLabel(backlog.deadLetter)}
            </div>
            <div className="d">
              {metricState(backlog.deadLetter) === "nonzero" && (
                <Signal kind="critical">Events gave up — the original is preserved</Signal>
              )}
            </div>
          </div>
          <div className="card stat">
            <div className="k">Oldest pending</div>
            <div className="v" style={{ fontSize: "1.1rem" }}>{oldestPendingLabel}</div>
          </div>
        </div>
      )}
    </div>
  );
}
