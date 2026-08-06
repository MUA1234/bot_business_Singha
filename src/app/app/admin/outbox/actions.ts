"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { replayReset } from "@/events/outbox-delivery";

/**
 * Admin replay of a failed/dead outbound message (§WP4.5). Resets it to `pending` so
 * the sender worker will attempt delivery again. Company-scoped + audited. Uses the
 * pure `replayReset` guard so only failed/dead rows can be replayed.
 */
export async function replayMessage(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const db = supabaseAdmin();

  const { data: row } = await db
    .from("message_outbox")
    .select("id, status")
    .eq("id", id)
    .eq("company_id", admin.companyId)
    .maybeSingle();
  if (!row) return;

  const reset = replayReset({ status: row.status as any });
  if (!reset) return; // only failed/dead may be replayed

  // message_outbox has no next_retry_at column; map the applicable reset fields.
  await db
    .from("message_outbox")
    .update({ status: reset.status, attempts: reset.attempts, last_error: reset.last_error })
    .eq("id", id)
    .eq("company_id", admin.companyId);
  await writeAudit({
    companyId: admin.companyId,
    actorId: admin.userId,
    action: "outbox.replayed",
    entityType: "message_outbox",
    entityId: id,
    payload: { from: row.status },
  });
  revalidatePath("/app/admin/outbox");
}
