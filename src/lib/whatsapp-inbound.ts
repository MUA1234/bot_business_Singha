/**
 * Parsing of Meta's inbound WhatsApp webhook payload — LEGACY, off the production path.
 *
 * SUPERSEDED (Release 1). The live webhook parses through `src/lib/inbound/adapters/whatsapp.ts`
 * and resolves the company through `channel_accounts` + `resolve_channel_company`, which is the
 * canonical design (owner decision 3). This module is retained ONLY because its pure parser and
 * its regression tests still pin behaviour the canonical adapter must also honour: the receiving
 * number is read per change, a missing metadata block yields null rather than a guess, and a
 * malformed event never throws. No route, job or service imports it.
 *
 * `value.metadata.phone_number_id` identifies the business number that RECEIVED the message. It
 * used to be discarded, and the pipeline then fell back to a single compiled-in company id — it
 * could never have served a second company without writing that company's traffic into the
 * first one's records. That constant no longer exists anywhere in the codebase; the company is
 * derived from the event.
 *
 * Do not add callers. If something here is needed, move it into the canonical adapter.
 */

export interface InboundText {
  id: string;
  from: string;
  text: string;
  /** Meta business number that received this message — the company routing key (0069). */
  phoneNumberId: string | null;
  /** WhatsApp Business Account id (`entry.id`) — retained as evidence on the source event. */
  wabaId: string | null;
}

interface RawWebhook {
  entry?: {
    id?: string;
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: { id?: string; from?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
}

/** Pull inbound text messages, each tagged with the number and account that received it. */
export function extractTextMessages(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  const p = (payload ?? {}) as RawWebhook;
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id ?? null;
      for (const message of change.value?.messages ?? []) {
        if (message.id && message.from && message.type === "text" && message.text?.body) {
          out.push({
            id: message.id,
            from: message.from,
            text: message.text.body,
            phoneNumberId,
            wabaId: entry.id ?? null,
          });
        }
      }
    }
  }
  return out;
}
