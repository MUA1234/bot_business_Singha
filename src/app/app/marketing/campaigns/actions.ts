"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireMarketing() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "marketing") throw new Error("Not allowed");
  return p;
}

const NEXT: Record<string, string[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["running", "cancelled"],
  running: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export async function createCampaign(formData: FormData): Promise<void> {
  const p = await requireMarketing();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const channel = String(formData.get("channel") ?? "whatsapp");
  const budget = Number(formData.get("budget") ?? 0) || null;
  const audience_id = String(formData.get("audience_id") ?? "").trim() || null;
  const { error } = await supabaseWriteClient().from("campaigns").insert({
    company_id: p.companyId, name, channel: ["whatsapp", "email", "other"].includes(channel) ? channel : "whatsapp",
    budget, audience_id, status: "draft", created_by: p.userId,
  });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "campaign.created", entityType: "campaign", entityId: name, payload: { channel } });
  revalidatePath("/app/marketing/campaigns");
}

export async function setCampaignStatus(formData: FormData): Promise<void> {
  const p = await requireMarketing();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id) return;
  const { data: c } = await supabaseWriteClient().from("campaigns").select("status").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!c || !(NEXT[c.status] ?? []).includes(status)) return; // enforce legal transition
  await supabaseWriteClient().from("campaigns").update({ status }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `campaign.${status}`, entityType: "campaign", entityId: id });
  revalidatePath("/app/marketing/campaigns");
}
