"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { calendarDays } from "@/modules/workforce/leave";

async function requireHR() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "hr") throw new Error("Not allowed");
  return p;
}

/** Confirm a profile belongs to the caller's company. */
async function profileInCompany(id: string, companyId: string) {
  const { data } = await supabaseWriteClient().from("profiles").select("id").eq("id", id).eq("company_id", companyId).maybeSingle();
  return data ?? null;
}

export async function updateEmployeeDetails(formData: FormData): Promise<void> {
  const hr = await requireHR();
  const id = String(formData.get("profile_id") ?? "");
  if (!(await profileInCompany(id, hr.companyId))) return;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const job_title = String(formData.get("job_title") ?? "").trim() || null;
  const start_date = String(formData.get("start_date") ?? "").trim() || null;
  const skills = String(formData.get("skills") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  await supabaseWriteClient().from("profiles").update({ phone, job_title, start_date, skills }).eq("id", id).eq("company_id", hr.companyId);
  await writeAudit({ companyId: hr.companyId, actorId: hr.userId, action: "employee.details_updated", entityType: "profile", entityId: id });
  revalidatePath(`/app/hr/staff/${id}`);
}

/** Submit a leave request — for yourself, or HR/admin on behalf of an employee. */
export async function requestLeave(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const profileId = String(formData.get("profile_id") ?? "") || p.userId;
  const isSelf = profileId === p.userId;
  if (!isSelf && !(p.isAdmin || p.department === "hr")) return;
  if (!(await profileInCompany(profileId, p.companyId))) return;

  const start = String(formData.get("start_date") ?? "").trim();
  const end = String(formData.get("end_date") ?? "").trim();
  if (!start || !end) return;
  const days = calendarDays(start, end);
  if (days <= 0) return;
  const reason = String(formData.get("reason") ?? "").trim() || null;

  await supabaseWriteClient().from("leave_requests").insert({
    company_id: p.companyId, profile_id: profileId, start_date: start, end_date: end, days, reason, status: "pending",
  });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "leave.requested", entityType: "leave_request", entityId: profileId, payload: { days } });
  revalidatePath(`/app/hr/staff/${profileId}`);
  revalidatePath("/app/me");
}

/** Approve or reject a leave request (HR/admin). */
export async function decideLeave(formData: FormData): Promise<void> {
  const hr = await requireHR();
  const id = String(formData.get("request_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || (decision !== "approved" && decision !== "rejected")) return;

  const { data: req } = await supabaseWriteClient().from("leave_requests").select("id, profile_id, status").eq("id", id).eq("company_id", hr.companyId).maybeSingle();
  if (!req || req.status !== "pending") return;

  await supabaseWriteClient().from("leave_requests").update({ status: decision, decided_by: hr.userId, decided_at: new Date().toISOString() }).eq("id", id).eq("company_id", hr.companyId);
  await writeAudit({ companyId: hr.companyId, actorId: hr.userId, action: `leave.${decision}`, entityType: "leave_request", entityId: id });
  await createNotification({ companyId: hr.companyId, recipientId: req.profile_id, type: "leave_decided", title: `Leave request ${decision}`, link: "/app/me" });
  revalidatePath(`/app/hr/staff/${req.profile_id}`);
}
