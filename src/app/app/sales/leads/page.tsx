/**
 * Sales → Leads. Wires the pure lead scorer (src/modules/commercial/lead-scoring)
 * to real, company-scoped data: capture leads, advance stage, and rank by a
 * hot/warm/cold grade. Read/writes are company-scoped + audited; graceful before the
 * Phase-4 tables exist.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { scoreLead, type LeadStage } from "@/modules/commercial/lead-scoring";
import { createLead, setLeadStage } from "./actions";
import { Card, CardHeader, CardBody, Badge, DataTable, EmptyState } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Leads — Singha Central" };

const STAGES: LeadStage[] = ["new", "contacted", "qualified", "proposal", "won", "lost"];
const gradeVariant = (g: string): "default" | "warn" | "danger" => (g === "hot" ? "danger" : g === "warm" ? "warn" : "default");

interface Lead {
  id: string;
  name: string;
  contact: string | null;
  stage: string;
  estimated_value: string;
  currency: string | null;
  last_contact_at: string | null;
  grade: string;
  score: number;
}

export default async function LeadsPage() {
  const p = await requireDepartment("sales");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("leads")
      .select("id, name, contact, stage, estimated_value, currency, last_contact_at")
      .eq("company_id", p.companyId)
      .limit(300);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  const now = Date.now();
  const scored: Lead[] = rows
    .map((r) => {
      const days = r.last_contact_at ? Math.floor((now - new Date(r.last_contact_at).getTime()) / 86_400_000) : null;
      const s = scoreLead({ stage: r.stage, estimatedValue: Number(r.estimated_value ?? 0), lastContactDaysAgo: days });
      return { ...r, ...s };
    })
    .sort((a, b) => b.score - a.score);

  return (
    <div className="stack gap-3">
      <div>
        <h1>Leads</h1>
        <p className="muted mt-1">Pipeline ranked by urgency — hottest first.</p>
      </div>

      <Card>
        <CardHeader title="New lead" />
        <CardBody>
          <form action={createLead} className="row gap-1 wrap">
            <input name="name" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Lead name" required />
            <input name="contact" className="input" style={{ flex: 1, minWidth: 120 }} placeholder="Contact" />
            <input name="source" className="input" style={{ width: 120 }} placeholder="Source" />
            <input name="estimated_value" className="input" style={{ width: 130 }} placeholder="Value" inputMode="numeric" />
            <button className="btn" type="submit">Add</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Pipeline (${scored.length})`} />
        <CardBody>
          <DataTable
            columns={[
              {
                key: "lead",
                header: "Lead",
                render: (r) => (
                  <div>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div className="small dim">{r.contact ?? ""}</div>
                  </div>
                ),
              },
              { key: "value", header: "Value", render: (r) => <span className="dim small">{fmtMoney(r.estimated_value, r.currency ?? "LKR")}</span> },
              {
                key: "grade",
                header: "Grade",
                render: (r) => (
                  <Badge variant={gradeVariant(r.grade)}>{r.grade} · {fmtNumber(r.score)}</Badge>
                ),
              },
              { key: "stage", header: "Stage", render: (r) => <Badge>{r.stage}</Badge> },
              {
                key: "move",
                header: "Move to",
                render: (r) => (
                  <div className="row gap-1 wrap">
                    {STAGES.filter((s) => s !== r.stage).map((s) => (
                      <form action={setLeadStage} key={s}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="stage" value={s} />
                        <button className="btn ghost sm" type="submit">{s}</button>
                      </form>
                    ))}
                  </div>
                ),
              },
            ]}
            rows={scored}
            keyExtractor={(r) => r.id}
            emptyTitle="No leads yet"
            emptyDescription="Add one above."
          />
        </CardBody>
      </Card>
    </div>
  );
}
