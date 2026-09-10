/**
 * Reusable Purchase Orders panel. Used by `/app/procurement/purchase-orders` and by the
 * spatial workspace. The caller must enforce permission (procurement department or admin).
 */
import { supabaseReadClient } from "@/lib/supabase/read";
import { PurchaseOrdersPanelContent } from "./PurchaseOrdersPanelContent";

export { PurchaseOrdersPanelContent as PurchaseOrdersContent };

export type PlainObject = Record<string, unknown>;

export async function loadPurchaseOrdersData(
  companyId: string,
  _userId?: string,
): Promise<PlainObject> {
  const db = supabaseReadClient();

  let rows: {
    id: string;
    po_number: string;
    total_amount: string;
    currency: string;
    status: string;
    expected_payment_date: string | null;
    created_at: string;
  }[] = [];
  try {
    const { data } = await db
      .from("purchase_orders")
      .select("id, po_number, total_amount, currency, status, expected_payment_date, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    rows = (data ?? []) as typeof rows;
  } catch {
    rows = [];
  }

  let suppliers: { id: string; name: string }[] = [];
  try {
    const { data } = await db
      .from("suppliers")
      .select("id, name")
      .eq("company_id", companyId)
      .order("name", { ascending: true })
      .limit(500);
    suppliers = (data ?? []) as { id: string; name: string }[];
  } catch {
    suppliers = [];
  }

  return { rows, suppliers } as PlainObject;
}

interface PurchaseOrdersPanelProps {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}

export default async function PurchaseOrdersPanel({
  companyId,
  userId,
  embedded,
}: PurchaseOrdersPanelProps) {
  const data = await loadPurchaseOrdersData(companyId, userId);
  return <PurchaseOrdersPanelContent data={data} embedded={embedded ?? false} />;
}
