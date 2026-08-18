/**
 * The inbound adapter registry (remediation R1 review loop 1).
 *
 * `source_events.source` says which channel produced a receipt; this says which adapter can read it
 * back. It exists because the scheduled drain hardcoded `channel: "whatsapp"` for every row it
 * claimed, and `claim_inbound_dispatch_batch` selects on dispatch state alone — so the first row any
 * other producer wrote would have been dispatched as a WhatsApp message.
 *
 * An unregistered source resolves to `null`, and the caller must FAIL that receipt rather than
 * guess. Adding a channel means adding its adapter here AND its own requirement — a registry entry
 * is not an integration.
 */
import type { InboundAdapter } from "@/schemas/inbound-adapter";
import { whatsappAdapter } from "@/lib/inbound/adapters/whatsapp";

/** Keyed by `source_events.source`, which is the CHANNEL, not the provider. */
const BY_SOURCE: Record<string, InboundAdapter> = {
  whatsapp: whatsappAdapter,
};

export function adapterForSource(source: string | null | undefined): InboundAdapter | null {
  if (!source) return null;
  return BY_SOURCE[source] ?? null;
}
