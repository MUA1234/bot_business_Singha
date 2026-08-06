"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { checkDraftJournal, type DraftLine } from "@/accounting/manual-entry";

export interface JournalState {
  error?: string;
}

/** Post a balanced manual journal atomically via the DB RPC (§8.2). */
export async function postJournal(_prev: JournalState, formData: FormData): Promise<JournalState> {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") return { error: "Only finance may post journals." };

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
    .filter((l) => l.account_code.trim() !== "" && (Number(l.debit || 0) > 0 || Number(l.credit || 0) > 0))
    .map((l) => ({ account_code: l.account_code.trim(), debit: String(l.debit || "0"), credit: String(l.credit || "0"), description: l.description ?? null }));

  const { data, error } = await supabaseWriteClient().rpc("post_manual_journal", {
    p_company: p.companyId,
    p_date: date,
    p_currency: currency,
    p_memo: memo,
    p_posted_by: p.userId,
    p_lines: payload,
  });
  if (error) return { error: error.message };

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "journal.posted",
    entityType: "journal_entry",
    entityId: typeof data === "string" ? data : null,
    payload: { total: check.totalDebit, currency },
  });
  revalidatePath("/app/finance/journals");
  redirect("/app/finance/journals");
}

/** Reverse a posted journal (§8.1). Posts a mirror entry and marks the original
 *  reversed — corrections never edit a posted journal. Atomic via reverse_journal RPC. */
export async function reverseJournal(formData: FormData): Promise<void> {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") return;
  const id = String(formData.get("journal_id") ?? "");
  if (!id) return;

  const { data: revId, error } = await supabaseWriteClient().rpc("reverse_journal", {
    p_company: p.companyId, p_journal: id, p_by: p.userId, p_date: new Date().toISOString().slice(0, 10),
  });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "journal.reversed", entityType: "journal_entry", entityId: id, payload: { reversalId: typeof revId === "string" ? revId : null } });
  revalidatePath("/app/finance/journals");
  revalidatePath(`/app/finance/journals/${id}`);
}
