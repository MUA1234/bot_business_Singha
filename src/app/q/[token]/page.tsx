import { notFound } from "next/navigation";

import { supabaseReadClient } from "@/lib/supabase/read";
import { PrintButton } from "./PrintButton";

// Quotations carry customer PII behind a shareable capability-URL. Never let a
// search engine index or cache them, even if a token leaks into a referrer/history.
export const metadata = {
  title: "Quotation — Singha",
  robots: { index: false, follow: false, nocache: true },
};

function money(v: number | string | null, currency: string): string {
  if (v == null) return "—";
  return `${currency} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

export default async function QuotationPage({ params }: { params: { token: string } }) {
  const db = supabaseReadClient();
  const { data: quote } = await db
    .from("quotations")
    .select("id, quote_number, currency, subtotal, tax_amount, total, status, notes, created_at, order_id, company_id")
    .eq("public_token", params.token)
    .maybeSingle();
  if (!quote) notFound();

  const [{ data: items }, { data: order }, { data: company }] = await Promise.all([
    db.from("quotation_items").select("description, quantity, unit_price, line_total, status").eq("quotation_id", quote.id),
    db.from("orders").select("customer_name, customer_address, customer_phone, customer_email").eq("id", quote.order_id).maybeSingle(),
    db.from("companies").select("name, legal_name, country").eq("id", quote.company_id).maybeSingle(),
  ]);

  const cur = quote.currency;
  const pending = quote.status === "awaiting_price" || quote.status === "draft";

  return (
    <>
      {/* Document-scoped light theme + print rules. */}
      <style>{`
        .qpage{background:#f8f1f0;min-height:100vh;padding:32px 16px;color:#1c1210;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
        .qdoc{max-width:820px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 24px 60px -24px rgba(120,25,18,.4)}
        .qhead{display:flex;justify-content:space-between;align-items:flex-start;padding:28px 32px;background:linear-gradient(135deg,#3a0f0d,#c9241a);color:#fff}
        .qhead img{height:44px}
        .qbrand{display:flex;align-items:center;gap:12px}
        .qbrand .nm{font-weight:800;font-size:1.4rem;letter-spacing:.12em}
        .qmeta{text-align:right;font-size:.85rem;opacity:.95}
        .qmeta h2{margin:0 0 4px;font-size:1.4rem;letter-spacing:.04em}
        .qbody{padding:28px 32px}
        .qparties{display:flex;gap:40px;flex-wrap:wrap;margin-bottom:20px}
        .qparties h4{margin:0 0 6px;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#b48a86}
        table.q{width:100%;border-collapse:collapse;font-size:.92rem}
        table.q th{text-align:left;background:#fbecea;color:#b3271b;padding:10px 12px;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
        table.q td{padding:11px 12px;border-bottom:1px solid #eee}
        .num{text-align:right}
        .qtotal{display:flex;justify-content:flex-end;margin-top:16px}
        .qtotal .box{min-width:260px}
        .qtotal .r{display:flex;justify-content:space-between;padding:6px 0}
        .qtotal .grand{border-top:2px solid #c9241a;margin-top:6px;padding-top:10px;font-weight:800;color:#c9241a;font-size:1.1rem}
        .qnote{margin-top:24px;font-size:.82rem;color:#666}
        .qactions{max-width:820px;margin:16px auto 0;display:flex;justify-content:flex-end}
        .qbtn{background:linear-gradient(135deg,#ef3b2b,#c9241a);color:#fff;border:none;border-radius:999px;padding:10px 20px;font-weight:700;cursor:pointer;font-size:.9rem}
        .qwait{background:#fff6e6;border:1px solid #ffd591;color:#8a5a00;padding:12px 16px;border-radius:12px;margin-bottom:18px;font-size:.9rem}
        .pill{display:inline-block;font-size:.7rem;font-weight:700;padding:3px 9px;border-radius:999px;background:#fbecea;color:#c9241a}
        @media (max-width:560px){
          .qpage{padding:16px 10px}
          .qhead{flex-direction:column;gap:14px;padding:20px}
          .qmeta{text-align:left}
          .qbody{padding:20px}
          .qparties{gap:20px}
          .qtotal .box{min-width:0;width:100%}
          table.q{font-size:.82rem}
          table.q th,table.q td{padding:8px 8px}
        }
        @media print{.qpage{background:#fff;padding:0}.qactions{display:none}.qdoc{box-shadow:none;border-radius:0}}
      `}</style>
      <div className="qpage">
        <div className="qdoc">
          <div className="qhead">
            <div className="qbrand">
              <img src="/brand/lion.png" alt="Singha" />
              <span className="nm">SINGHA</span>
            </div>
            <div className="qmeta">
              <h2>QUOTATION</h2>
              <div># {quote.quote_number}</div>
              <div>{new Date(quote.created_at).toLocaleDateString()}</div>
              <div style={{ marginTop: 6 }}>
                <span className="pill">{quote.status.replace("_", " ")}</span>
              </div>
            </div>
          </div>

          <div className="qbody">
            {pending && (
              <div className="qwait">Your quotation is being finalised — the amounts below may update shortly.</div>
            )}

            <div className="qparties">
              <div>
                <h4>From</h4>
                <div style={{ fontWeight: 700 }}>{company?.name ?? "Singha"}</div>
                <div>{company?.legal_name ?? ""}</div>
              </div>
              <div>
                <h4>Prepared for</h4>
                <div style={{ fontWeight: 700 }}>{order?.customer_name ?? "Customer"}</div>
                <div>{order?.customer_address ?? ""}</div>
                <div>{order?.customer_phone ?? ""}</div>
                <div>{order?.customer_email ?? ""}</div>
              </div>
            </div>

            <table className="q">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((it: any, i: number) => (
                  <tr key={i}>
                    <td>{it.description}</td>
                    <td className="num">{Number(it.quantity)}</td>
                    <td className="num">{it.status === "priced" ? money(it.unit_price, cur) : "TBC"}</td>
                    <td className="num">{it.status === "priced" ? money(it.line_total, cur) : "TBC"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="qtotal">
              <div className="box">
                <div className="r">
                  <span>Subtotal</span>
                  <span>{money(quote.subtotal, cur)}</span>
                </div>
                {Number(quote.tax_amount) > 0 && (
                  <div className="r">
                    <span>Tax</span>
                    <span>{money(quote.tax_amount, cur)}</span>
                  </div>
                )}
                <div className="r grand">
                  <span>Total</span>
                  <span>{money(quote.total, cur)}</span>
                </div>
              </div>
            </div>

            {quote.notes && <div className="qnote">{quote.notes}</div>}
            <div className="qnote">Thank you for choosing Singha. This quotation was generated automatically; reply on WhatsApp to proceed.</div>
          </div>
        </div>
        <div className="qactions">
          <PrintButton />
        </div>
      </div>
    </>
  );
}
