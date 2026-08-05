"use client";

import { useState } from "react";
import { useActionState } from "react";
import { checkDraftJournal, type DraftLine } from "@/accounting/manual-entry";
import { postJournal, type JournalState } from "../actions";

interface AccountOpt {
  code: string;
  name: string;
}

const blank = (): DraftLine => ({ account_code: "", debit: "", credit: "", description: "" });

/**
 * Manual journal entry (§8.2). Builds balanced debit/credit lines with a live
 * balance check (pure engine, in-browser) and posts atomically via the server action.
 */
export function JournalForm({ accounts, currency }: { accounts: AccountOpt[]; currency: string }) {
  const [state, formAction] = useActionState<JournalState, FormData>(postJournal, {});
  const [lines, setLines] = useState<DraftLine[]>([blank(), blank()]);

  const update = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, blank()]);
  const removeLine = (i: number) => setLines((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));

  const check = checkDraftJournal(lines, currency);

  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <div className="row gap-1 wrap">
        <label className="small dim">Date <input name="date" type="date" className="input" style={{ width: 160 }} defaultValue={new Date().toISOString().slice(0, 10)} /></label>
        <label className="small dim">Currency <input name="currency" className="input" style={{ width: 90 }} defaultValue={currency} /></label>
        <input name="memo" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Memo (optional)" />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <input list="acct-list" className="input" style={{ width: 150 }} placeholder="code"
                    value={l.account_code} onChange={(e) => update(i, { account_code: e.target.value })} />
                </td>
                <td>
                  <input className="input" style={{ minWidth: 140 }} placeholder="line note"
                    value={l.description ?? ""} onChange={(e) => update(i, { description: e.target.value })} />
                </td>
                <td className="num">
                  <input className="input" style={{ width: 110 }} inputMode="decimal" value={l.debit}
                    onChange={(e) => update(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                </td>
                <td className="num">
                  <input className="input" style={{ width: 110 }} inputMode="decimal" value={l.credit}
                    onChange={(e) => update(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                </td>
                <td><button type="button" className="btn ghost sm" onClick={() => removeLine(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="acct-list">
        {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
      </datalist>

      <div className="row between wrap gap-2">
        <button type="button" className="btn ghost sm" onClick={addLine}>+ Add line</button>
        <div className="small">
          Debit <b>{currency} {Number(check.totalDebit).toLocaleString()}</b> · Credit <b>{currency} {Number(check.totalCredit).toLocaleString()}</b>{" "}
          {check.balanced ? <span className="badge ok">balanced</span> : <span className="badge danger">unbalanced</span>}
        </div>
      </div>

      {state.error && <div className="notice err">{state.error}</div>}
      <button className="btn" type="submit" disabled={!check.ready}>Post journal</button>
    </form>
  );
}
