/**
 * Append-only audit trail for privileged operations (Architecture V2 change plan
 * §5.4; Constitution §12 "sensitive operations must generate append-only audit
 * events"). Writes to the `audit_events` table (migration 0004), which has a DB
 * trigger blocking UPDATE/DELETE.
 *
 * NEVER put secrets in `payload` (passwords, tokens, full PII). Record what changed
 * and on whom, not the sensitive value itself.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

export interface AuditEntry {
  companyId: string | null;
  actorId: string;
  actorType?: "user" | "system" | "ai";
  action: string; // e.g. "employee.deactivated", "employee.password_reset"
  entityType: string; // e.g. "profile", "product_catalog"
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

/** Record a privileged action. Best-effort: an audit failure must not crash the op,
 *  but it is logged so the gap is visible. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await supabaseAdmin().from("audit_events").insert({
      company_id: entry.companyId,
      actor_type: entry.actorType ?? "user",
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      payload: entry.payload ?? null,
    });
  } catch (e) {
    console.error("[audit] failed to write audit event:", (e as Error).message);
  }
}
