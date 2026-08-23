/**
 * FIN-006 — Budgets vs actual. Company-scoped list of budgets with a create form.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtNumber } from "@/lib/format";
import {
  Card,
  CardHeader,
  CardBody,
  DataTable,
  type DataTableColumn,
  Button,
} from "@/components/ui";
import { createBudget } from "./actions";

export const metadata = { title: "Budgets vs Actual — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function BudgetsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [budgets, fiscalYears] = await Promise.all([
    safe<any>(() =>
      db
        .from("budgets")
        .select("id, name, fiscal_year_id, currency, budget_lines(id)")
        .eq("company_id", p.companyId)
        .order("name") as any,
    ),
    safe<any>(() => db.from("fiscal_years").select("id, name").eq("company_id", p.companyId).order("name") as any),
  ]);

  const fyById = new Map(fiscalYears.map((fy) => [fy.id, fy.name]));

  const columns: DataTableColumn<any>[] = [
    { key: "name", header: "Name", render: (b) => <Link href={`/app/finance/budgets/${b.id}`} className="link">{b.name}</Link> },
    { key: "fiscal_year", header: "Fiscal year", render: (b) => <span className="dim">{b.fiscal_year_id ? fyById.get(b.fiscal_year_id) ?? "—" : "—"}</span> },
    { key: "lines", header: "Lines", align: "right", render: (b) => fmtNumber(Array.isArray(b.budget_lines) ? b.budget_lines.length : 0) },
    { key: "currency", header: "Currency", align: "right", className: "mono", render: (b) => b.currency },
    { key: "action", header: "", render: (b) => <Link href={`/app/finance/budgets/${b.id}`} className="btn ghost sm">View</Link> },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Budgets vs actual</h1>
        <p className="muted mt-1">Build budgets by period and compare them to actual journal activity.</p>
      </div>

      <Card>
        <CardHeader title="New budget" />
        <CardBody>
          <form action={createBudget} className="row gap-1 wrap items-end">
            <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Budget name" required />
            <select name="fiscal_year_id" className="input" style={{ width: 160 }}>
              <option value="">Fiscal year…</option>
              {fiscalYears.map((fy) => (
                <option key={fy.id} value={fy.id}>{fy.name}</option>
              ))}
            </select>
            <input name="currency" className="input" style={{ width: 80 }} placeholder="LKR" defaultValue="LKR" maxLength={3} />
            <Button type="submit">Create</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Budgets (${budgets.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={budgets}
            keyExtractor={(b) => b.id}
            emptyTitle="No budgets yet"
            className="mt-3"
          />
        </CardBody>
      </Card>
    </div>
  );
}
