"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";

export async function markRead(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // Scope to the caller's own notifications.
  await supabaseWriteClient().from("notifications").update({ is_read: true }).eq("id", id).eq("company_id", p.companyId).eq("recipient_id", p.userId);
  revalidatePath("/app/notifications");
}

export async function markAllRead(): Promise<void> {
  const p = await requireProfile();
  await supabaseWriteClient().from("notifications").update({ is_read: true }).eq("company_id", p.companyId).eq("recipient_id", p.userId).eq("is_read", false);
  revalidatePath("/app/notifications");
}
