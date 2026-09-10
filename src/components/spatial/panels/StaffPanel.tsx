/**
 * Reusable Staff panel. Used by `/app/hr/staff` and the spatial workspace.
 * The caller must enforce permission (HR department or admin).
 */
import { supabaseReadClient } from "@/lib/supabase/read";
import { StaffPanelContent } from "./StaffPanelContent";
import type { PlainObject, StaffRow } from "./StaffPanelContent";

export { StaffPanelContent } from "./StaffPanelContent";

export async function loadStaffData(companyId: string, _userId?: string): Promise<PlainObject> {
  let rows: StaffRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("profiles")
      .select("id, username, full_name, department, job_title, skills, is_active")
      .eq("company_id", companyId)
      .order("full_name", { nullsFirst: false })
      .limit(500);
    rows = (data as StaffRow[] | null) ?? [];
  } catch {
    rows = [];
  }

  return { rows } as PlainObject;
}

interface StaffPanelProps {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}

export default async function StaffPanel({ companyId, userId, embedded }: StaffPanelProps) {
  const data = await loadStaffData(companyId, userId);
  return <StaffPanelContent data={data} embedded={embedded ?? false} />;
}
