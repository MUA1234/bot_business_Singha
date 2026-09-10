import Link from "next/link";
import { requireMembership, membershipHasCapability } from "@/lib/access";
import { supabaseReadClient } from "@/lib/supabase/read";
import { saveModelBudgetPolicy } from "./actions";
import { Card, CardHeader, CardBody, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { FormField } from "@/components/ui/FormField";
import { fmtDateTime, fmtNumber } from "@/lib/format";
import { fmtMoney } from "@/lib/money";
import { PermissionDenied } from "@/components/ui/PermissionDenied";

export const metadata = { title: "Model Budgets — Singha Central" };

interface PolicyRow {
  task: string;
  max_cost_usd: string | number;
  is_active: boolean;
  version: number;
  updated_at: string;
}

export default async function ModelBudgetsPage() {
  const membership = await requireMembership();
  const allowed = await membershipHasCapability(membership, "ai.model_budget.manage");
  if (!allowed) {
    return (
      <PermissionDenied title="Model budgets" actionHref="/app/admin">
        You do not have permission to view model budget policies.
      </PermissionDenied>
    );
  }

  const { data, error } = await supabaseReadClient()
    .from("ai_model_budget_policies")
    .select("task,max_cost_usd,is_active,version,updated_at")
    .eq("company_id", membership.companyId)
    .order("task");
  if (error) return <div className="notice err">Configuration required: {error.message}</div>;
  const rows = (data ?? []) as PolicyRow[];

  const columns: DataTableColumn<PolicyRow>[] = [
    { key: "task", header: "Task", render: (r) => r.task },
    {
      key: "limit",
      header: "Daily limit",
      align: "right",
      render: (r) => fmtMoney(r.max_cost_usd, "USD"),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.is_active ? "active" : "disabled"} />,
    },
    {
      key: "version",
      header: "Version",
      align: "right",
      render: (r) => fmtNumber(r.version),
    },
    {
      key: "updated",
      header: "Updated",
      render: (r) => fmtDateTime(r.updated_at),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap">
        <div>
          <h1>Model budgets</h1>
          <p className="muted mt-1">
            Missing, disabled, or exhausted policies prevent model calls.
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">
          ← Admin
        </Link>
      </div>

      <Card>
        <CardHeader title="Policies" subtitle={`${rows.length} configured`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.task}
            emptyTitle="No policies configured"
            emptyDescription="Add a daily USD spend limit for each model task below."
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Configure policy" subtitle="Set or update a daily USD limit." />
        <form action={saveModelBudgetPolicy as any} className="stack gap-1">
          <CardBody>
            <div className="grid cols-3">
              <FormField label="Model task" hint="Which model task this policy governs.">
                <select name="task" className="select" defaultValue="extraction">
                  <option value="extraction">Extraction</option>
                  <option value="quotation">Quotation</option>
                  <option value="management">Management</option>
                </select>
              </FormField>
              <FormField label="Daily USD limit" hint="Max spend per day in USD.">
                <input
                  name="maxCostUsd"
                  className="input"
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </FormField>
              <FormField label="Status" hint="Disabled policies block model calls.">
                <select name="active" className="select" defaultValue="true">
                  <option value="true">Active</option>
                  <option value="false">Disabled</option>
                </select>
              </FormField>
            </div>
            <input name="version" type="hidden" value="0" />
          </CardBody>
          <CardFooter>
            <Button type="submit">Configure policy</Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
