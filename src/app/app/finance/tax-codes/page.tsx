/**
 * Finance → Tax Codes (§8.3). Company-scoped create + list of tax rates. Audited,
 * graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { taxAmount } from "@/accounting/tax";
import { fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Button, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";
import { createTaxCode } from "./actions";

export const metadata = { title: "Tax Codes — Singha Central" };

export default async function TaxCodesPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("tax_codes").select("id, code, name, rate, is_active").eq("company_id", p.companyId).order("code").limit(100)).data ?? [];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    { key: "code", header: "Code", render: (r) => <span className="mono" style={{ fontWeight: 600 }}>{r.code}</span> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "rate", header: "Rate", align: "right", render: (r) => `${fmtNumber(Number(r.rate))}%` },
    { key: "tax", header: "Tax on 1,000", align: "right", render: (r) => <span className="dim">{fmtMoney(taxAmount("1000", Number(r.rate), "LKR"))}</span> },
  ];

  return (
    <div className="stack gap-3">
      <div><h1>Tax Codes</h1><p className="muted mt-1">Rates used on invoices and bills.</p></div>

      <Card>
        <CardHeader title="New tax code" />
        <CardBody>
          <form action={createTaxCode} className="row gap-1 wrap">
            <input name="code" className="input" style={{ flex: "0 0 110px", minWidth: 90 }} placeholder="Code (VAT)" required />
            <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Name" required />
            <input name="rate" className="input" style={{ flex: "0 0 100px", minWidth: 80 }} placeholder="Rate %" inputMode="decimal" />
            <Button type="submit">Add</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Tax codes (${rows.length})`} />
        <CardBody>
          <DataTable columns={columns} rows={rows} keyExtractor={(r) => r.id} emptyTitle="No tax codes yet" />
        </CardBody>
      </Card>
    </div>
  );
}
