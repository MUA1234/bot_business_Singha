/**
 * Reusable Vehicles panel. Used by `/app/fleet/vehicles` and by the spatial workspace.
 * The caller must enforce permission (fleet department or admin).
 */
import { supabaseReadClient } from "@/lib/supabase/read";
import { VehiclesPanelContent, type VehicleRow } from "./VehiclesPanelContent";

export { VehiclesPanelContent as VehiclesContent };

type PlainObject = Record<string, unknown>;

export async function loadVehiclesData(companyId: string, _userId?: string): Promise<PlainObject> {
  let rows: VehicleRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("vehicles")
      .select("id, registration_no, make, model, year, status, odometer")
      .eq("company_id", companyId)
      .order("registration_no")
      .limit(300);
    rows = (data ?? []) as VehicleRow[];
  } catch {
    rows = [];
  }

  return { rows };
}

export default async function VehiclesPanel({
  companyId,
  userId,
  embedded,
}: {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}) {
  const data = await loadVehiclesData(companyId, userId);
  return <VehiclesPanelContent data={data} embedded={embedded ?? false} />;
}
