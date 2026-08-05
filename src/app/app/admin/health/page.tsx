/**
 * System Health (Architecture V2 change plan §13 / OBSERVABILITY). Admin-only view
 * of operational counters — failed/unprocessed events, dead letters, outbox failures,
 * AI runs & cost. Uses the pure health summariser. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { systemHealth } from "@/management/ai-manager/health";

export const metadata = { title: "System Health — Singha" };

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try {
    return (await run()).count ?? 0;
  } catch {
    return 0;
  }
}
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
    count(() => db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "failed") as any),
    count(() => db.from("source_events").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["received", "processing"]) as any),
    count(() => db.from("dead_letter_events").select("id", { count: "exact", head: true }).is("resolved_at", null) as any),
    count(() => db.from("message_outbox").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["failed", "dead"]) as any),
    count(() => db.from("message_outbox").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending") as any),
    rows<any>(() => db.from("ai_runs").select("cost_usd").eq("company_id", cid).limit(2000) as any),
    count(() => db.from("audit_events").select("id", { count: "exact", head: true }).eq("company_id", cid) as any),
  ]);

  const aiCost = aiRuns.reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0);
  const health = systemHealth({ failedEvents, deadLetters, outboxFailed, unprocessedEvents });
  const levelColor = health.level === "critical" ? "var(--danger)" : health.level === "warn" ? "var(--warn)" : "var(--ok)";

  const tiles = [
    { k: "Failed events", v: failedEvents, danger: failedEvents > 0 },
    { k: "Dead letters", v: deadLetters, danger: deadLetters > 0 },
    { k: "Outbox failed", v: outboxFailed, danger: outboxFailed > 0 },
    { k: "Awaiting processing", v: unprocessedEvents, danger: false },
    { k: "Outbox pending", v: outboxPending, danger: false },
    { k: "AI runs", v: aiRuns.length, danger: false },
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
        <div className="card stat"><div className="k">Audit events</div><div className="v" style={{ fontSize: "1.4rem" }}>{audits}</div></div>
      </div>
    </div>
  );
}
