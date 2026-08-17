/**
 * FOUND-003 — production call-graph proof, at the level of the REAL entrypoint.
 *
 * The dispatch tests prove the logic with injected ports. This file proves the wiring: the actual
 * WhatsApp webhook route imports the dispatcher, and the dispatcher is the only thing in the
 * production tree that calls `ingestSourceEvent`. A logic test that never touches the route cannot
 * tell you the route uses it — that gap is exactly how `ingestSourceEvent` came to have no
 * production caller in the first place (D-009).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROUTE = "src/app/api/webhooks/whatsapp/route.ts";

describe("FOUND-003 — the real webhook route reaches ingestSourceEvent", () => {
  it("the route imports the dispatcher and calls it", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toMatch(/from "@\/lib\/inbound\/dispatch"/);
    expect(src).toMatch(/await dispatchInbound\(/);
  });

  it("the route no longer calls the customer order handler directly for every message", () => {
    // handleCustomerMessage must now be reached THROUGH the dispatcher's customer route, so the
    // only remaining reference in the route file is the port wiring inside makeDispatchDeps.
    const src = readFileSync(ROUTE, "utf8");
    const directCalls = [...src.matchAll(/(?:await |return )handleCustomerMessage\(/g)];
    expect(directCalls).toHaveLength(1);
    const idx = src.indexOf("await handleCustomerMessage(");
    expect(src.slice(0, idx)).toContain("function makeDispatchDeps");
  });

  it("the dispatcher is the only production caller of ingestSourceEvent", () => {
    // Match an actual CALL on a NON-COMMENT line. The identifier alone is not a caller: the email
    // stub carries a commented-out example, and a grep that cannot tell the difference produces
    // exactly the false signal this campaign has already been caught by twice.
    const out = execSync(`grep -rl "ingestSourceEvent" src --include=*.ts --include=*.tsx || true`, {
      encoding: "utf8",
    });
    const candidates = out.split("\n").map((s) => s.trim()).filter(Boolean)
      .filter((f) => f !== "src/events/source-event.ts"); // the definition itself

    const callers = candidates.filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .some((line) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
          return /(?:await |= )ingestSourceEvent\(/.test(t);
        }),
    );
    expect(callers).toEqual(["src/lib/inbound/dispatch.ts"]);
  });

  it("identity resolution failure fails CLOSED — never silently 'not staff'", () => {
    const src = readFileSync(ROUTE, "utf8");
    // The error branch must return ambiguous (→ manual review), not unknown-then-customer.
    const errBranch = src.slice(src.indexOf("identity resolution failed"));
    expect(errBranch.slice(0, 400)).toContain('actorType: "ambiguous"');
  });

  it("no reply is sent for a message routed to manual review", () => {
    // Recording a review must not acknowledge to the sender that it was handled.
    const src = readFileSync(ROUTE, "utf8");
    const rec = src.slice(src.indexOf("async recordForReview"), src.indexOf("async askClarification"));
    expect(rec).not.toMatch(/enqueueOutbox|handleCustomerMessage/);
  });
});
