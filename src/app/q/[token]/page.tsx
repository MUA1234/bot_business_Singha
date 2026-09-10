import { notFound } from "next/navigation";

import { supabaseReadClient } from "@/lib/supabase/read";
import { decGtZero, fmtMoney } from "@/lib/money";
import { PrintButton } from "./PrintButton";

// Quotations carry customer PII behind a shareable capability-URL. Never let a
// search engine index or cache them, even if a token leaks into a referrer/history.
export const metadata = {
  title: "Quotation — Singha Central",
  robots: { index: false, follow: false, nocache: true },
};

function money(v: number | string | null, currency: string): string {
  if (v == null) return "—";
  return fmtMoney(v, currency); // exact decimal, currency scale (≥2dp for LKR)
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
      {/*
        Document-scoped LIGHT theme + print rules — deliberately not the dark
        executive environment. This is the one surface a customer sees, and it is
        a document they will print, forward and file: a printable sheet on a warm
        paper ground, with an obsidian masthead and a champagne rule, so it reads
        as the same house style without carrying any internal management chrome.
        The lion mark keeps its own red, which is the only place red appears.
      */}
      <style>{`
        .qpage{background:#efece6;min-height:100vh;padding:32px 16px;color:#1a1815;
          font-family:"Segoe UI Variable Display","Segoe UI",-apple-system,Roboto,Helvetica,Arial,sans-serif}
        .qdoc{max-width:820px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;
          box-shadow:0 1px 0 rgba(0,0,0,.06),0 28px 64px -28px rgba(26,24,21,.45)}
        .qhead{display:flex;justify-content:space-between;align-items:flex-start;padding:28px 32px;
          background:linear-gradient(150deg,#17161b 0%,#0d0c11 60%,#141019 100%);color:#f3efe8;position:relative}
        .qhead::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;
          background:linear-gradient(90deg,rgba(217,180,119,0) 0%,#e3bf82 30%,#c99a56 70%,rgba(217,180,119,0) 100%)}
        .qhead img{height:44px}
        .qbrand{display:flex;align-items:center;gap:12px}
        .qbrand .nm{font-weight:600;font-size:1.3rem;letter-spacing:.16em}
        .qmeta{text-align:right;font-size:.85rem}
        .qmeta h2{margin:0 0 4px;font-size:1.3rem;font-weight:300;letter-spacing:.14em;color:#d9b477}
        .qbody{padding:28px 32px}
        .qparties{display:flex;gap:40px;flex-wrap:wrap;margin-bottom:24px}
        .qparties h4{margin:0 0 6px;font-size:.7rem;text-transform:uppercase;letter-spacing:.14em;
          font-weight:800;color:#8d8780}
        table.q{width:100%;border-collapse:collapse;font-size:.92rem;font-variant-numeric:tabular-nums}
        table.q th{text-align:left;background:#f6f3ed;color:#6e6862;padding:10px 12px;font-size:.7rem;
          text-transform:uppercase;letter-spacing:.12em;font-weight:800;border-bottom:1px solid #e3ded4}
        table.q td{padding:12px;border-bottom:1px solid #efece6}
        .num{text-align:right}
        .qtotal{display:flex;justify-content:flex-end;margin-top:20px}
        .qtotal .box{min-width:280px}
        .qtotal .r{display:flex;justify-content:space-between;padding:7px 0;font-variant-numeric:tabular-nums}
        .qtotal .grand{border-top:1px solid #c99a56;margin-top:8px;padding-top:12px;font-weight:600;
          font-size:1.25rem;letter-spacing:-.02em}
        .qnote{margin-top:24px;font-size:.82rem;color:#6e6862;line-height:1.55}
        .qactions{max-width:820px;margin:16px auto 0;display:flex;justify-content:flex-end}
        .qbtn{background:linear-gradient(135deg,#e3bf82,#c99a56);color:#17110a;border:none;border-radius:8px;
          min-height:44px;padding:0 22px;font-weight:700;cursor:pointer;font-size:.9rem}
        .qwait{background:#fbf3e6;border:1px solid #e0c48a;color:#7a5a1e;padding:12px 16px;border-radius:8px;
          margin-bottom:20px;font-size:.9rem;line-height:1.5}
        .pill{display:inline-block;font-size:.7rem;font-weight:800;padding:4px 10px;border-radius:6px;
          letter-spacing:.1em;text-transform:uppercase;background:rgba(217,180,119,.16);color:#e3bf82;
          border:1px solid rgba(217,180,119,.4)}
        @media (max-width:560px){
          .qpage{padding:16px 10px}
          .qhead{flex-direction:column;gap:14px;padding:20px}
          .qmeta{text-align:left}
          .qbody{padding:20px}
          .qparties{gap:20px}
          .qtotal .box{min-width:0;width:100%}
          table.q{font-size:.82rem}
          table.q th,table.q td{padding:8px}
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
                {decGtZero(quote.tax_amount) && (
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
