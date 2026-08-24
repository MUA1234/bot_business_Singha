/**
 * Reusable System Health panel. Used by `/app/admin/health` and the spatial workspace.
 * The caller must enforce permission (admin).
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { classifyHealth } from "@/management/ai-manager/health";
import { buildAlerts } from "@/management/ai-manager/alerts";
import { findUnbalancedJournals } from "@/modules/finance/ledger-integrity";
import { decSum } from "@/lib/money";
import { probeCount, metricLabel, metricState, metricNumber, unavailable, value, type Metric } from "@/lib/metric";
import { SystemHealthPanelContent } from "./SystemHealthPanelContent";
import type { AlertRow, SystemHealthPanelData } from "./SystemHealthPanelContent";

export { SystemHealthPanelContent } from "./SystemHealthPanelContent";
export type { SystemHealthPanelData } from "./SystemHealthPanelContent";

type PlainObject = Record<string, unknown>;

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

function allUnavailable() {
  const u = unavailable;
  return {
    pending: u,
    processing: u,
    retryWait: u,
    expiredLease: u,
    deadLetter: u,
    oldestPendingAt: null,
    unavailable: true,
  };
}

async function probeBacklog(db: ReturnType<typeof supabaseAdmin>, cid: string) {
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

function toLabelMetric(m: Metric): { label: string; danger: boolean } {
  return { label: metricLabel(m), danger: metricState(m) === "nonzero" };
}

export async function loadSystemHealthData(companyId: string, _userId?: string): Promise<PlainObject> {
  const db = supabaseAdmin();
  const cid = companyId;

  const [failedEvents, unprocessedEvents, deadLetters, outboxFailed, outboxPending, aiRuns, audits, backlogRaw] =
    await Promise.all([
      probeCount(() =>
        db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "failed") as any,
      ),
      probeCount(() =>
        db
          .from("source_events")
          .select("id", { count: "exact", head: true })
          .eq("company_id", cid)
          .in("status", ["received", "processing"]) as any,
      ),
      // Company scope is not optional here: `db` is the service-role client, which bypasses row
      // security today, so an unscoped count returns every tenant's dead letters — and it feeds
      // classifyHealth/buildAlerts below, so another company's incident drove this dashboard to
      // CRITICAL. `company_id` on this table is nullable with no backfill, so an unattributed row is
      // included rather than dropped: scoping must not turn a loud wrong number into a silent zero.
      probeCount(() =>
        db
          .from("dead_letter_events")
          .select("id", { count: "exact", head: true })
          .or(`company_id.eq.${cid},company_id.is.null`)
          .is("resolved_at", null) as any,
      ),
      probeCount(() =>
        db
          .from("message_outbox")
          .select("id", { count: "exact", head: true })
          .eq("company_id", cid)
          .in("status", ["failed", "dead"]) as any,
      ),
      probeCount(() =>
        db
          .from("message_outbox")
          .select("id", { count: "exact", head: true })
          .eq("company_id", cid)
          .eq("status", "pending") as any,
      ),
      rows<any>(() =>
        db.from("ai_runs").select("cost_usd, validation_ok").eq("company_id", cid).limit(2000) as any,
      ),
      probeCount(() => db.from("audit_events").select("id", { count: "exact", head: true }).eq("company_id", cid) as any),
      probeBacklog(db, cid),
    ]);

  const aiCost = decSum(aiRuns.map((r: any) => r.cost_usd));
  const health = classifyHealth({ failedEvents, deadLetters, outboxFailed, unprocessedEvents });
  const healthVariant = health.level === "critical" ? "danger" : health.level === "warn" ? "warn" : "ok";

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
  }).map((a) => ({ key: a.key, severity: a.severity as AlertRow["severity"], message: a.message }));

  // OF-016 — distinct paused PAYMENTS, never through rows() which would hide a DB outage as 0.
  const pausedDuplicates = await probeCount(async () => {
    const r = await (db
      .from("duplicate_reviews")
      .select("financial_event_id")
      .eq("company_id", cid)
      .eq("state", "open") as any);
    if (r.error) return { count: null, error: r.error };
    const ids = ((r.data ?? []) as { financial_event_id: string }[]).map((x) => x.financial_event_id);
    return { count: new Set(ids).size };
  });

  const tiles = [
    { k: "Paused — suspected duplicates", v: metricLabel(pausedDuplicates), danger: metricState(pausedDuplicates) === "nonzero" },
    { k: "Failed events", v: metricLabel(failedEvents), danger: metricState(failedEvents) === "nonzero" },
    { k: "Dead letters", v: metricLabel(deadLetters), danger: metricState(deadLetters) === "nonzero" },
    { k: "Outbox failed", v: metricLabel(outboxFailed), danger: metricState(outboxFailed) === "nonzero" },
    { k: "Awaiting processing", v: metricLabel(unprocessedEvents), danger: false },
    { k: "Outbox pending", v: metricLabel(outboxPending), danger: false },
    { k: "AI runs", v: String(aiRuns.length), danger: false },
  ];

  const oldestPendingLabel = backlogRaw.unavailable
    ? "unavailable"
    : backlogRaw.oldestPendingAt
      ? new Date(backlogRaw.oldestPendingAt).toLocaleString("en-GB", { timeZone: "UTC" })
      : "—";

  const data: SystemHealthPanelData = {
    health: { level: health.level, issues: health.issues },
    healthVariant,
    alerts,
    tiles,
    aiCost: `$${aiCost.toFixed(4)}`,
    auditsLabel: metricLabel(audits),
    backlog: {
      pending: toLabelMetric(backlogRaw.pending),
      processing: toLabelMetric(backlogRaw.processing),
      retryWait: toLabelMetric(backlogRaw.retryWait),
      expiredLease: toLabelMetric(backlogRaw.expiredLease),
      deadLetter: toLabelMetric(backlogRaw.deadLetter),
      oldestPendingLabel,
      unavailable: backlogRaw.unavailable,
    },
  };

  return data as unknown as PlainObject;
}

interface SystemHealthPanelProps {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}

export default async function SystemHealthPanel({ companyId, userId, embedded }: SystemHealthPanelProps) {
  const data = await loadSystemHealthData(companyId, userId);
  return <SystemHealthPanelContent data={data} embedded={embedded ?? false} />;
}
