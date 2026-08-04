import { requireDepartment } from "@/lib/auth";
import { PriceRequests } from "@/components/PriceRequests";

export const metadata = { title: "Price Confirmations — Finance" };

export default async function FinancePriceRequests() {
  const p = await requireDepartment("finance");
  const department = p.isAdmin ? null : "finance";
  return (
    <div className="stack gap-3">
      <div>
        <h1>Price Confirmations</h1>
        <p className="muted mt-1">Items routed to finance for a confirmed price.</p>
      </div>
      <div className="card">
        <PriceRequests companyId={p.companyId} department={department} />
      </div>
    </div>
  );
}
