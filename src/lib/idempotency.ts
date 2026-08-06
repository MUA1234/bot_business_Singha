/**
 * Idempotency-key derivation (NEXT_PHASE_DEVELOPER_BRIEF §WP2). Pure.
 *
 * A caller derives a stable key from the operation's identifying parts so that the
 * SAME logical operation (same document + amount + date, or an explicit client token)
 * always maps to the same key. The `idempotency_keys` table's primary key then turns a
 * retry into a no-op. Prefer an explicit client token when available (blocks a
 * double-submit of one form); fall back to the derived key.
 */
import { sha256 } from "@/lib/ids";

export function deriveIdempotencyKey(parts: Array<string | number | null | undefined>): string {
  return "idem_" + sha256(parts.map((p) => String(p ?? "")).join("|"));
}

/** Use an explicit client token if present and non-empty, else the derived key. */
export function resolveIdempotencyKey(clientToken: string | null | undefined, derivedParts: Array<string | number | null | undefined>): string {
  const t = (clientToken ?? "").trim();
  if (t) return "idem_" + sha256(`token:${t}`);
  return deriveIdempotencyKey(derivedParts);
}
