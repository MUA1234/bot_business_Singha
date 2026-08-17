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
import { probeCount, metricLabel, metricState, metricNumber } from "@/lib/metric";
import { buildAlerts } from "@/management/ai-manager/alerts";
import { findUnbalancedJournals } from "@/modules/finance/ledger-integrity";

export const metadata = { title: "System Health — Singha" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function HealthPage() {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const cid = admin.companyId;

  const [failedEvents, unprocessedEvents, deadLetters, outboxFailed, outboxPending, aiRuns, audits] = await Promise.all([
    probeCount(() => db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "failed") as any),
    probeCount(() => db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["received", "processing"]) as any),
    probeCount(() => db.from("dead_letter_events").select("id", { count: "exact", head: true }).is("resolved_at", null) as any),
    probeCount(() => db.from("message_outbox").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["failed", "dead"]) as any),
    probeCount(() => db.from("message_outbox").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending") as any),
    rows<any>(() => db.from("ai_runs").select("cost_usd, validation_ok").eq("company_id", cid).limit(2000) as any),
    probeCount(() => db.from("audit_events").select("id", { count: "exact", head: true }).eq("company_id", cid) as any),
  ]);

  const aiCost = decSum(aiRuns.map((r: any) => r.cost_usd));
  // §WP6.3 — distinguishes healthy / zero / unavailable / error instead of masking as 0.
  const health = classifyHealth({ failedEvents, deadLetters, outboxFailed, unprocessedEvents });
  const levelColor = health.level === "critical" ? "var(--danger)" : health.level === "warn" ? "var(--warn)" : "var(--ok)";

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

  const tiles = [
    { k: "Failed events", v: metricLabel(failedEvents), danger: metricState(failedEvents) === "nonzero" },
    { k: "Dead letters", v: metricLabel(deadLetters), danger: metricState(deadLetters) === "nonzero" },
    { k: "Outbox failed", v: metricLabel(outboxFailed), danger: metricState(outboxFailed) === "nonzero" },
    { k: "Awaiting processing", v: metricLabel(unprocessedEvents), danger: false },
    { k: "Outbox pending", v: metricLabel(outboxPending), danger: false },
    { k: "AI runs", v: String(aiRuns.length), danger: false },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>System Health</h1>
          <p className="muted mt-1">Queues, failures, and AI cost. <span style={{ color: levelColor, fontWeight: 700 }}>{health.level.toUpperCase()}</span></p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
      </div>

      {health.issues.length > 0 && (
        <div className={`notice ${health.level === "critical" ? "err" : "ok"}`}>
          {health.issues.map((i, idx) => <div key={idx}>• {i}</div>)}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="card">
          <div className="card-title">Alerts ({alerts.length})</div>
          <div className="stack gap-1 mt-2">
            {alerts.map((a) => (
              <div key={a.key} className="row gap-1" style={{ alignItems: "center" }}>
                <span className={`badge ${a.severity === "critical" ? "danger" : a.severity === "warning" ? "warn" : ""}`}>{a.severity}</span>
                <span className="small">{a.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid cols-3">
        {tiles.map((t) => (
          <div key={t.k} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v" style={{ fontSize: "1.6rem", color: t.danger ? "var(--danger)" : undefined }}>{t.v}</div>
          </div>
        ))}
      </div>

      <div className="grid cols-2">
        <div className="card stat"><div className="k">AI cost (USD)</div><div className="v" style={{ fontSize: "1.4rem" }}>${aiCost.toFixed(4)}</div></div>
        <div className="card stat"><div className="k">Audit events</div><div className="v" style={{ fontSize: "1.4rem" }}>{metricLabel(audits)}</div></div>
      </div>
    </div>
  );
}
