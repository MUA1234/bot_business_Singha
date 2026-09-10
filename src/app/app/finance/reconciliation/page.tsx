/**
 * Bank reconciliation (§8.3). Suggests which payment/receipt clears each unmatched
 * bank transaction (pure matcher). Read-only — a human confirms matches elsewhere;
 * nothing is posted here. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Button, Badge, StatusBadge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import type { BadgeVariant } from "@/components/ui/Badge";
import { fmtDate } from "@/lib/format";
import { suggestMatches, type BankTxn, type ReconCandidate } from "@/modules/finance/reconcile";
import { importBankTransactions, confirmMatch } from "./actions";

export const metadata = { title: "Reconciliation — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function ReconciliationPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const banks = await safe<any>(() => db.from("bank_accounts").select("id, name, currency").eq("company_id", p.companyId).order("name") as any);

  const [bankRows, payRows, recRows] = await Promise.all([
    safe<any>(() => db.from("bank_transactions").select("id, txn_date, description, amount, currency, status").eq("company_id", p.companyId).neq("status", "matched").neq("status", "ignored").limit(300) as any),
    safe<any>(() => db.from("payments").select("id, payment_date, amount, currency, status").eq("company_id", p.companyId).neq("status", "void").limit(500) as any),
    safe<any>(() => db.from("receipts").select("id, received_date, amount, currency").eq("company_id", p.companyId).limit(500) as any),
  ]);

  const txns: BankTxn[] = bankRows.map((b) => ({ id: b.id, date: b.txn_date, amount: String(b.amount ?? 0), currency: b.currency, description: b.description }));
  const candidates: ReconCandidate[] = [
    ...payRows.map((p2): ReconCandidate => ({ id: p2.id, kind: "payment", date: p2.payment_date, amount: String(p2.amount ?? 0), currency: p2.currency })),
    ...recRows.map((r): ReconCandidate => ({ id: r.id, kind: "receipt", date: r.received_date, amount: String(r.amount ?? 0), currency: r.currency })),
  ];

  const suggestions = suggestMatches(txns, candidates, 5);
  const byId = new Map(txns.map((t) => [t.id, t]));
  const matched = suggestions.filter((s) => s.candidateId);
  const confBadge = (c: string) => (c === "high" ? "ok" : c === "medium" ? "warn" : "");

  const txnColumns: DataTableColumn<(typeof suggestions)[number]>[] = [
    {
      key: "date",
      header: "Date",
      render: (s) => {
        const t = byId.get(s.bankTxnId)!;
        return <span className="dim small">{fmtDate(t.date)}</span>;
      },
    },
    {
      key: "description",
      header: "Description",
      render: (s) => {
        const t = byId.get(s.bankTxnId)!;
        return t.description ?? "—";
      },
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (s) => {
        const t = byId.get(s.bankTxnId)!;
        return fmtMoney(t.amount, t.currency);
      },
    },
    {
      key: "suggestion",
      header: "Suggestion",
      render: (s) => {
        const t = byId.get(s.bankTxnId)!;
        return s.candidateId ? (
          <div className="row gap-1 wrap">
            <Badge variant={confBadge(s.confidence) as BadgeVariant}>{s.candidateKind} · {s.confidence}</Badge>
            <form action={confirmMatch}>
              <input type="hidden" name="bank_txn_id" value={s.bankTxnId} />
              <input type="hidden" name="target_type" value={s.candidateKind ?? ""} />
              <input type="hidden" name="target_id" value={s.candidateId} />
              <input type="hidden" name="amount" value={dec(t.amount).abs().toFixed(2)} />
              <Button variant="ghost" size="sm" type="submit">Confirm</Button>
            </form>
          </div>
        ) : (
          <Badge>no match</Badge>
        );
      },
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Reconciliation</h1>
          <p className="muted mt-1">Suggested matches for unmatched bank transactions. Confirm before posting.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance">← Finance</Link>
      </div>

      <Card>
        <CardHeader title="Import bank statement" />
        <CardBody>
          {banks.length === 0 ? (
            <EmptyState
              title="No bank account"
              description="Add a bank account first so you can import statement lines."
              action={{ label: "Bank & Cash", href: "/app/finance/accounts" }}
            />
          ) : (
            <form action={importBankTransactions} className="stack gap-2">
              <select name="bank_account_id" className="select" style={{ maxWidth: 320 }}>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}
              </select>
              <textarea name="lines" className="textarea" placeholder={"One per line: date, amount, description\n2026-08-05, -1500.00, Payment to Acme\n2026-08-06, 2000.00, Customer receipt"} />
              <Button type="submit">Import lines</Button>
            </form>
          )}
        </CardBody>
      </Card>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Unmatched txns</div><div className="v" style={{ fontSize: "1.5rem" }}>{txns.length}</div></div>
        <div className="card stat"><div className="k">Suggested matches</div><div className="v" style={{ fontSize: "1.5rem", color: "var(--ok)" }}>{matched.length}</div></div>
        <div className="card stat"><div className="k">Candidates</div><div className="v" style={{ fontSize: "1.5rem" }}>{candidates.length}</div></div>
      </div>

      <Card>
        <CardHeader title="Bank transactions" />
        <CardBody>
          {txns.length === 0 ? (
            <EmptyState title="No unmatched bank transactions" />
          ) : (
            <DataTable columns={txnColumns} rows={suggestions} keyExtractor={(s) => s.bankTxnId} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
