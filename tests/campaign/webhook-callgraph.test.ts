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
const ORCHESTRATION = "src/lib/inbound/dispatch-receipt.ts";

/** Non-comment lines only — a mention in prose is not a call. */
const codeLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    });

describe("FOUND-003 — the real webhook route reaches ingestSourceEvent", () => {
  it("BOTH inbound paths run the SAME orchestration, which is the only caller of the dispatcher", () => {
    // The claim "async ON and OFF produce identical business outcomes" is only credible if there is
    // literally one implementation. Behaviour of that orchestration is covered by
    // tests/campaign/dispatch-receipt.test.ts; this asserts there is exactly one of it.
    for (const f of [ROUTE, WORKER]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/from "@\/lib\/inbound\/dispatch-receipt"/);
      expect(codeLines(f).some((l) => /dispatchReceipt\(/.test(l)), f).toBe(true);
    }
    // `dispatchInbound` as a VALUE (imported and used, not a type import or a comment) may appear
    // in exactly one module besides its own definition.
    const users = execSync(`grep -rln "dispatchInbound" src --include=*.ts || true`, { encoding: "utf8" })
      .split("\n").map((x) => x.trim()).filter(Boolean)
      .filter((f) => f !== "src/lib/inbound/dispatch.ts") // the definition itself
      .filter((f) => codeLines(f).some((l) => /\bdispatchInbound\b/.test(l) && !/^import type/.test(l.trim())));
    expect(users).toEqual([ORCHESTRATION]);
  });

  it("the route never calls the customer order handler itself", () => {
    // It is reached ONLY through the dispatcher's customer route, whose wiring now lives in the
    // shared production deps so the worker cannot diverge from the request path.
    const calls = codeLines(ROUTE).filter((l) => /handleCustomerMessage\(/.test(l));
    expect(calls).toEqual([]);
    expect(codeLines(DEPS).some((l) => /handleCustomerMessage\(/.test(l))).toBe(true);
  });

  it("the durable worker never calls the order handler directly", () => {
    // With WHATSAPP_ASYNC on, the worker used to call the order handler directly — so every message
    // was a customer order again and identity routing did not apply. The defect, behind a flag.
    expect(codeLines(WORKER).some((l) => /handleCustomerMessage\(/.test(l))).toBe(false);
  });

  it("ONE canonical receipt: nothing but the receipt RPC persists an inbound source event", () => {
    // A single provider message used to produce TWO source_events rows, under two different
    // idempotency keys, which made every inbound message look like unprocessed sweeper work.
    const persisters = execSync(`grep -rln "from(\"source_events\")\\|makeSupabaseSourceEventStore(" src --include=*.ts || true`,
      { encoding: "utf8" }).split("\n").map((x) => x.trim()).filter(Boolean)
      .filter((f) => f !== "src/db/source-event-store.ts"); // the store implementation itself
    expect(persisters).toEqual([]);
    for (const f of [ROUTE, WORKER]) {
      expect(codeLines(f).some((l) => /recordInboundReceipt\(/.test(l)), f).toBe(true);
    }
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
      // Two removal notes explain WHY the constant is gone. Neither is a use of it, and a grep that
      // cannot tell a comment from a call is the false-positive class this repo has been caught by.
      .filter((l) => !/^src\/lib\/(constants|inbound\/production-deps)\.ts:\d+:\s*(\*|\/\/)/.test(l));
    expect(out).toEqual([]);
  });

  it("the company comes from the RECEIVING account, in the one shared orchestration", () => {
    // Since R1 §6 the route reads the CANONICAL contract; `phone_number_id` now lives in the
    // adapter, which is the only place that knows Meta's payload shape.
    expect(readFileSync(ROUTE, "utf8")).toContain("providerAccountId");
    expect(readFileSync("src/lib/inbound/adapters/whatsapp.ts", "utf8")).toContain("phone_number_id");
    const orch = readFileSync(ORCHESTRATION, "utf8");
    expect(orch).toContain("resolveReceivingCompany");
    expect(orch).toContain("isUsableCompany");
    // Behavioural proof that an unusable company never reaches a dispatch lives in
    // tests/campaign/dispatch-receipt.test.ts.
  });

  it("the customer order handler REQUIRES a company — no silent default", () => {
    const src = readFileSync("src/lib/order-intake.ts", "utf8");
    expect(src).toMatch(/companyId: string;/);
    expect(src).not.toMatch(/input\.companyId \?\?/);
  });
});

describe("R1 §3 — the scheduled dispatch drain is REACHABLE, not just written", () => {
  it("the batch claim built in 0076 now has a production caller", () => {
    const callers = execSync(`grep -rln "claim_inbound_dispatch_batch" src --include=*.ts || true`, { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
    expect(callers).toContain("src/app/api/cron/dispatch-drain/route.ts");
  });

  it("the drain runs the SAME orchestration as the webhook, on an already-leased receipt", () => {
    const route = readFileSync("src/app/api/cron/dispatch-drain/route.ts", "utf8");
    expect(route).toContain("dispatchReceipt(");
    expect(route).toContain("alreadyClaimed: true");
    expect(route).toContain("makeInboundDeps");
  });

  it("it is scheduled, and the schedule is configuration rather than code", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.map((c) => c.path)).toContain("/api/cron/dispatch-drain");
  });

  it("no secret is committed — the route reads it from the environment", () => {
    const route = readFileSync("src/app/api/cron/dispatch-drain/route.ts", "utf8");
    expect(route).toContain("process.env.CRON_SECRET");
    expect(route).toContain("timingSafeEqual");
    // A literal long token in the route would be a committed credential.
    expect(route).not.toMatch(/CRON_SECRET\s*=\s*["'][^"']{8,}["']/);
  });
});

describe("R1 §4 — the finance capture consumer is wired, and `no_processor` is gone", () => {
  it("the sweeper runs the EXISTING pipeline, not a parallel one", () => {
    const route = readFileSync("src/app/api/cron/inbound-sweeper/route.ts", "utf8");
    expect(route).toContain("makeFinanceCaptureProcessor");
    expect(route).toContain("processSourceEvent");
    // The pipeline has exactly two production callers now: the Inngest consumer and the sweeper
    // (plus the processor module that receives it as an injected dependency).
    //
    // Filtered through `codeLines`, the same helper the rest of this file uses: a comment naming
    // `processSourceEvent` is documentation, not a caller. Counting one is the false-positive class
    // this campaign has been caught by twice, and it caught this assertion a third time when a
    // comment in the consumer store mentioned the function by name.
    const callers = execSync(`grep -rln "processSourceEvent" src --include=*.ts || true`, { encoding: "utf8" })
      .split("\n").map((x) => x.trim()).filter(Boolean)
      .filter((f) => f !== "src/inngest/processing.ts") // the definition itself
      .filter((f) => codeLines(f).some((l) => /\bprocessSourceEvent\b/.test(l)));
    // TWO, not three. `finance-capture-processor.ts` names the pipeline in its header comment and
    // receives it as an injected `process` port — it does not import or call it, and listing it here
    // was counting a comment as a caller.
    expect(callers.sort()).toEqual([
      "src/app/api/cron/inbound-sweeper/route.ts",
      "src/inngest/functions.ts",
    ]);
    // …and the processor really does take it as a dependency rather than reaching for it.
    expect(readFileSync("src/events/finance-capture-processor.ts", "utf8"))
      .not.toMatch(/^import .*processSourceEvent/m);
  });

  it("no production path RETURNS `no_processor` any more", () => {
    // Comments explaining what it used to do are history, not behaviour — the false-positive class
    // this suite has been caught by before. What must be gone is the CODE that returns it.
    const returning = execSync(`grep -rn "no_processor" src --include=*.ts || true`, { encoding: "utf8" })
      .split("\n").map((x) => x.trim()).filter(Boolean)
      .filter((line) => {
        const code = line.replace(/^[^:]+:\d+:/, "").trim();
        return !(code.startsWith("//") || code.startsWith("*") || code.startsWith("/*"));
      });
    expect(returning).toEqual([]);
  });
});
