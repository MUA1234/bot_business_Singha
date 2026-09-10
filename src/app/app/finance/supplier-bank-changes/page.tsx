/**
 * Supplier bank-detail changes (§WP2.5). Maker/checker: finance requests a change; a
 * DIFFERENT finance/admin user approves it before it applies to the supplier. Read +
 * request + decide. Company-scoped; graceful if migration 0029 has not been applied.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtDate } from "@/lib/format";
import {
  Card,
  CardHeader,
  CardBody,
  StatusBadge,
  DataTable,
  type DataTableColumn,
  Button,
} from "@/components/ui";
import { requestBankChange, decideBankChange } from "./actions";

export const metadata = { title: "Supplier Bank Changes — Singha Central" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function BankChangesPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [suppliers, changes] = await Promise.all([
    rows<any>(() => db.from("suppliers").select("id, name, bank_account_name, bank_account_number").eq("company_id", p.companyId).eq("status", "active").order("name") as any),
    rows<any>(() => db.from("supplier_bank_detail_changes").select("id, supplier_id, old_account_number, new_account_number, new_account_name, requested_by, status, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(50) as any),
  ]);
  const nameOf = (sid: string) => suppliers.find((s) => s.id === sid)?.name ?? sid;

  const columns: DataTableColumn<any>[] = [
    { key: "when", header: "When", render: (c) => <span className="small dim">{fmtDate(c.created_at)}</span> },
    { key: "supplier", header: "Supplier", render: (c) => nameOf(c.supplier_id) },
    {
      key: "newAccount",
      header: "New account",
      render: (c) => (
        <span className="small">
          {c.new_account_name ? `${c.new_account_name} · ` : ""}{c.new_account_number ?? ""}
        </span>
      ),
    },
    { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
    {
      key: "action",
      header: "",
      render: (c) => {
        if (c.status !== "pending") return null;
        const isRequester = c.requested_by === p.userId;
        return isRequester ? (
          <span className="small dim">awaiting another approver</span>
        ) : (
          <div className="row gap-1 wrap">
            <form action={decideBankChange}>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="decision" value="approved" />
              <Button size="sm" type="submit">Approve</Button>
            </form>
            <form action={decideBankChange}>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="decision" value="rejected" />
              <Button variant="ghost" size="sm" type="submit">Reject</Button>
            </form>
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Supplier bank changes</h1>
        <p className="muted mt-1">A bank-detail change is sensitive: it must be requested by one person and approved by another before it applies.</p>
      </div>

      <Card>
        <CardHeader title="Request a change" />
        <CardBody>
          <form action={requestBankChange} className="row gap-1 wrap items-end">
            <select name="supplier_id" className="select" style={{ minWidth: 180 }} required>
              <option value="">Select supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input name="new_account_name" className="input" style={{ width: 180 }} placeholder="New account name" />
            <input name="new_account_number" className="input" style={{ width: 180 }} placeholder="New account number" />
            <Button variant="ghost" size="sm" type="submit">Request</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent changes" />
        <CardBody>
          <DataTable
            columns={columns}
            rows={changes}
            keyExtractor={(c) => c.id}
            emptyTitle="No bank-detail changes yet"
            className="mt-3"
          />
        </CardBody>
      </Card>
    </div>
  );
}
