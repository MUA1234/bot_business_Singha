/**
 * Finance → Periods (§8.1/§8.3). Fiscal years and their monthly periods. Closing (or
 * locking) a period blocks new journals dated inside it — enforced by the posting RPC.
 * Reopening is a controlled, audited action. Company-scoped, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody, Button, StatusBadge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { createFiscalYear, setPeriodStatus } from "./actions";

export const metadata = { title: "Periods — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function PeriodsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const thisYear = new Date().getUTCFullYear();

  const [years, periods] = await Promise.all([
    safe<any>(() => db.from("fiscal_years").select("id, name, status").eq("company_id", p.companyId).order("name", { ascending: false }) as any),
    safe<any>(() => db.from("accounting_periods").select("id, fiscal_year_id, name, status").eq("company_id", p.companyId).order("name") as any),
  ]);
  const byYear = new Map<string, any[]>();
  for (const pr of periods) {
    const list = byYear.get(pr.fiscal_year_id) ?? [];
    list.push(pr);
    byYear.set(pr.fiscal_year_id, list);
  }
  const badge = (s: string) => (s === "open" ? "ok" : s === "locked" ? "danger" : "warn");

  return (
    <div className="stack gap-3">
      <div><h1>Accounting Periods</h1><p className="muted mt-1">Close a period to lock the ledger against it. Reopening is audited.</p></div>

      <Card>
        <CardHeader title="New fiscal year" />
        <CardBody>
          <form action={createFiscalYear} className="row gap-1 wrap">
            <input name="year" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Year" inputMode="numeric" defaultValue={String(thisYear)} />
            <Button type="submit">Create year + 12 periods</Button>
          </form>
        </CardBody>
      </Card>

      {years.length === 0 ? (
        <Card>
          <EmptyState title="No fiscal years yet" />
        </Card>
      ) : years.map((y) => {
        const periodsForYear = byYear.get(y.id) ?? [];
        const columns: DataTableColumn<(typeof periodsForYear)[number]>[] = [
          { key: "name", header: "Period", render: (pr) => <span className="mono">{pr.name}</span> },
          { key: "status", header: "Status", render: (pr) => <StatusBadge status={pr.status} /> },
          {
            key: "actions",
            header: "Actions",
            render: (pr) => (
              <div className="row gap-1 wrap">
                {pr.status === "open" && (
                  <form action={setPeriodStatus}>
                    <input type="hidden" name="id" value={pr.id} />
                    <input type="hidden" name="status" value="closed" />
                    <Button variant="ghost" size="sm" type="submit">Close</Button>
                  </form>
                )}
                {pr.status === "closed" && (
                  <>
                    <form action={setPeriodStatus}>
                      <input type="hidden" name="id" value={pr.id} />
                      <input type="hidden" name="status" value="open" />
                      <Button variant="ghost" size="sm" type="submit">Reopen</Button>
                    </form>
                    <form action={setPeriodStatus}>
                      <input type="hidden" name="id" value={pr.id} />
                      <input type="hidden" name="status" value="locked" />
                      <Button variant="danger" size="sm" type="submit">Lock</Button>
                    </form>
                  </>
                )}
                {pr.status === "locked" && (
                  <form action={setPeriodStatus}>
                    <input type="hidden" name="id" value={pr.id} />
                    <input type="hidden" name="status" value="open" />
                    <Button variant="ghost" size="sm" type="submit">Reopen</Button>
                  </form>
                )}
              </div>
            ),
          },
        ];
        return (
          <Card key={y.id}>
            <CardHeader title={<span>FY {y.name} <StatusBadge status={y.status} /></span>} />
            <CardBody>
              <DataTable columns={columns} rows={periodsForYear} keyExtractor={(pr) => pr.id} emptyTitle="No periods for this year" />
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
