/**
 * Next.js server boot hook (WP F / §11). Runs once when the server process starts.
 * In production it fails fast if a mandatory security setting is missing; in
 * development/build it is a no-op (nothing connects at build time).
 */
import { assertProductionConfig } from "@/config/env";

export async function register(): Promise<void> {
  assertProductionConfig();
}
