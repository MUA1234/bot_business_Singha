/**
 * Management Cases (§WP5.1). Admin-only, read-only view of the durable, evidence-linked
 * records the business analysis assistant produces on each analysis. Company-scoped; graceful if
 * migration 0028 has not been applied yet.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { fmtDateTime, fmtNumber } from "@/lib/format";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Management Cases — Singha Central" };

function list(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

interface ManagementCase {
  id: string;
  created_at: string;
  correlation_id: string | null;
  source_event_id: string | null;
  ai_run_id: string | null;
  confirmed_facts: unknown;
  inferred_facts: unknown;
  uncertainty: string | null;
  confidence: number | null;
  required_authority: string | null;
  requires_human: boolean;
  created_tasks: number | null;
}

export default async function CasesPage() {
  const admin = await requireAdmin();
  let cases: ManagementCase[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("management_cases")
      .select("id, created_at, correlation_id, source_event_id, ai_run_id, confirmed_facts, inferred_facts, uncertainty, confidence, required_authority, requires_human, created_tasks")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(50);
    cases = (data ?? []) as ManagementCase[];
  } catch {
    cases = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Management Cases</h1>
          <p className="muted mt-1">Durable, evidence-linked records of each AI analysis. Observe/propose only — nothing here executed.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command/analyze" aria-label="Analyse a new update">Analyse an update →</Link>
      </div>

      {cases.length === 0 ? (
        <Card>
          <EmptyState
            title="No management cases yet"
            description="Run an analysis in the Command Centre, then apply migration 0028 to persist them."
            icon="clipboard"
          />
        </Card>
      ) : (
        <div className="stack gap-2">
          {cases.map((c) => (
            <Card key={c.id}>
              <CardHeader
                title={fmtDateTime(c.created_at)}
                subtitle={`${c.source_event_id ?? "manual"} · correlation ${c.correlation_id ?? "—"}`}
                action={
                  <div className="row gap-1 wrap">
                    {c.requires_human && <StatusBadge status="needs human" />}
                    <Badge>{c.required_authority ?? "—"}</Badge>
                    <Badge>conf {c.confidence != null ? fmtNumber(c.confidence, 2) : "—"}</Badge>
                    {(c.created_tasks ?? 0) > 0 && <Badge variant="ok">{c.created_tasks} task(s)</Badge>}
                  </div>
                }
              />
              <CardBody padding="sm">
                {list(c.confirmed_facts).length > 0 && (
                  <div className="mt-2">
                    <strong className="small">Confirmed</strong>
                    <ul className="small">{list(c.confirmed_facts).map((f, i) => <li key={i}>{f}</li>)}</ul>
                  </div>
                )}
                {list(c.inferred_facts).length > 0 && (
                  <div className="mt-1">
                    <strong className="small dim">Inferred</strong>
                    <ul className="small dim">{list(c.inferred_facts).map((f, i) => <li key={i}>{f}</li>)}</ul>
                  </div>
                )}
                {c.uncertainty && <p className="small muted mt-1">Uncertainty: {c.uncertainty}</p>}
                <div className="small dim mt-1">run {c.ai_run_id ?? "—"}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
