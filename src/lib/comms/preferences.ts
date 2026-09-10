/**
 * COM-007 — Communication preferences service.
 *
 * Loads and mutates company-scoped communication preferences. The outbound enqueue
 * path and the inbound dispatch path both use this to respect opt-out and handover.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { CommunicationPreference } from "@/modules/comms/preferences";

function normalizeIdentity(channel: string, identity: string): string {
  if (channel === "whatsapp") {
    return identity.replace(/[^\d]/g, "");
  }
  return identity.trim().toLowerCase();
}

export async function getCommunicationPreference(
  companyId: string,
  channel: "whatsapp" | "email",
  identity: string,
): Promise<CommunicationPreference | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("communication_preferences")
    .select("company_id, channel, identity, opt_out, handover_to, handover_at, handover_reason")
    .eq("company_id", companyId)
    .eq("channel", channel)
    .eq("identity", normalizeIdentity(channel, identity))
    .maybeSingle();
  return (data as CommunicationPreference | null) ?? null;
}

export async function setOptOut(
  companyId: string,
  channel: "whatsapp" | "email",
  identity: string,
  optOut: boolean,
): Promise<void> {
  const db = supabaseAdmin();
  const normalized = normalizeIdentity(channel, identity);
  const { error } = await db.from("communication_preferences").upsert(
    {
      company_id: companyId,
      channel,
      identity: normalized,
      opt_out: optOut,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id,channel,identity" },
  );
  if (error) throw new Error(`setOptOut failed: ${error.message}`);
}

export async function setHandover(
  companyId: string,
  channel: "whatsapp" | "email",
  identity: string,
  handoverTo: string,
  reason?: string,
): Promise<void> {
  const db = supabaseAdmin();
  const normalized = normalizeIdentity(channel, identity);
  const { error } = await db.from("communication_preferences").upsert(
    {
      company_id: companyId,
      channel,
      identity: normalized,
      handover_to: handoverTo,
      handover_at: new Date().toISOString(),
      handover_reason: reason ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id,channel,identity" },
  );
  if (error) throw new Error(`setHandover failed: ${error.message}`);
}

export async function clearHandover(
  companyId: string,
  channel: "whatsapp" | "email",
  identity: string,
): Promise<void> {
  const db = supabaseAdmin();
  const normalized = normalizeIdentity(channel, identity);
  const { error } = await db
    .from("communication_preferences")
    .update({ handover_to: null, handover_at: null, handover_reason: null, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("channel", channel)
    .eq("identity", normalized);
  if (error) throw new Error(`clearHandover failed: ${error.message}`);
}
