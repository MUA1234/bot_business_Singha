/**
 * Sales → Customer Accounts (§9.1). Each customer with their invoice count and total
 * outstanding (from customer_invoices). Click through to a 360 view. Read-only,
 * company-scoped, graceful.
 */
import Link from "next/link";
import Decimal from "decimal.js";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, decSub, fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, DataTable } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Customer Accounts — Singha Central" };

interface CustomerAccount {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

interface CustomerAgg {
  outstanding: Decimal;
  count: number;
  currency: string;
}

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function AccountsPage() {
  const p = await requireDepartment("sales");
  const db = supabaseReadClient();

  const [customers, invoices] = await Promise.all([
    safe<CustomerAccount>(() => db.from("customers").select("id, name, email, phone").eq("company_id", p.companyId).order("name").limit(500) as any),
    safe<any>(() => db.from("customer_invoices").select("customer_id, currency, total_amount, amount_settled, status").eq("company_id", p.companyId).not("status", "in", "(paid,cancelled)") as any),
  ]);

  const outByCustomer = new Map<string, CustomerAgg>();
  for (const inv of invoices) {
    const cur = outByCustomer.get(inv.customer_id) ?? { outstanding: dec(0), count: 0, currency: inv.currency ?? "LKR" };
    cur.outstanding = cur.outstanding.plus(decSub(inv.total_amount, inv.amount_settled));
    cur.count += 1;
    outByCustomer.set(inv.customer_id, cur);
  }

  const rows = customers
    .map((c) => ({ ...c, agg: outByCustomer.get(c.id) ?? { outstanding: dec(0), count: 0, currency: "LKR" } }))
    .sort((a, b) => b.agg.outstanding.comparedTo(a.agg.outstanding));

  return (
    <div className="stack gap-3">
      <div><h1>Customer Accounts</h1><p className="muted mt-1">Everyone you invoice, with what they owe.</p></div>

      <Card>
        <CardHeader title="Accounts" />
        <CardBody>
          <DataTable
            columns={[
              { key: "customer", header: "Customer", render: (c) => <span style={{ fontWeight: 600 }}>{c.name}</span> },
              { key: "contact", header: "Contact", render: (c) => <span className="dim small">{c.email ?? c.phone ?? "—"}</span> },
              { key: "count", header: "Open invoices", align: "right", render: (c) => fmtNumber(c.agg.count) },
              {
                key: "outstanding",
                header: "Outstanding",
                align: "right",
                render: (c) => (
                  <span style={{ color: c.agg.outstanding.greaterThan(0) ? "var(--warn)" : undefined }}>
                    {fmtMoney(c.agg.outstanding, c.agg.currency)}
                  </span>
                ),
              },
              {
                key: "action",
                header: "",
                render: (c) => <Link className="btn ghost sm" href={`/app/sales/accounts/${c.id}`}>Open</Link>,
              },
            ]}
            rows={rows}
            keyExtractor={(c) => c.id}
            emptyTitle="No customers yet"
            emptyDescription="They're created when you raise an invoice."
          />
        </CardBody>
      </Card>
    </div>
  );
}
