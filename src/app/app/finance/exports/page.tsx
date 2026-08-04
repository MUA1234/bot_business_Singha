import { requireDepartment } from "@/lib/auth";
import { Icon } from "@/components/Icon";

export const metadata = { title: "Excel Exports — Singha" };

const EXPORTS = [
  { kind: "quotations", label: "Quotations", desc: "All quotations with totals and status." },
  { kind: "orders", label: "Orders", desc: "Captured customer orders and contact details." },
  { kind: "price-confirmations", label: "Price confirmations", desc: "Every price decision, for audit." },
  { kind: "catalog", label: "Product catalog", desc: "Products and their unit prices." },
];

export default async function ExportsPage() {
  await requireDepartment("finance");
  return (
    <div className="stack gap-3">
      <div>
        <h1>Excel Exports</h1>
        <p className="muted mt-1">
          Download logs as Excel-compatible CSV (opens directly in Excel / Google Sheets). This is
          our own accounting log — no paid service.
        </p>
      </div>
      <div className="grid cols-2">
        {EXPORTS.map((e) => (
          <div key={e.kind} className="card row between">
            <div>
              <div className="card-title">{e.label}</div>
              <p className="card-sub mt-1">{e.desc}</p>
            </div>
            <a className="btn sm" href={`/api/exports/${e.kind}`}><Icon name="download" size={15} /> Export</a>
          </div>
        ))}
      </div>
    </div>
  );
}
