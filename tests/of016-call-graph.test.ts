/**
 * OF-016 — the client the duplicate-review path actually uses.
 *
 * `resolve_duplicate_review` derives the acting human from `auth.uid()` and is granted to
 * `authenticated` ALONE. `duplicate_review_queue` checks `finance.duplicate.resolve` against
 * `auth.uid()` inside its own predicate. Both therefore depend on the request carrying a real
 * user's JWT: routed through the service-role client, the resolver would be refused at the ACL and
 * the queue would silently return NOTHING — an empty screen that looks like "no work waiting".
 *
 * That is a property of the call graph, not of the SQL, so it cannot be tested from the database.
 * This asserts it at the source, so a later edit that swaps the client fails here rather than in
 * production.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** Every file that reads the queue or resolves a review. */
const QUEUE_CALLERS = [
  "src/app/app/finance/duplicate-reviews/page.tsx",
  "src/app/app/finance/duplicate-reviews/actions.ts",
  "src/app/app/finance/page.tsx",
  "src/app/app/finance/approvals/page.tsx",
];

describe("OF-016 — the UI reaches the duplicate-review RPCs as the USER, never as the service role", () => {
  it("every call to duplicate_review_queue / resolve_duplicate_review goes through supabaseRpcClient", () => {
    for (const file of QUEUE_CALLERS) {
      const src = read(file);
      const calls = [...src.matchAll(/(\w+)\(\)\s*\.rpc\(\s*"(duplicate_review_queue|resolve_duplicate_review)"/g)];
      expect(calls.length, `${file} should call at least one duplicate-review RPC`).toBeGreaterThan(0);
      for (const [, client, rpc] of calls) {
        expect(client, `${file} calls ${rpc} through ${client}() — it must be supabaseRpcClient`)
          .toBe("supabaseRpcClient");
      }
    }
  });

  it("the duplicate-review screen and action never import the service-role client at all", () => {
    // Not merely "does not use it here" — it is not reachable from these modules, so a later edit
    // cannot quietly pick it up.
    for (const file of [
      "src/app/app/finance/duplicate-reviews/page.tsx",
      "src/app/app/finance/duplicate-reviews/actions.ts",
    ]) {
      const src = read(file);
      expect(src, `${file} must not import supabaseAdmin`).not.toMatch(/supabaseAdmin/);
    }
  });

  it("supabaseRpcClient is UNCONDITIONALLY the authenticated client — no flag can downgrade it", () => {
    // If this ever became flag-dependent like supabaseReadClient/supabaseWriteClient, every
    // assertion above would still pass while the runtime silently used the service role.
    const src = read("src/lib/supabase/read.ts");
    const fn = src.slice(src.indexOf("export function supabaseRpcClient"));
    const body = fn.slice(fn.indexOf("{"), fn.indexOf("}") + 1);
    expect(body).toContain("supabaseServer()");
    expect(body, "no branch, no flag, no fallback").not.toMatch(/rlsReadsEnabled|rlsWritesEnabled|\?|supabaseAdmin/);
  });

  it("the health tile is the ONE deliberate service-role read, and it reads a COUNT, not evidence", () => {
    // Stated rather than hidden. /app/admin/health is an operations view that already reads
    // everything through the service role; the duplicate figure there is a bare count of open rows
    // so the ops picture stays truthful even for an admin who cannot resolve them. It exposes no
    // amount, counterparty or evidence — those come only from the capability-gated queue RPC.
    const src = read("src/app/app/admin/health/page.tsx");
    expect(src).toMatch(/from\("duplicate_reviews"\)/);
    expect(src, "a count, not evidence").toMatch(/count:\s*"exact",\s*head:\s*true/);
    expect(src, "the health page must not read the capability-gated queue")
      .not.toMatch(/duplicate_review_queue/);
    // §WP6.3: a failed read must render as "unavailable", never as a reassuring 0. The first
    // version used `rows()`, which catches and returns [] — the outage-hiding pattern `Metric`
    // exists to prevent, and the review reproduced it against a database without the table.
    expect(src, "the duplicate count must go through probeCount").toMatch(
      /probeCount\(\(\) =>\s*\n?\s*db\.from\("duplicate_reviews"\)/);
  });
});
