"use server";

import { revalidatePath } from "next/cache";
import { requireProfile, requireCapabilityStrict } from "@/lib/auth";
import { setOptOut, setHandover, clearHandover } from "@/lib/comms/preferences";
import { writeAudit } from "@/lib/audit";

function normalizeChannel(raw: string): "whatsapp" | "email" {
  if (raw === "email") return "email";
  return "whatsapp";
}

/** Staff may set or clear an opt-out for a channel identity (COM-007). */
export async function setIdentityOptOut(formData: FormData): Promise<void> {
  const p = await requireCapabilityStrict("customer.manage");
  const channel = normalizeChannel(String(formData.get("channel") ?? "whatsapp"));
  const identity = String(formData.get("identity") ?? "").trim();
  const optOut = String(formData.get("opt_out") ?? "") === "true";
  if (!identity) return;

  await setOptOut(p.companyId, channel, identity, optOut);
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: optOut ? "communication_preference.opt_out" : "communication_preference.opt_in",
    entityType: "communication_preference",
    payload: { channel, identity },
  });
  revalidatePath("/app/messages");
}

/** Staff may hand a conversation over to a specific person (COM-007). */
export async function handoverToHuman(formData: FormData): Promise<void> {
  const p = await requireCapabilityStrict("customer.manage");
  const channel = normalizeChannel(String(formData.get("channel") ?? "whatsapp"));
  const identity = String(formData.get("identity") ?? "").trim();
  const handoverTo = String(formData.get("handover_to") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;
  if (!identity || !handoverTo) return;

  await setHandover(p.companyId, channel, identity, handoverTo, reason ?? undefined);
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "communication_preference.handover",
    entityType: "communication_preference",
    payload: { channel, identity, handover_to: handoverTo, reason },
  });
  revalidatePath("/app/messages");
}

/** Staff may clear a human handover (COM-007). */
export async function clearHumanHandover(formData: FormData): Promise<void> {
  const p = await requireCapabilityStrict("customer.manage");
  const channel = normalizeChannel(String(formData.get("channel") ?? "whatsapp"));
  const identity = String(formData.get("identity") ?? "").trim();
  if (!identity) return;

  await clearHandover(p.companyId, channel, identity);
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "communication_preference.handover_cleared",
    entityType: "communication_preference",
    payload: { channel, identity },
  });
  revalidatePath("/app/messages");
}
