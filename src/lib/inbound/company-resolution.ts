/**
 * Which company received this message? (FOUND-003)
 *
 * The webhook used to stamp every inbound message with a hardcoded pilot company constant. In a
 * multi-company system that is a cross-company leak waiting for the second company. The trustworthy
 * routing key is the ACCOUNT THAT RECEIVED the message — for WhatsApp Cloud API,
 * `entry[].changes[].value.metadata.phone_number_id`, which Meta sets and a sender cannot influence.
 *
 * Resolution lives in the database (`resolve_channel_company`, migration 0074) so the mapping is
 * auditable configuration rather than deployment-time code. This module is the typed boundary and
 * the FAIL-CLOSED rule: anything other than a definite company means the message is not dispatched.
 */
import { log } from "@/lib/log";

/** How the company was determined. `exact` and `single_tenant_fallback` are the only usable ones. */
export type CompanyMatch = "exact" | "single_tenant_fallback" | "unmapped" | "ambiguous" | "empty" | "lookup_error";

export interface ResolvedCompany {
  companyId: string | null;
  match: CompanyMatch;
}

export interface CompanyResolverDeps {
  /** `resolve_channel_company(p_channel, p_provider_account_id)`. */
  resolveCompany(channel: string, providerAccountId: string): Promise<ResolvedCompany>;
}

/** Only a definite company may carry a message into business processing. */
export function isUsableCompany(r: ResolvedCompany): r is ResolvedCompany & { companyId: string } {
  return r.companyId !== null && (r.match === "exact" || r.match === "single_tenant_fallback");
}

export async function resolveReceivingCompany(
  deps: CompanyResolverDeps,
  channel: string,
  providerAccountId: string | null | undefined,
): Promise<ResolvedCompany> {
  if (!providerAccountId || !providerAccountId.trim()) {
    // The provider did not tell us which of our accounts received this. Guessing would mean
    // attributing someone's message to whichever company happens to be first.
    return { companyId: null, match: "empty" };
  }
  const resolved = await deps.resolveCompany(channel, providerAccountId.trim());

  if (!isUsableCompany(resolved)) {
    log("error", "inbound message could not be attributed to a company", {
      event: "inbound.company_unresolved",
      channel,
      providerAccountId,
      match: resolved.match,
    });
  } else if (resolved.match === "single_tenant_fallback") {
    // Working, but on the documented bridge rather than on configuration. Say so on every message
    // so it cannot quietly become the permanent arrangement.
    log("warn", "receiving company resolved by the single-tenant fallback, not by configuration", {
      event: "inbound.company_fallback",
      channel,
      providerAccountId,
      companyId: resolved.companyId,
    });
  }
  return resolved;
}
