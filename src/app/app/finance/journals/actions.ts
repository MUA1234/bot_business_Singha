"use server";

import { redirect } from "next/navigation";
import { log, newCorrelationId } from "@/lib/log";
import { revalidatePath } from "next/cache";
import { requireCapabilityStrict, type SessionProfile } from "@/lib/auth";
import { supabaseRpcClient } from "@/lib/supabase/read";
import { checkDraftJournal, type DraftLine } from "@/accounting/manual-entry";
import { resolveIdempotencyKey } from "@/lib/idempotency";

export interface JournalState {
  error?: string;
}

/** Post a balanced manual journal atomically via the DB RPC (§8.2). */
export async function postJournal(_prev: JournalState, formData: FormData): Promise<JournalState> {
  // §WP2 STRICT: posting a manual journal requires finance.journal.post (no dept fallback).
  let p: SessionProfile;
  try { p = await requireCapabilityStrict("finance.journal.post"); }
  catch { return { error: "You do not have journal-posting authority." }; }

  const date = String(formData.get("date") ?? "").trim() || new Date().toISOString().slice(0, 10);
  const currency = (String(formData.get("currency") ?? "LKR").trim() || "LKR").toUpperCase().slice(0, 3);
  const memo = String(formData.get("memo") ?? "").trim() || null;

  let lines: DraftLine[];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    return { error: "Could not read the journal lines." };
  }

  // Deterministic pre-check (the RPC re-validates authoritatively).
  const check = checkDraftJournal(lines, currency);
  if (!check.ready) return { error: check.issues[0] ?? "Journal is not valid." };

  const payload = lines
    // Exact string-decimal positivity test (a non-negative decimal is > 0 iff it has a non-zero
    // digit) — journal-line filtering must never float the amounts it decides on.
    .filter((l) => l.account_code.trim() !== "" && (/[1-9]/.test(String(l.debit ?? "")) || /[1-9]/.test(String(l.credit ?? ""))))
    .map((l) => ({ account_code: l.account_code.trim(), debit: String(l.debit || "0"), credit: String(l.credit || "0"), description: l.description ?? null }));

  // §WP-B: manual journals carry a deterministic caller idempotency key; audit is in-RPC.
  const idemKey = resolveIdempotencyKey(String(formData.get("idem_token") ?? ""), [
    "post_manual_journal", date, currency, memo ?? "", JSON.stringify(payload),
  ]);
  const { error } = await supabaseRpcClient().rpc("post_manual_journal", {
    p_company: p.companyId,
    p_date: date,
    p_currency: currency,
    p_memo: memo,
    p_posted_by: p.userId,
    p_lines: payload,
    p_idempotency_key: idemKey,
  });
  if (error) return { error: error.message };

  revalidatePath("/app/finance/journals");
  redirect("/app/finance/journals");
}

/** Reverse a posted journal (§8.1). Posts a mirror entry and marks the original
 *  reversed — corrections never edit a posted journal. Atomic via reverse_journal RPC. */
export async function reverseJournal(formData: FormData): Promise<void> {
  const id = String(formData.get("journal_id") ?? "");
  if (!id) return;
  // §WP2 STRICT: reversing a journal requires finance.journal.reverse.
  let p: SessionProfile;
  try { p = await requireCapabilityStrict("finance.journal.reverse"); }
  catch { return; }

  const { error } = await supabaseRpcClient().rpc("reverse_journal", {
    p_company: p.companyId, p_journal: id, p_by: p.userId, p_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: `reverse:${id}`,
  });
  if (error) { log("error", "finance action failed", { event: "finance.action_failed", correlationId: newCorrelationId(), companyId: p.companyId, error: error.message }); return; }
  revalidatePath("/app/finance/journals");
  revalidatePath(`/app/finance/journals/${id}`);
}
