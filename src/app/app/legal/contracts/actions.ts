"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireLegal() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "legal") throw new Error("Not allowed");
  return p;
}

export async function createContract(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const counterparty = String(formData.get("counterparty") ?? "").trim() || null;
  const start_date = String(formData.get("start_date") ?? "").trim() || null;
  const end_date = String(formData.get("end_date") ?? "").trim() || null;
  const renewal_date = String(formData.get("renewal_date") ?? "").trim() || null;

  const { data, error } = await supabaseWriteClient()
    .from("contracts")
    .insert({ company_id: p.companyId, title, counterparty, start_date, end_date, renewal_date, status: "active" })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "contract.created", entityType: "contract", entityId: data?.id ?? null, payload: { title } });
  revalidatePath("/app/legal/contracts");
  revalidatePath("/app/legal");
}

/** Confirm a contract belongs to the caller's company. */
async function contractInCompany(id: string, companyId: string) {
  const { data } = await supabaseWriteClient().from("contracts").select("id").eq("id", id).eq("company_id", companyId).maybeSingle();
  return data ?? null;
}

export async function addObligation(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const contractId = String(formData.get("contract_id") ?? "");
  if (!(await contractInCompany(contractId, p.companyId))) return;
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const due_date = String(formData.get("due_date") ?? "").trim() || null;
  await supabaseWriteClient().from("obligations").insert({ company_id: p.companyId, contract_id: contractId, description, due_date, status: "open" });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "obligation.created", entityType: "obligation", entityId: contractId });
  revalidatePath(`/app/legal/contracts/${contractId}`);
  revalidatePath("/app/legal");
}

export async function setObligationStatus(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const contractId = String(formData.get("contract_id") ?? "");
  if (!id || !["open", "done", "waived"].includes(status)) return;
  const { data: o } = await supabaseWriteClient().from("obligations").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!o) return;
  await supabaseWriteClient().from("obligations").update({ status }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `obligation.${status}`, entityType: "obligation", entityId: id });
  revalidatePath(`/app/legal/contracts/${contractId}`);
  revalidatePath("/app/legal");
}
