/**
 * The ONE inbound dispatch orchestration, used by BOTH the synchronous webhook and the durable
 * worker (FOUND-003 / migration 0076).
 *
 * It exists as a shared function rather than as two similar loops because the two paths previously
 * diverged and the async one silently skipped identity routing entirely. "Async ON and OFF produce
 * identical business outcomes" is only credible if there is literally one implementation.
 *
 * ORDER, and why:
 *   1. the receipt already exists (persist-first) — nothing here creates it;
 *   2. CLAIM the dispatch lease. Two concurrent deliveries of the same message both find the same
 *      receipt, and only one can take the lease, so at most one business dispatch happens;
 *   3. resolve the company from the receiving account. An unresolved company is a RETRYABLE
 *      failure, not a dead end: once an owner maps the number, the retry succeeds by itself;
 *   4. dispatch, which creates the durable downstream effect;
 *   5. record the outcome. The marker is written AFTER the effect, so a crash can never leave a
 *      marker without one. The opposite — an effect with no marker — is recovered by the retry,
 *      because every downstream is independently idempotent.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchInbound, type DispatchDeps, type InboundMessage } from "@/lib/inbound/dispatch";
import { isUsableCompany, resolveReceivingCompany } from "@/lib/inbound/company-resolution";
import { companyKnownCurrencies, resolveCompanyForAccount } from "@/lib/inbound/production-deps";
import {
  claimInboundDispatch,
  dispatchStateOf,
  failInboundDispatch,
  recordInboundDispatch,
  type DispatchOutcome,
  type InboundReceipt,
} from "@/lib/inbound/receipt";
import { log } from "@/lib/log";

/** What happened, for the webhook response and for logs. Never shown to a message sender. */
export type DispatchReceiptResult =
  | DispatchOutcome
  | "no_provider_message_id"
  | "already_dispatched"
  /** Undecided and waiting — a live lease elsewhere, or a backoff after a failed attempt. */
  | "retry_pending"
  | "unattributed"
  | "error";

/**
 * The lifecycle calls, injectable so the ORDER of operations can be tested without a database —
 * the property that matters here is a sequence (claim before deciding, effect before marker), and
 * a test that only reads the source text cannot establish a sequence.
 */
export interface DispatchReceiptPorts {
  claim(db: SupabaseClient, eventId: string, owner: string, leaseSeconds: number): Promise<boolean>;
  state(db: SupabaseClient, eventId: string): Promise<string | null>;
  record(db: SupabaseClient, input: Parameters<typeof recordInboundDispatch>[1]): Promise<unknown>;
  fail(db: SupabaseClient, eventId: string, owner: string, code: string, message: string): Promise<string>;
  resolveCompany(channel: string, account: string): Promise<{ companyId: string | null; match: string }>;
  knownCurrencies(companyId: string): Promise<string[]>;
  dispatch: typeof dispatchInbound;
}

const DEFAULT_PORTS: DispatchReceiptPorts = {
  claim: claimInboundDispatch,
  state: dispatchStateOf,
  record: recordInboundDispatch,
  fail: failInboundDispatch,
  resolveCompany: resolveCompanyForAccount,
  knownCurrencies: companyKnownCurrencies,
  dispatch: dispatchInbound,
};

export async function dispatchReceipt(
  db: SupabaseClient,
  receipt: InboundReceipt,
  message: Omit<InboundMessage, "companyId" | "receipt">,
  providerAccountId: string | null,
  makeDeps: (dispatchOwner: string, knownCurrencies: string[]) => DispatchDeps,
  opts?: { owner?: string; leaseSeconds?: number; ports?: Partial<DispatchReceiptPorts> },
): Promise<DispatchReceiptResult> {
  const ports: DispatchReceiptPorts = { ...DEFAULT_PORTS, ...(opts?.ports ?? {}) };
  // The provider gave no message id, so this receipt has no canonical identity and was never
  // merged with anything. It is already parked for a person; deciding it automatically would mean
  // guessing which message it is.
  if (receipt.dispatchState === "manual_review" && receipt.identity === null) {
    return "no_provider_message_id";
  }

  const owner = opts?.owner ?? `wa_dispatch_${randomUUID()}`;
  const claimed = await ports.claim(db, receipt.event.id, owner, opts?.leaseSeconds ?? 120);
  if (!claimed) {
    // WHY the claim was refused decides what the caller should do. A settled receipt is finished; a
    // receipt that is failed or being decided elsewhere is still OUTSTANDING, and reporting that as
    // "already dispatched" told the provider to stop redelivering something nobody had handled.
    const state = await ports.state(db, receipt.event.id);
    return state === "failed" || state === "dispatching" ? "retry_pending" : "already_dispatched";
  }

  const company = await resolveReceivingCompany(
    { resolveCompany: ports.resolveCompany as never },
    message.channel,
    providerAccountId,
  );
  if (!isUsableCompany(company)) {
    // RETRYABLE on purpose: the fix is an owner mapping the receiving number, and the retry then
    // succeeds without anyone replaying the message. Attempts are bounded, and exhaustion parks it
    // for a person rather than dropping it.
    await ports.fail(db, receipt.event.id, owner, "company_unresolved", `receiving account ${providerAccountId ?? "(none)"} is not mapped to a company (${company.match})`);
    return "unattributed";
  }

  try {
    // Per COMPANY, never a global constant: the finance gate must not assume one currency for every
    // business on the platform.
    const currencies = await ports.knownCurrencies(company.companyId);
    const res = await ports.dispatch(
      { ...message, companyId: company.companyId, receipt: receipt.event },
      makeDeps(owner, currencies),
    );
    await ports.record(db, {
      eventId: receipt.event.id,
      owner,
      outcome: res.handled,
      companyId: company.companyId,
    });
    return res.handled;
  } catch (e) {
    log("error", "inbound dispatch failed", {
      event: "wa.handle_failed",
      sourceEventId: receipt.event.id,
      error: (e as Error).message,
    });
    await ports.fail(db, receipt.event.id, owner, "dispatch_error", (e as Error).message);
    return "error";
  }
}
