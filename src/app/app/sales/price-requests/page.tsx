import { requireDepartment } from "@/lib/auth";
import { PriceRequests } from "@/components/PriceRequests";

export const metadata = { title: "Price Confirmations — Singha Central" };

export default async function SalesPriceRequests() {
  const p = await requireDepartment("sales");
  // Admin sees every routed department; a sales member sees the sales queue.
  const department = p.isAdmin ? null : "sales";
  return (
    <div className="stack gap-3">
      <div>
        <h1>Price Confirmations</h1>
        <p className="muted mt-1">
          The AI held these items because it had no catalog price. Confirm the unit price and the
          quotation is finalised and sent to the customer automatically.
        </p>
      </div>
      <div className="card">
        <PriceRequests companyId={p.companyId} department={department} />
      </div>
    </div>
  );
}
