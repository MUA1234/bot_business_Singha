"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { computeCapacity } from "@/modules/work/capacity";

const CONTRACTED_HOURS = 40;
const TERMINAL = ["completed", "cancelled"];

function mondayOf(d: Date): string {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

/**
 * Recompute this week's capacity snapshot for every employee from their assigned,
 * estimated, non-terminal tasks. Snapshots feed the Command Centre exceptions.
 */
export async function recomputeCapacity(): Promise<void> {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "hr") return;
  const db = supabaseAdmin();
  const weekStart = mondayOf(new Date());

  const [{ data: tasks }, { data: memberships }] = await Promise.all([
    db.from("tasks").select("assigned_to, estimate_hours, status").eq("company_id", p.companyId).not("assigned_to", "is", null),
    db.from("memberships").select("id, user_id").eq("company_id", p.companyId),
  ]);
  const membershipByUser = new Map<string, string>((memberships ?? []).map((m: any) => [m.user_id, m.id]));

  const allocByUser = new Map<string, number>();
  for (const t of tasks ?? []) {
    if (TERMINAL.includes((t as any).status)) continue;
    const uid = (t as any).assigned_to as string;
    allocByUser.set(uid, (allocByUser.get(uid) ?? 0) + Number((t as any).estimate_hours ?? 0));
  }

  for (const [uid, allocated] of allocByUser) {
    const membershipId = membershipByUser.get(uid);
    if (!membershipId) continue; // no membership backfilled — skip
    const cap = computeCapacity({ contractedHours: CONTRACTED_HOURS, leaveHours: 0, meetingHours: 0, recurringHours: 0, taskEstimateHours: allocated, contingencyPct: 0.1 });
    await db.from("capacity_snapshots").upsert({
      company_id: p.companyId, membership_id: membershipId, week_start: weekStart,
      total_hours: cap.totalHours, net_capacity_hours: cap.netCapacityHours,
      allocated_hours: cap.allocatedHours, available_hours: cap.availableHours,
      utilization_pct: Number.isFinite(cap.utilizationPct) ? cap.utilizationPct : 999, status: cap.status,
    }, { onConflict: "membership_id,week_start" });
  }

  revalidatePath("/app/hr/capacity");
  revalidatePath("/app/command");
}
