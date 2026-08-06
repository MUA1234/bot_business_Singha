/**
 * Journal detail (§8.2) — the immutable header + its debit/credit lines.
 * Company-scoped, read-only, graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { reverseJournal } from "../actions";

export const metadata = { title: "Journal — Singha" };

export default async function JournalDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const { data: j } = await db
    .from("journal_entries")
    .select("id, posting_date, currency, memo, status, total_debit, total_credit")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!j) notFound();

  const { data: lines } = await db
    .from("journal_lines")
    .select("account_code, debit, credit, description, line_no")
    .eq("journal_id", j.id)
    .eq("company_id", p.companyId)
    .order("line_no");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Journal</h1>
          <p className="muted mt-1">{j.posting_date} · <span className="badge">{j.status}</span> {j.memo ? `· ${j.memo}` : ""}</p>
        </div>
        <div className="row gap-1">
          {j.status === "posted" && (
            <form action={reverseJournal}>
              <input type="hidden" name="journal_id" value={j.id} />
              <button className="btn ghost sm danger" type="submit">Reverse</button>
            </form>
          )}
          <Link className="btn ghost sm" href="/app/finance/journals">← Journals</Link>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>#</th><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {(lines ?? []).map((l: any) => (
                <tr key={l.line_no}>
                  <td className="dim small">{l.line_no}</td>
                  <td className="mono">{l.account_code}</td>
                  <td>{l.description ?? "—"}</td>
                  <td className="num">{Number(l.debit) ? `${j.currency} ${Number(l.debit).toLocaleString()}` : "—"}</td>
                  <td className="num">{Number(l.credit) ? `${j.currency} ${Number(l.credit).toLocaleString()}` : "—"}</td>
                </tr>
              ))}
              <tr>
                <td></td><td></td><td style={{ textAlign: "right", fontWeight: 700 }}>Total</td>
                <td className="num" style={{ fontWeight: 700 }}>{j.currency} {Number(j.total_debit ?? 0).toLocaleString()}</td>
                <td className="num" style={{ fontWeight: 700 }}>{j.currency} {Number(j.total_credit ?? 0).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
