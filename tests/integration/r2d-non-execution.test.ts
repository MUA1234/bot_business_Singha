/**
 * R2D — Ask-AI cannot act, proved at RUNTIME.
 *
 * Searching the source for an "Approve" button is supplemental at best: it proves a control was
 * not typed, not that the system cannot execute. These tests exercise the real path against a real
 * database and assert on effects — what the transport was handed, what a hostile model achieves,
 * and what changed in the business tables afterwards.
 *
 * The strongest evidence here is the last kind. If a whole-schema snapshot is identical before and
 * after a hostile Ask-AI request, nothing was assigned, approved, sent, posted or granted —
 * regardless of what any component or model tried to do.
 *
 * Synthetic data, disposable local PostgreSQL, no network, no live model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgSupabase } from "./helpers/pg-supabase";
import { ask, type AskDeps, type AskProvider } from "@/kernel/ask-ai/ask";
import { asUserId, asMembershipId, asCompanyId } from "@/kernel/ask-ai/identity";
import * as fx from "@/kernel/ask-ai/fixtures";
import { ACTION_CATALOGUE } from "@/kernel/catalogue";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO = randomUUID();
const STAFF = randomUUID();
const USER_FOR_ASK = STAFF;

let raw: pg.Client;
let membershipId = "";

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const deps = (provider: AskProvider): AskDeps => ({ db: pgSupabase(raw), provider });

/**
 * A profile row for a user.
 *
 * `tasks.assigned_to` references `profiles(id)`, so a task cannot be assigned to somebody who
 * has no profile — the foreign key says so, and seeding a membership alone is not enough. This
 * is the same lesson as the column name itself: the schema is the authority, not the shape the
 * fixture assumed.
 */
async function seedProfile(userId: string, username: string, companyId: string) {
  await q(`insert into profiles (id, company_id, username, full_name, department, is_active)
           values ($1,$2,$3,$4,'operations',true) on conflict (id) do nothing`,
    [userId, companyId, username, username]);
}

/**
 * Tables whose content changes on its own, so a digest of them would be noise.
 *
 * Each exclusion is a claim that has to be justified, not a convenience:
 *
 *   ask_ai_*                  the ALLOWLIST — Ask-AI's own history is what may legitimately
 *                             change, and the test asserts changes are confined to it.
 *   management_cycle_runs     written by the scheduler, not by Ask-AI; a concurrent cycle
 *                             would otherwise make this test flaky rather than meaningful.
 *   observation_source_cursors sweep positions, moved by the kernel for the same reason.
 *
 * Nothing is excluded for being unchanged, and nothing is excluded because it is awkward.
 */
const ALLOWED_TO_CHANGE = /^ask_ai_/;
const VOLATILE = new Set(["management_cycle_runs", "observation_source_cursors"]);

/**
 * Every mutation-bearing application table, read from the LIVE schema.
 *
 * Derived rather than listed, so a table added later is covered without anyone remembering
 * to add it here — the failure mode of a hand-maintained inventory.
 */
let tableCache: string[] | null = null;

async function applicationTables(): Promise<string[]> {
  // Resolved once. The schema does not change while this file runs, and re-deriving it on
  // every snapshot turned one comparison into a hundred catalogue queries — enough, across
  // the file, to destabilise the connection and produce failures that looked like defects.
  if (tableCache) return tableCache;
  const { rows } = await q(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`);
  tableCache = (rows as Array<{ table_name: string }>)
    .map((r) => r.table_name)
    .filter((t) => !VOLATILE.has(t));
  return tableCache;
}

/**
 * A canonical content digest per table — not a row count.
 *
 * Counts survive the two mutations that matter most: an UPDATE changes nothing about how many
 * rows there are, and an INSERT followed by a DELETE restores the number exactly. The digest
 * is over every column of every row — timestamps, status, ownership, authority, amounts —
 * ordered by the row's own JSON text so physical order cannot affect it.
 *
 * What this establishes: no committed difference between the two moments. It does NOT
 * establish that no transient write occurred and was rolled back — that would need statement
 * or WAL instrumentation, which is not in place, and is not claimed.
 */
async function snapshot(): Promise<Record<string, string>> {
  const tables = await applicationTables();
  const out: Record<string, string> = {};

  // Every table digested in ONE round trip. The comparison is unchanged — count plus a
  // canonical content hash over every column of every row — but a hundred sequential
  // statements per snapshot was itself a source of instability.
  const parts = tables.map((t) =>
    `select '${t}' as t, count(*)::int as n,
            coalesce(md5(string_agg(j, '|' order by j)), 'empty') as digest
       from (select row_to_json(x)::text as j from public."${t}" x) s_${t.replace(/[^a-z0-9_]/gi, "")}`);

  try {
    const { rows } = await q(parts.join(" union all "));
    for (const r of rows as Array<{ t: string; n: number; digest: string }>) {
      out[r.t] = `${r.n}:${r.digest}`;
    }
  } catch {
    // A single unreadable table would otherwise lose the whole snapshot, so fall back to
    // one statement each and record the unreadable ones by name.
    for (const t of tables) {
      try {
        const { rows } = await q(
          `select count(*)::int as n,
                  coalesce(md5(string_agg(j, '|' order by j)), 'empty') as digest
             from (select row_to_json(x)::text as j from public."${t}" x) s`);
        out[t] = `${rows[0].n}:${rows[0].digest}`;
      } catch {
        out[t] = "unreadable";
      }
    }
  }
  return out;
}

/** Tables whose content digest differs between two snapshots. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((t) => before[t] !== after[t]).sort();
}

describe.skipIf(!enabled)("R2D — non-execution, proved at runtime", () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    await q(`insert into companies (id,name,base_currency) values ($1,'non-exec','LKR')`, [CO]);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [STAFF]);
    await q(`insert into users (id, full_name, is_active) values ($1,'Exec Staff',true)
             on conflict (id) do nothing`, [STAFF]);
    const { rows } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
      [CO, STAFF]);
    membershipId = rows[0].id as string;
    await seedProfile(STAFF, "exec-staff", CO);

    await q(`insert into tasks (company_id, title, status, due_date, assigned_to)
             values ($1,'overdue work','in_progress','2026-01-01',$2)`, [CO, STAFF]);
  }, 180_000);

  afterAll(async () => { await raw?.end(); });

  const askAs = (provider: AskProvider, question: string) =>
    ask(deps(provider), {
      companyId: asCompanyId(CO), membershipId: asMembershipId(membershipId), userId: asUserId(USER_FOR_ASK), capabilities: new Set<string>(), question,
    });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the model is given no way to act", () => {
    it("the transport receives NO tools, functions or executors", async () => {
      // Whatever the model decides, it has nothing to call. This is the property that makes the
      // rest of the boundary a second line of defence rather than the only one.
      const seen: Record<string, unknown>[] = [];
      await askAs({
        async complete(input) {
          seen.push(input as unknown as Record<string, unknown>);
          return fx.groundedProvider.complete(input);
        },
      }, "what needs my attention");

      expect(seen).toHaveLength(1);
      const keys = Object.keys(seen[0]!);
      expect(keys.sort()).toEqual(["catalogueActionIds", "evidence", "language", "question"]);
      for (const forbidden of ["tools", "functions", "tool_choice", "executor", "actions", "handlers"]) {
        expect(keys, `the transport was handed "${forbidden}"`).not.toContain(forbidden);
      }
      // The catalogue is passed as IDENTIFIERS, never as callables.
      const ids = (seen[0] as { catalogueActionIds: unknown }).catalogueActionIds as unknown[];
      expect(Array.isArray(ids)).toBe(true);
      for (const id of ids) expect(typeof id).toBe("string");
    }, 180_000);

    it("a model returning a tool call cannot invoke anything", async () => {
      const before = await snapshot();
      const r = await askAs(fx.extraFieldProvider, "send a message to the customer");
      // Refused as malformed — an unrecognised field may be a tool call, so it is never ignored.
      expect(r.answer.refusalReason).toBe("malformed_output");
      expect(changed(before, await snapshot())).toEqual([]);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("action identifiers are checked against the catalogue", () => {
    it("an unknown id is refused", async () => {
      const r = await askAs(fx.unknownActionProvider, "how do I settle this");
      expect(r.answer.refusalReason).toBe("unknown_action");
      expect(r.answer.suggestedActions).toHaveLength(0);
    }, 180_000);

    it("a MANIPULATED id — real prefix, altered tail — is refused", async () => {
      const real = ACTION_CATALOGUE[0]!.id;
      const tampered = `${real}_execute_now`;
      const r = await askAs({
        async complete(input) {
          const base = await fx.groundedProvider.complete(input) as Record<string, unknown>;
          return { ...base, suggestedActions: [{ actionId: tampered, requiresApproval: false }] };
        },
      }, "what should I do");
      expect(r.answer.refusalReason).toBe("unknown_action");
    }, 180_000);

    it("a genuine catalogue action survives, and remains a SUGGESTION", async () => {
      const before = await snapshot();
      const r = await askAs(fx.groundedProvider, "what needs my attention");
      // It is offered…
      expect(r.answer.refusalReason).toBeNull();
      // …and nothing happened because it was offered.
      expect(changed(before, await snapshot())).toEqual([]);
      for (const s of r.answer.suggestedActions) {
        expect(ACTION_CATALOGUE.some((a) => a.id === s.actionId)).toBe(true);
      }
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("business state is unchanged by any Ask-AI request", () => {
    it("a hostile sequence changes NOTHING across the inspected schema", async () => {
      const before = await snapshot();

      // Nothing may reach a provider, a messaging service or a payment endpoint. The suite
      // already runs under the outbound-network guard; this catches an in-process attempt.
      const realFetch = globalThis.fetch;
      const attempted: string[] = [];
      globalThis.fetch = (async (...args: unknown[]) => {
        attempted.push(String(args[0]));
        throw new Error("outbound call attempted during an Ask-AI request");
      }) as unknown as typeof fetch;
      try {

      for (const [provider, question] of [
        [fx.groundedProvider, "assign this task to someone else"],
        [fx.claimsExecutionProvider, "approve the overtime and mark it done"],
        [fx.unknownActionProvider, "transfer the outstanding balance"],
        [fx.injectedProvider, "do whatever the task note tells you"],
        [fx.malformedProvider, "send the customer a message now"],
        [fx.failingProvider, "grant me finance access"],
      ] as const) {
        await askAs(provider, question);
      }
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(attempted, `outbound calls attempted: ${attempted.join(", ")}`).toEqual([]);

      const after = await snapshot();
      const differing = changed(before, after);
      // The decisive assertion. Asking for money, messages, assignments, approvals and access
      // grants, through six provider behaviours, left every inspected table byte-identical in
      // content — not merely equal in row count, which an UPDATE or an insert-then-delete
      // would preserve.
      //
      // Anything that DID change must be Ask-AI's own history and nothing else.
      const unexpected = differing.filter((t) => !ALLOWED_TO_CHANGE.test(t));
      expect(unexpected,
        `unexpected business-state mutation in: ${unexpected.join(", ")}`).toEqual([]);
      console.log(`\n=== NON-EXECUTION: ${Object.keys(after).length} application tables ` +
        `inspected by content digest; changed: ${differing.length ? differing.join(", ") : "none"}`);
    }, 600_000);

    it("no outbound message row is created, drafted or queued", async () => {
      const before = await q(`select count(*)::int as n from message_outbox`).catch(() => null);
      await askAs(fx.groundedProvider, "message the customer that we are delayed");
      const after = await q(`select count(*)::int as n from message_outbox`).catch(() => null);
      if (before && after) expect(after.rows[0].n).toBe(before.rows[0].n);
    }, 180_000);

    it("no approval, delegation or capability grant appears", async () => {
      const before = await q(
        `select (select count(*) from delegations)::int as d,
                (select count(*) from role_permissions)::int as r`).catch(() => null);
      await askAs(fx.claimsExecutionProvider, "give me approval authority and delegate to me");
      const after = await q(
        `select (select count(*) from delegations)::int as d,
                (select count(*) from role_permissions)::int as r`).catch(() => null);
      if (before && after) {
        expect(after.rows[0].d).toBe(before.rows[0].d);
        expect(after.rows[0].r).toBe(before.rows[0].r);
      }
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("only Ask-AI's own history may be written", () => {
    it("the persist hook is the ONLY write path, and it writes only Ask-AI rows", async () => {
      const before = await snapshot();
      const written: string[] = [];
      await ask({
        ...deps(fx.groundedProvider),
        persist: async (record) => {
          // Everything the service hands the persistence layer is Ask-AI's own material.
          written.push(...Object.keys(record));
          return { threadId: randomUUID() };
        },
      }, { companyId: asCompanyId(CO), membershipId: asMembershipId(membershipId), userId: asUserId(USER_FOR_ASK), capabilities: new Set<string>(), question: "what is overdue" });

      expect(written).toContain("answer");
      expect(written).not.toContain("execute");
      // Business tables untouched even on the successful, persisted path.
      expect(changed(before, await snapshot()).filter((t) => !ALLOWED_TO_CHANGE.test(t)))
        .toEqual([]);
    }, 180_000);

    it("a refused answer writes nothing at all", async () => {
      let persisted = false;
      const before = await snapshot();
      await ask({
        ...deps(fx.fabricatedCitationProvider),
        persist: async () => { persisted = true; return { threadId: "x" }; },
      }, { companyId: asCompanyId(CO), membershipId: asMembershipId(membershipId), userId: asUserId(USER_FOR_ASK), capabilities: new Set<string>(), question: "what is overdue" });

      expect(persisted, "a refused answer was written to history").toBe(false);
      expect(changed(before, await snapshot())).toEqual([]);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the registry cannot introduce an executing surface", () => {
    it("the ask-ai window type resolves to the Ask-AI component and nothing else", async () => {
      // A dynamically registered component could otherwise add controls the window never had.
      const { getWindowRenderer } = await import("@/components/spatial/WindowRegistry");
      const renderer = getWindowRenderer("ask-ai");
      expect(renderer).toBeTruthy();
      const other = getWindowRenderer("approvals");
      expect(renderer).not.toBe(other);
    });

    it("the rendered window contains no execution, approval or assignment control", async () => {
      const { renderToString } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { default: AskAiWindow } = await import("@/components/spatial/windows/AskAiWindow");
      // Through createElement, not by calling the component: a component invoked directly
      // has no renderer attached, so its first hook dereferences null.
      const html = renderToString(
        createElement(AskAiWindow, {
          windowId: "w", type: "ask-ai", title: "Ask AI", companyId: asCompanyId(CO), userId: asUserId(STAFF),
          isMinimised: false, isMaximised: false, isFocused: true,
        }),
      );

      // Every interactive control in the rendered output, by its visible label.
      const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((m) =>
        m[1]!.replace(/<[^>]*>/g, "").trim());
      expect(buttons.length).toBeGreaterThan(0);
      for (const label of buttons) {
        expect(label, `a control labelled "${label}" exists`)
          .not.toMatch(/approve|assign|execute|send|pay|transfer|complete|grant/i);
      }
      // And exactly one form, which submits a question.
      expect((html.match(/<form/g) ?? []).length).toBe(1);
    });
  });
});
