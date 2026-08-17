import { requireProfile } from "@/lib/auth";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/server";
import { fmtMoney } from "@/lib/money";
import { AddProductForm } from "./AddProductForm";
import { setProductActive } from "./actions";

export const metadata = { title: "Products & Prices — Singha Central" };

export default async function CatalogPage() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") redirect(`/app/${p.department}`);

  const { data } = await supabaseAdmin()
    .from("product_catalog")
    .select("id, name, sku, unit_price, currency, is_active")
    .eq("company_id", p.companyId)
    .order("name");

  const rows = data ?? [];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Products &amp; Prices</h1>
        <p className="muted mt-1">
          The AI quoting engine prices customer requests against this list. If a requested item isn’t
          here (or its price is blank), the quotation is held and sent to a department for confirmation.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Add a product</div>
        <div className="mt-3">
          <AddProductForm />
        </div>
      </div>

      <div className="card">
        <div className="card-title">Catalog ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No products yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Unit price</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td className="mono dim">{r.sku ?? "—"}</td>
                    <td>{r.unit_price == null ? <span className="badge warn">Varies</span> : fmtMoney(r.unit_price, r.currency)}</td>
                    <td>{r.is_active ? <span className="badge ok">Active</span> : <span className="badge danger">Hidden</span>}</td>
                    <td>
                      <form action={setProductActive}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="active" value={(!r.is_active).toString()} />
                        <button className="btn ghost sm" type="submit">{r.is_active ? "Hide" : "Show"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
