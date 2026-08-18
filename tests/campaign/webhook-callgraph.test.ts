/**
 * FOUND-003 — production call-graph proof, at the level of the REAL entrypoints.
 *
 * The dispatch tests prove the logic with injected ports. This file proves the WIRING: the actual
 * WhatsApp webhook and the durable worker both go through the dispatcher, the dispatcher is the only
 * production caller of `ingestSourceEvent`, and no production path can still reach a hardcoded
 * company. A logic test that never touches the route cannot tell you the route uses it — that gap is
 * exactly how `ingestSourceEvent` came to have no production caller in the first place (D-009).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROUTE = "src/app/api/webhooks/whatsapp/route.ts";
const DEPS = "src/lib/inbound/production-deps.ts";
const WORKER = "src/inngest/functions.ts";

/** Non-comment lines only — a mention in prose is not a call. */
const codeLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    });

describe("FOUND-003 — the real webhook route reaches ingestSourceEvent", () => {
  it("the route imports the dispatcher and calls it", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toMatch(/from "@\/lib\/inbound\/dispatch"/);
    expect(src).toMatch(/await dispatchInbound\(/);
  });

  it("the route never calls the customer order handler itself", () => {
    // It is reached ONLY through the dispatcher's customer route, whose wiring now lives in the
    // shared production deps so the worker cannot diverge from the request path.
    const calls = codeLines(ROUTE).filter((l) => /handleCustomerMessage\(/.test(l));
    expect(calls).toEqual([]);
    expect(codeLines(DEPS).some((l) => /handleCustomerMessage\(/.test(l))).toBe(true);
  });

  it("the durable worker uses the SAME dispatcher, not the order handler", () => {
    // With WHATSAPP_ASYNC on, the worker used to call the order handler directly — so every message
    // was a customer order again and identity routing did not apply. The defect, behind a flag.
    const worker = codeLines(WORKER);
    expect(worker.some((l) => /handleCustomerMessage\(/.test(l))).toBe(false);
    expect(worker.some((l) => /dispatchInbound\(/.test(l))).toBe(true);
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
      codeLines(f).some((line) => /(?:await |= )ingestSourceEvent\(/.test(line.trim())),
    );
    expect(callers).toEqual(["src/lib/inbound/dispatch.ts"]);
  });

  it("identity resolution failure fails CLOSED — never silently 'not staff'", () => {
    const src = readFileSync(DEPS, "utf8");
    const errBranch = src.slice(src.indexOf("identity resolution failed"));
    expect(errBranch.slice(0, 400)).toContain('actorType: "ambiguous"');
  });

  it("no reply is sent for a message routed to manual review", () => {
    // Recording a review must not acknowledge to the sender that it was handled.
    const src = readFileSync(DEPS, "utf8");
    const rec = src.slice(src.indexOf("async recordForReview"), src.indexOf("async askClarification"));
    expect(rec).not.toMatch(/enqueueOutbox|handleCustomerMessage|sendWhatsApp/);
  });

  it("a review is a durable ROW, not a log line", () => {
    const src = readFileSync(DEPS, "utf8");
    const rec = src.slice(src.indexOf("async recordForReview"), src.indexOf("async askClarification"));
    expect(rec).toContain("record_inbound_review");
    // A queue insert that fails must not be swallowed: nobody would be asked to look.
    expect(rec).toMatch(/throw new Error/);
  });
});

describe("FOUND-003 — no production path can reach a hardcoded company", () => {
  it("DEFAULT_COMPANY_ID no longer exists anywhere in src/", () => {
    const out = execSync(`grep -rn "DEFAULT_COMPANY_ID" src --include=*.ts --include=*.tsx || true`, {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // The removal note in constants.ts explains WHY the constant is gone; it is not a use of it.
      .filter((l) => !l.startsWith("src/lib/constants.ts:"));
    expect(out).toEqual([]);
  });

  it("both inbound paths resolve the company from the RECEIVING account", () => {
    const route = readFileSync(ROUTE, "utf8");
    expect(route).toContain("resolveReceivingCompany");
    expect(route).toContain("phone_number_id");
    // Sync AND async: two resolution sites, and neither dispatches without a usable company.
    expect([...route.matchAll(/resolveReceivingCompany\(/g)]).toHaveLength(2);
    expect([...route.matchAll(/isUsableCompany\(company\)/g)]).toHaveLength(2);
  });

  it("the customer order handler REQUIRES a company — no silent default", () => {
    const src = readFileSync("src/lib/order-intake.ts", "utf8");
    expect(src).toMatch(/companyId: string;/);
    expect(src).not.toMatch(/input\.companyId \?\?/);
  });
});
