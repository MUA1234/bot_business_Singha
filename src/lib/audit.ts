/**
 * Append-only audit trail for privileged operations (Architecture V2 change plan
 * §5.4; Constitution §12 "sensitive operations must generate append-only audit
 * events"). Writes to the `audit_events` table (migration 0004), which has a DB
 * trigger blocking UPDATE/DELETE.
 *
 * NEVER put secrets in `payload` (passwords, tokens, full PII). Record what changed
 * and on whom, not the sensitive value itself.
 *
 * WP2 §9: Supabase `.insert()` returns `{ error }` WITHOUT throwing, so a naive
 * try/catch silently drops audit failures. We now inspect the returned error:
 *  - `writeAudit`       — best-effort, but the failure is surfaced (return + log),
 *                         for low-risk actions where the op should still proceed.
 *  - `writeAuditStrict` — FAIL-CLOSED: throws on any audit failure, for sensitive
 *                         mutations that must not be recorded silently.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { log } from "@/lib/log";

export interface AuditEntry {
  companyId: string | null;
  /** NULL for actor_type 'system' — the convention migration 0049 established. */
  actorId: string | null;
  actorType?: "user" | "system" | "ai";
  action: string; // e.g. "employee.deactivated", "employee.password_reset"
  entityType: string; // e.g. "profile", "product_catalog"
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

/** Insert one audit row, returning any DB error. Injectable for testing. */
export type AuditInserter = (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;

const defaultInserter: AuditInserter = async (row) => {
  const { error } = await supabaseAdmin().from("audit_events").insert(row);
  return { error: error ? { message: error.message } : null };
};

function toRow(entry: AuditEntry): Record<string, unknown> {
  return {
    company_id: entry.companyId,
    actor_type: entry.actorType ?? "user",
    actor_id: entry.actorId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    payload: entry.payload ?? null,
  };
}

/**
 * Record a privileged action (best-effort). Unlike before, an insert error is no
 * longer swallowed silently: it is logged and returned so the gap is visible. Use
 * `writeAuditStrict` for sensitive mutations that must fail closed.
 */
export async function writeAudit(
  entry: AuditEntry,
  insert: AuditInserter = defaultInserter,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await insert(toRow(entry));
    if (error) {
      log("error", "audit write failed", { event: "audit.write_failed", action: entry.action, error: error.message });
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    log("error", "audit write threw", { event: "audit.write_threw", action: entry.action, error: msg });
    return { ok: false, error: msg };
  }
}

/**
 * Fail-closed audit write for sensitive actions: throws AuditError if the event could
 * not be recorded. Callers on sensitive paths should let this propagate so the
 * surrounding mutation is not treated as done when it was never audited.
 */
export async function writeAuditStrict(entry: AuditEntry, insert: AuditInserter = defaultInserter): Promise<void> {
  const res = await writeAudit(entry, insert);
  if (!res.ok) throw new AuditError(`audit write failed for "${entry.action}": ${res.error ?? "unknown error"}`);
}
