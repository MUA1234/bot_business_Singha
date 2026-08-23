/**
 * Finance → Chart of Accounts (§8.1). Company-scoped create + list of ledger
 * accounts. Audited; graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody, Button, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { createAccount } from "./actions";

export const metadata = { title: "Chart of Accounts — Singha Central" };
const TYPES = ["asset", "liability", "equity", "income", "expense"];

export default async function ChartOfAccountsPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("chart_of_accounts")
      .select("code, name, type, is_active")
      .eq("company_id", p.companyId)
      .order("code")
      .limit(500);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    { key: "code", header: "Code", render: (r) => <span className="mono" style={{ fontWeight: 600 }}>{r.code}</span> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "type", header: "Type", render: (r) => <Badge>{r.type}</Badge> },
    { key: "active", header: "Active", render: (r) => r.is_active ? <Badge variant="ok">yes</Badge> : <Badge>no</Badge> },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Chart of Accounts</h1>
          <p className="muted mt-1">The ledger accounts you post journals to.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/journals">Journals →</Link>
      </div>

      <Card>
        <CardHeader title="New account" />
        <CardBody>
          <form action={createAccount} className="row gap-1 wrap">
            <input name="code" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Code (e.g. 1000)" required />
            <input name="name" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Account name" required />
            <select name="type" className="select" style={{ flex: "0 0 150px", minWidth: 120 }} defaultValue="asset">
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <Button type="submit">Add</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Accounts (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.code}
            emptyTitle="No accounts yet"
            emptyDescription="Add a few (e.g. 1000 Cash / asset, 4000 Sales / income)."
          />
        </CardBody>
      </Card>
    </div>
  );
}
