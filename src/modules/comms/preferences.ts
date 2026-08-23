/**
 * COM-007 — Communication preferences (pure helpers).
 *
 * Deterministic rules for whether an identity has opted out of automated
 * messaging and/or requested a human handover. The row shape mirrors the
 * communication_preferences table from migration 0104.
 */

export interface CommunicationPreference {
  company_id: string;
  channel: "whatsapp" | "email";
  identity: string;
  opt_out: boolean;
  handover_to: string | null;
  handover_at: string | null;
  handover_reason: string | null;
}

/** A channel identity has explicitly opted out of automated communication. */
export function isOptedOut(pref: CommunicationPreference | null | undefined): boolean {
  return pref?.opt_out === true;
}

/** A conversation is under human handover (staff member assigned, not expired). */
export function isHandedOver(pref: CommunicationPreference | null | undefined): boolean {
  return pref?.handover_to !== null && pref?.handover_to !== undefined;
}

/** Automated outbound sends are allowed only when not opted out. */
export function canSendAutomated(pref: CommunicationPreference | null | undefined): boolean {
  return !isOptedOut(pref);
}

/** Automated inbound handling is allowed only when there is no active handover. */
export function canHandleAutomatically(pref: CommunicationPreference | null | undefined): boolean {
  return !isHandedOver(pref);
}
