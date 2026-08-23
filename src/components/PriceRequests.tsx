import { supabaseReadClient } from "@/lib/supabase/read";
import { resolvePrice, dismissPrice } from "@/app/app/_actions/price";
import { DataTable, EmptyState } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

interface PriceConfirmation {
  id: string;
  description: string;
  quantity: number;
  currency: string;
  department: string | null;
  ai_suggested_price: string | null;
  quotation_id: string;
  created_at: string;
}

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
  let q = supabaseReadClient()
    .from("price_confirmations")
    .select("id, description, quantity, currency, department, ai_suggested_price, quotation_id, created_at")
    .eq("company_id", companyId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (department) q = q.eq("department", department);
  const { data: rows } = await q;

  const confirmations: PriceConfirmation[] = (rows ?? []) as PriceConfirmation[];

  // Quote numbers for context.
  const quoteIds = Array.from(new Set(confirmations.map((r) => r.quotation_id)));
  const numbers = new Map<string, string>();
  if (quoteIds.length) {
    const { data: quotes } = await supabaseReadClient()
      .from("quotations")
      .select("id, quote_number")
      .in("id", quoteIds);
    for (const qn of quotes ?? []) numbers.set(qn.id, qn.quote_number);
  }

  if (confirmations.length === 0) {
    return <EmptyState title="No open price confirmations" icon="inbox" />;
  }

  return (
    <DataTable
      columns={[
        { key: "item", header: "Item", render: (r) => <span style={{ fontWeight: 600 }}>{r.description}</span> },
        { key: "qty", header: "Qty", render: (r) => fmtNumber(r.quantity) },
        { key: "quotation", header: "Quotation", render: (r) => <span className="mono dim">{numbers.get(r.quotation_id) ?? "—"}</span> },
        {
          key: "confirm",
          header: "Confirm unit price",
          render: (r) => (
            <form action={resolvePrice} className="row gap-1 wrap">
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
          ),
        },
        {
          key: "dismiss",
          header: "",
          render: (r) => (
            <form action={dismissPrice}>
              <input type="hidden" name="confirmation_id" value={r.id} />
              <button className="btn ghost sm" type="submit">Dismiss</button>
            </form>
          ),
        },
      ]}
      rows={confirmations}
      keyExtractor={(r) => r.id}
    />
  );
}
