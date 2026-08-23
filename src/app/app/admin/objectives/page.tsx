/**
 * Admin → Objectives / KPIs (§10.1). Company-scoped goals with progress vs time,
 * graded by the pure objective-status engine. Create + update progress. Audited,
 * graceful.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { assessObjective, type ObjectiveStatus } from "@/management/ai-manager/objective-status";
import { fmtDate, fmtNumber } from "@/lib/format";
import { Card, CardHeader, CardBody, Button, Badge, DataTable, FormField } from "@/components/ui";
import { type BadgeVariant } from "@/components/ui/Badge";
import { createObjective, updateObjectiveProgress } from "./actions";

export const metadata = { title: "Objectives — Singha Central" };

const statusVariant: Record<ObjectiveStatus, BadgeVariant> = {
  done: "ok",
  on_track: "ok",
  at_risk: "warn",
  off_track: "danger",
};

export default async function ObjectivesPage() {
  const admin = await requireAdmin();

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("objectives")
      .select("id, title, metric, unit, target_value, current_value, period_start, period_end")
      .eq("company_id", admin.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
  } catch {
    rows = [];
  }

  const columns = [
    {
      key: "objective",
      header: "Objective",
      render: (r: any) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.title}</div>
          <div className="small dim">{r.metric ?? ""}</div>
        </div>
      ),
    },
    {
      key: "progress",
      header: "Progress",
      align: "right" as const,
      render: (r: any) => {
        const a = assessObjective({
          target: Number(r.target_value ?? 0),
          current: Number(r.current_value ?? 0),
          periodStart: r.period_start,
          periodEnd: r.period_end,
        });
        return (
          <span>
            {fmtNumber(Number(r.current_value ?? 0))} / {fmtNumber(Number(r.target_value ?? 0))} {r.unit ?? ""}{" "}
            <span className="dim">({fmtNumber(Math.round(a.progressPct * 100))}%)</span>
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      render: (r: any) => {
        const a = assessObjective({
          target: Number(r.target_value ?? 0),
          current: Number(r.current_value ?? 0),
          periodStart: r.period_start,
          periodEnd: r.period_end,
        });
        return <Badge variant={statusVariant[a.status]}>{a.status.replace(/_/g, " ")}</Badge>;
      },
    },
    {
      key: "period",
      header: "Period",
      render: (r: any) => (
        <span className="small dim">
          {fmtDate(r.period_start)} – {fmtDate(r.period_end)}
        </span>
      ),
    },
    {
      key: "update",
      header: "Update",
      render: (r: any) => (
        <form action={updateObjectiveProgress} className="row gap-1">
          <input type="hidden" name="id" value={r.id} />
          <input
            name="current_value"
            className="input"
            style={{ width: 90, padding: "6px 8px" }}
            placeholder="current"
            inputMode="decimal"
          />
          <Button variant="ghost" size="sm" type="submit">
            Save
          </Button>
        </form>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Objectives &amp; KPIs</h1>
          <p className="muted mt-1">Goals graded by progress against the clock.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">
          ← Admin
        </Link>
      </div>

      <Card>
        <CardHeader title="New objective" />
        <CardBody>
          <form action={createObjective} className="stack gap-2">
            <div className="row gap-2 wrap">
              <FormField
                name="title"
                label="Objective"
                placeholder="e.g. Increase monthly revenue"
                required
                style={{ flex: 1, minWidth: 180 }}
              />
              <FormField
                name="metric"
                label="Metric"
                placeholder="e.g. Revenue"
                style={{ flex: 1, minWidth: 140 }}
              />
            </div>
            <div className="row gap-2 wrap">
              <FormField
                name="target_value"
                label="Target"
                placeholder="0"
                inputMode="decimal"
                style={{ flex: 1, minWidth: 120 }}
              />
              <FormField
                name="unit"
                label="Unit"
                placeholder="e.g. LKR"
                style={{ flex: 1, minWidth: 100 }}
              />
              <FormField name="period_start" label="From" type="date" style={{ flex: 1, minWidth: 140 }} />
              <FormField name="period_end" label="To" type="date" style={{ flex: 1, minWidth: 140 }} />
            </div>
            <div className="row">
              <Button type="submit">Add objective</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Objectives (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No objectives yet"
            emptyDescription="Create a new objective to start tracking progress against targets."
          />
        </CardBody>
      </Card>
    </div>
  );
}
