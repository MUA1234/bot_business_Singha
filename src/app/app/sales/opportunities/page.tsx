/**
 * Sales → Opportunities (§9.1). Deals with amount + probability; a probability-
 * weighted forecast via the pure pipeline engine. Company-scoped + audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { summarizePipeline, type Opportunity } from "@/modules/commercial/pipeline-value";
import { dec, fmtMoney } from "@/lib/money";
import { BarChart } from "@/components/charts";
import { createOpportunity, setOpportunityStatus } from "./actions";
import { Card, CardHeader, CardBody, Badge, DataTable, EmptyState } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata = { title: "Opportunities — Singha Central" };

interface Deal {
  id: string;
  title: string;
  amount: string;
  currency: string;
  probability: number;
  expected_close: string | null;
  status: "open" | "won" | "lost";
}

const statusVariant = (status: string): "default" | "ok" | "warn" | "danger" => {
  if (status === "won") return "ok";
  if (status === "lost") return "danger";
  return "warn";
};

export default async function OpportunitiesPage() {
  const p = await requireDepartment("sales");
  const db = supabaseReadClient();

  let rows: any[] = [];
  let leads: any[] = [];
  try {
    rows = (await db.from("opportunities").select("id, title, amount, currency, probability, expected_close, status").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
    leads = (await db.from("leads").select("id, name").eq("company_id", p.companyId).not("stage", "in", "(won,lost)").order("name")).data ?? [];
  } catch {
    rows = [];
  }

  const deals: Deal[] = rows as Deal[];
  const currency = deals[0]?.currency ?? "LKR";
  // Amount strings go straight into the Decimal-based pipeline summary — no float round-trip.
  const summary = summarizePipeline(deals.map((r): Opportunity => ({ amount: String(r.amount ?? "0"), probability: Number(r.probability ?? 0), status: r.status as Opportunity["status"] })));
  const m = (v: string | number | null | undefined) => fmtMoney(v ?? "0", currency);

  return (
    <div className="stack gap-3">
      <div><h1>Opportunities</h1><p className="muted mt-1">Open deals and the probability-weighted forecast.</p></div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Open pipeline</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(summary.openValue)}</div><div className="d dim">{summary.openCount} deals</div></div>
        <div className="card stat"><div className="k">Weighted forecast</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--info)" }}>{m(summary.weightedValue)}</div></div>
        <div className="card stat"><div className="k">Won</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--ok)" }}>{m(summary.wonValue)}</div></div>
      </div>

      <Card>
        <CardHeader
          title="Pipeline at a glance"
          subtitle="If Weighted sits far below Open, raise deal probabilities or prune stale deals."
        />
        <CardBody>
          <BarChart
            valueOnAll
            data={[
              { label: `Open (${summary.openCount})`, display: m(summary.openValue), value: dec(summary.openValue).toNumber(), tone: "accent" },
              { label: "Weighted", display: m(summary.weightedValue), value: dec(summary.weightedValue).toNumber(), tone: "info" },
              { label: "Won", display: m(summary.wonValue), value: dec(summary.wonValue).toNumber(), tone: "ok" },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="New opportunity" />
        <CardBody>
          <form action={createOpportunity} className="row gap-1 wrap">
            <input name="title" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Deal name" required />
            <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" />
            <input name="probability" className="input" style={{ width: 90 }} placeholder="Prob %" inputMode="numeric" />
            <label className="small dim">Close <input name="expected_close" type="date" className="input" style={{ width: 150 }} /></label>
            <select name="lead_id" className="select" style={{ width: 150 }} defaultValue="">
              <option value="">No lead</option>
              {leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button className="btn" type="submit">Add</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Deals (${deals.length})`} />
        <CardBody>
          <DataTable
            columns={[
              { key: "deal", header: "Deal", render: (r) => <span style={{ fontWeight: 600 }}>{r.title}</span> },
              { key: "amount", header: "Amount", align: "right", render: (r) => m(r.amount) },
              { key: "prob", header: "Prob", align: "right", render: (r) => `${fmtNumber(r.probability ?? 0)}%` },
              { key: "close", header: "Close", render: (r) => <span className="dim small">{fmtDate(r.expected_close)}</span> },
              { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: "action",
                header: "",
                render: (r) =>
                  r.status === "open" ? (
                    <div className="row gap-1">
                      <form action={setOpportunityStatus}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value="won" /><button className="btn ghost sm" type="submit">Won</button></form>
                      <form action={setOpportunityStatus}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value="lost" /><button className="btn ghost sm danger" type="submit">Lost</button></form>
                    </div>
                  ) : null,
              },
            ]}
            rows={deals}
            keyExtractor={(r) => r.id}
            emptyTitle="No opportunities yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
