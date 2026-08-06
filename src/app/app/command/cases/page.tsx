/**
 * Management Cases (§WP5.1). Admin-only, read-only view of the durable, evidence-linked
 * records the Senior AI Manager produces on each analysis. Company-scoped; graceful if
 * migration 0028 has not been applied yet.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Management Cases — Singha" };

function list(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

export default async function CasesPage() {
  const admin = await requireAdmin();
  let cases: any[] = [];
  try {
    const { data } = await supabaseAdmin()
      .from("management_cases")
      .select("id, created_at, correlation_id, source_event_id, ai_run_id, confirmed_facts, inferred_facts, uncertainty, confidence, required_authority, requires_human, created_tasks")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(50);
    cases = data ?? [];
  } catch {
    cases = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Management Cases</h1>
          <p className="muted mt-1">Durable, evidence-linked records of each AI analysis. Observe/propose only — nothing here executed.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command/analyze">Analyse an update →</Link>
      </div>

      {cases.length === 0 ? (
        <div className="card"><div className="empty">No management cases yet. Run an analysis in the Command Centre, then apply migration 0028 to persist them.</div></div>
      ) : (
        <div className="stack gap-2">
          {cases.map((c) => (
            <div key={c.id} className="card">
              <div className="row between">
                <div className="small dim">{new Date(c.created_at).toLocaleString()} · {c.source_event_id ?? "manual"}</div>
                <div className="row gap-1">
                  {c.requires_human && <span className="badge warn">needs human</span>}
                  <span className="badge">{c.required_authority ?? "—"}</span>
                  <span className="badge">conf {c.confidence != null ? Number(c.confidence).toFixed(2) : "—"}</span>
                  {c.created_tasks > 0 && <span className="badge ok">{c.created_tasks} task(s)</span>}
                </div>
              </div>
              {list(c.confirmed_facts).length > 0 && (
                <div className="mt-2"><strong className="small">Confirmed</strong>
                  <ul className="small">{list(c.confirmed_facts).map((f, i) => <li key={i}>{f}</li>)}</ul>
                </div>
              )}
              {list(c.inferred_facts).length > 0 && (
                <div className="mt-1"><strong className="small dim">Inferred</strong>
                  <ul className="small dim">{list(c.inferred_facts).map((f, i) => <li key={i}>{f}</li>)}</ul>
                </div>
              )}
              {c.uncertainty && <p className="small muted mt-1">Uncertainty: {c.uncertainty}</p>}
              <div className="small dim mt-1">correlation {c.correlation_id ?? "—"} · run {c.ai_run_id ?? "—"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
