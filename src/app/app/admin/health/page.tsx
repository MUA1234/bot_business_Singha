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
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
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

  return (
    <div className="stack gap-3">
      <div className="row between wrap">
        <div>
          <h1>System Health</h1>
          <p className="muted mt-1">
            Queues, failures, and AI cost.{" "}
            <Badge variant={healthVariant}>{health.level.toUpperCase()}</Badge>
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
      </div>

      {health.issues.length > 0 && (
        <div className={`notice ${health.level === "critical" ? "err" : "ok"}`}>
          {health.issues.map((i, idx) => <div key={idx}>• {i}</div>)}
        </div>
      )}

      {alerts.length > 0 && (
        <Card>
          <CardHeader title={`Alerts (${alerts.length})`} />
          <CardBody>
            <DataTable columns={alertColumns} rows={alerts as AlertRow[]} keyExtractor={(a) => a.key} />
          </CardBody>
        </Card>
      )}

      <div className="grid cols-3">
        {tiles.map((t) => (
          <Card key={t.k} className="stat">
            <div className="k">{t.k}</div>
            <div className="v" style={{ color: t.danger ? "var(--danger)" : undefined }}>{t.v}</div>
          </Card>
        ))}
      </div>

      <div className="grid cols-2">
        <Card className="stat">
          <div className="k">AI cost (USD)</div>
          <div className="v" style={{ color: "var(--info)" }}>${aiCost.toFixed(4)}</div>
        </Card>
        <Card className="stat">
          <div className="k">Audit events</div>
          <div className="v">{metricLabel(audits)}</div>
        </Card>
      </div>

      {/* CTL-003 — surface the migration 0069 backlog RPC so the operator sees the durable inbound pipeline. */}
      <Card>
        <CardHeader title="Source-event backlog" />
        <CardBody>
          <div className="grid cols-3">
            <Card className="stat">
              <div className="k">Pending</div>
              <div className="v">{metricLabel(backlog.pending)}</div>
            </Card>
            <Card className="stat">
              <div className="k">Processing</div>
              <div className="v">{metricLabel(backlog.processing)}</div>
            </Card>
            <Card className="stat">
              <div className="k">Retry wait</div>
              <div className="v">{metricLabel(backlog.retryWait)}</div>
            </Card>
            <Card className="stat">
              <div className="k">Expired lease</div>
              <div className="v" style={{ color: metricState(backlog.expiredLease) === "nonzero" ? "var(--danger)" : undefined }}>{metricLabel(backlog.expiredLease)}</div>
            </Card>
            <Card className="stat">
              <div className="k">Dead letter</div>
              <div className="v" style={{ color: metricState(backlog.deadLetter) === "nonzero" ? "var(--danger)" : undefined }}>{metricLabel(backlog.deadLetter)}</div>
            </Card>
            <Card className="stat">
              <div className="k">Oldest pending</div>
              <div className="v">{oldestPendingLabel}</div>
            </Card>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
