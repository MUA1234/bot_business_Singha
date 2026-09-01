/**
 * Parsing of Meta's inbound WhatsApp webhook payload.
 *
 * Lives outside the route handler because a Next.js route file may only export its HTTP
 * verbs — and because this is the boundary that decides WHICH COMPANY an event belongs to,
 * which deserves its own tests.
 *
 * `value.metadata.phone_number_id` identifies the business number that RECEIVED the message.
 * It used to be discarded, which is why the pipeline fell back to a hardcoded
 * `DEFAULT_COMPANY_ID` and could never have served a second company without writing its
 * traffic into the first company's records. It is now carried through so the company is
 * derived from the event rather than assumed.
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
