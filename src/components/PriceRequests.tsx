import { supabaseAdmin } from "@/lib/supabase/server";
import { resolvePrice, dismissPrice } from "@/app/app/_actions/price";

/**
 * Open price-confirmation queue for a department. Staff type the confirmed unit
 * price; when the quotation has no remaining unknowns it is auto-finalized and
 * WhatsApp'd to the customer (see lib/quotations.tryFinalizeAndSend).
 * `department = null` shows every department (admin view).
 */
export async function PriceRequests({
  companyId,
  department,
}: {
  companyId: string;
  department: string | null;
}) {
  let q = supabaseAdmin()
    .from("price_confirmations")
    .select("id, description, quantity, currency, department, ai_suggested_price, quotation_id, created_at")
    .eq("company_id", companyId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (department) q = q.eq("department", department);
  const { data: rows } = await q;

  // Quote numbers for context.
  const quoteIds = Array.from(new Set((rows ?? []).map((r: any) => r.quotation_id)));
  const numbers = new Map<string, string>();
  if (quoteIds.length) {
    const { data: quotes } = await supabaseAdmin()
      .from("quotations")
      .select("id, quote_number")
      .in("id", quoteIds);
    for (const qn of quotes ?? []) numbers.set(qn.id, qn.quote_number);
  }

  if (!rows || rows.length === 0) {
    return <div className="empty">No open price confirmations. 🎉</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Quotation</th>
            <th>Confirm unit price</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.id}>
              <td style={{ fontWeight: 600 }}>{r.description}</td>
              <td>{Number(r.quantity)}</td>
              <td className="mono dim">{numbers.get(r.quotation_id) ?? "—"}</td>
              <td>
                <form action={resolvePrice} className="row gap-1">
                  <input type="hidden" name="confirmation_id" value={r.id} />
                  <span className="dim small">{r.currency}</span>
                  <input
                    name="price"
                    className="input"
                    inputMode="decimal"
                    placeholder="0.00"
                    style={{ width: 120, padding: "6px 10px" }}
                    required
                  />
                  <button className="btn sm" type="submit">Confirm &amp; send</button>
                </form>
              </td>
              <td>
                <form action={dismissPrice}>
                  <input type="hidden" name="confirmation_id" value={r.id} />
                  <button className="btn ghost sm" type="submit">Dismiss</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
