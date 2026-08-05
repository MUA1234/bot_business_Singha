/**
 * Bank reconciliation (§8.3). Suggests which payment/receipt clears each unmatched
 * bank transaction (pure matcher). Read-only — a human confirms matches elsewhere;
 * nothing is posted here. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { suggestMatches, type BankTxn, type ReconCandidate } from "@/modules/finance/reconcile";
import { importBankTransactions, confirmMatch } from "./actions";

export const metadata = { title: "Reconciliation — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function ReconciliationPage() {
  const p = await requireDepartment("finance");
  const db = supabaseAdmin();

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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Reconciliation</h1>
          <p className="muted mt-1">Suggested matches for unmatched bank transactions. Confirm before posting.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance">← Finance</Link>
      </div>

      <div className="card">
        <div className="card-title">Import bank statement</div>
        {banks.length === 0 ? (
          <div className="empty">Add a <Link href="/app/finance/accounts">bank account</Link> first.</div>
        ) : (
          <form action={importBankTransactions} className="stack gap-2 mt-2">
            <select name="bank_account_id" className="select" style={{ width: 240 }}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}
            </select>
            <textarea name="lines" className="textarea" placeholder={"One per line: date, amount, description\n2026-08-05, -1500.00, Payment to Acme\n2026-08-06, 2000.00, Customer receipt"} />
            <button className="btn" type="submit">Import lines</button>
          </form>
        )}
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Unmatched txns</div><div className="v" style={{ fontSize: "1.5rem" }}>{txns.length}</div></div>
        <div className="card stat"><div className="k">Suggested matches</div><div className="v" style={{ fontSize: "1.5rem", color: "var(--ok)" }}>{matched.length}</div></div>
        <div className="card stat"><div className="k">Candidates</div><div className="v" style={{ fontSize: "1.5rem" }}>{candidates.length}</div></div>
      </div>

      <div className="card">
        <div className="card-title">Bank transactions</div>
        {txns.length === 0 ? (
          <div className="empty">No unmatched bank transactions.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Suggestion</th></tr></thead>
              <tbody>
                {suggestions.map((s) => {
                  const t = byId.get(s.bankTxnId)!;
                  return (
                    <tr key={s.bankTxnId}>
                      <td className="dim small">{t.date}</td>
                      <td>{t.description ?? "—"}</td>
                      <td className="num">{t.currency} {Number(t.amount).toLocaleString()}</td>
                      <td>
                        {s.candidateId ? (
                          <div className="row gap-1">
                            <span className={`badge ${confBadge(s.confidence)}`}>{s.candidateKind} · {s.confidence}</span>
                            <form action={confirmMatch}>
                              <input type="hidden" name="bank_txn_id" value={s.bankTxnId} />
                              <input type="hidden" name="target_type" value={s.candidateKind ?? ""} />
                              <input type="hidden" name="target_id" value={s.candidateId} />
                              <input type="hidden" name="amount" value={Math.abs(Number(t.amount))} />
                              <button className="btn ghost sm" type="submit">Confirm</button>
                            </form>
                          </div>
                        ) : (
                          <span className="badge">no match</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
