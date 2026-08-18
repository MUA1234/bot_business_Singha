/**
 * The canonical inbound message contract (remediation R1 §6, OF-006).
 *
 * Every channel adapter produces THIS shape, and nothing downstream reads a provider's own payload
 * format. WhatsApp is the first and currently the only adapter with a real runtime entrypoint;
 * email, voice/transcription and calendar are separate requirements and are `foundation_only` until
 * each has its own entrypoint and tests. A schema is not an integration.
 *
 * Every field exists because something downstream needs it and previously had to reach into a
 * provider-shaped object to get it:
 *
 *   provider / channel          — which system this came from, and which kind of conversation
 *   providerAccountId           — OUR account that received it. Decides the company (migration 0074)
 *                                 and scopes the canonical event identity (0076). Provider-set, so
 *                                 a sender cannot influence it.
 *   providerMessageId           — the provider's own id for this event. The dedupe identity.
 *   from                        — the SENDER's channel identity, as the provider gave it. Resolved
 *                                 against trusted records; never trusted as a claim in itself.
 *   text / mediaRefs            — content. Media are REFERENCES, never inlined bytes.
 *   receivedAt                  — when the provider says it arrived.
 *   consent                     — permission metadata where the channel has any. Absent is not
 *                                 consent; it is simply unknown, and the field says so.
 *   correlationId               — one trace id from receipt through to whatever it becomes.
 */
import { z } from "zod";

export const InboundChannel = z.enum(["whatsapp", "email", "sms", "voice", "calendar"]);
export type InboundChannel = z.infer<typeof InboundChannel>;

export const InboundMediaRef = z.object({
  /** The provider's id for the media. Fetched later, under the provider's own auth. */
  providerMediaId: z.string().min(1),
  mimeType: z.string().nullish(),
  /** Provider-declared size in bytes, when it gives one. Never trusted for allocation. */
  bytes: z.number().int().nonnegative().nullish(),
  filename: z.string().nullish(),
});
export type InboundMediaRef = z.infer<typeof InboundMediaRef>;

export const InboundConsent = z.object({
  /** True/false where the channel states it; null where the channel has no such concept. */
  marketingOptIn: z.boolean().nullish(),
  /** Provider-declared recording consent, for voice channels. */
  recordingConsent: z.boolean().nullish(),
  /** Free-form provider note, kept verbatim for the audit trail. */
  note: z.string().nullish(),
});

export const CanonicalInboundMessage = z.object({
  provider: z.string().min(1),
  channel: InboundChannel,
  providerAccountId: z.string().min(1).nullable(),
  providerMessageId: z.string().min(1).nullable(),
  from: z.string().min(1).nullable(),
  text: z.string(),
  mediaRefs: z.array(InboundMediaRef).default([]),
  receivedAt: z.string().nullable(),
  consent: InboundConsent.nullish(),
  correlationId: z.string().min(1),
  /** The provider's own payload for this ONE message — never the batch it arrived in. */
  raw: z.unknown(),
});
export type CanonicalInboundMessage = z.infer<typeof CanonicalInboundMessage>;

/**
 * What every channel adapter implements. `parse` is TOTAL: a payload it cannot understand yields an
 * empty list rather than an exception, because a provider is free to send event kinds we do not
 * handle and a webhook must still acknowledge them.
 */
export interface InboundAdapter {
  readonly provider: string;
  readonly channel: InboundChannel;
  parse(payload: unknown, correlationId: () => string): CanonicalInboundMessage[];
}
