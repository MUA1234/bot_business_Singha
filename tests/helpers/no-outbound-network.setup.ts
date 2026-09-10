/**
 * Outbound-network guard for the kernel and people-intelligence suites.
 *
 * The owner's standing constraints for R0–R3 are absolute: no hosted service is contacted, no
 * live AI is called, no message is sent. Those are easy to assert about code you wrote and
 * impossible to assert about code you imported — a transitive dependency, a client library
 * with a telemetry ping, an SDK that resolves a config endpoint on first use.
 *
 * So this replaces every outbound primitive with one that THROWS. A suite that passes under it
 * has proven it made no network call, rather than asserting that it intended not to.
 *
 * The replacement happens at MODULE SCOPE, not in `beforeAll`. A setup file's `beforeAll` runs
 * after the test module has already been imported, so an import-time network call would slip
 * through — and the guard's own self-test would see an unguarded `fetch` and skip itself, which
 * is exactly how a guard quietly stops guarding.
 *
 * Used via `vitest.no-network.config.ts`. It is deliberately NOT global: the integration suites
 * talk to a disposable LOCAL PostgreSQL over TCP, which is legitimate and would be blocked here.
 */
import { createRequire } from "node:module";

function refuse(what: string): never {
  throw new Error(
    `OUTBOUND NETWORK REFUSED: ${what}. R0-R3 forbid contacting any hosted service, live model ` +
      `or messaging API. If a test needs one, it needs a fixture instead.`,
  );
}

// fetch — the path an AI gateway, a webhook or a Supabase client would take.
globalThis.fetch = ((input: unknown) => refuse(`fetch(${String(input)})`)) as typeof fetch;

// The lower-level Node clients, in case something bypasses fetch.
const req = createRequire(import.meta.url);
for (const mod of ["node:http", "node:https"] as const) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = req(mod) as any;
  m.request = () => refuse(`${mod}.request`);
  m.get = () => refuse(`${mod}.get`);
}

/** Set so the guard's self-test can confirm it is actually installed. */
(globalThis as Record<string, unknown>).__NO_OUTBOUND_NETWORK__ = true;
