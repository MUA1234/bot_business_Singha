import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompletionTransport } from "@/ai/gateway";
import { AiGateway } from "@/ai/gateway";
import { ModelPolicyExecutor, ModelPolicyRouter, ModelProviderRegistry } from "@/ai/model-policy-router";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (url: string) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let companyId: string;
let otherCompanyId: string;
let adminUser: string;

const runAs = async (role: string, sub: string | null, sql: string, params: any[] = []) => {
  await db.query("begin");
  try {
    await db.query(`set local role ${role}`);
    if (sub) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, sub })]);
    else await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    const r = await db.query(sql, params);
    await db.query("commit");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { ok: false, code: (e as { code?: string }).code, message: (e as Error).message };
  }
};

describe.skipIf(!enabled)("MOD-003 — provider-neutral model gateway and policy router (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    companyId = (await db.query(
      `insert into companies (name, base_currency) values ('mod003-gateway', 'LKR') returning id`,
    )).rows[0].id;
    otherCompanyId = (await db.query(
      `insert into companies (name, base_currency) values ('mod003-other', 'LKR') returning id`,
    )).rows[0].id;
    adminUser = (await db.query(
      `insert into auth.users (id) values (gen_random_uuid()) returning id`,
    )).rows[0].id;
    await db.query(`insert into users (id, full_name, is_active) values ($1,'mod003 admin',true)`, [adminUser]);
    await db.query(`insert into profiles (id, company_id, username, full_name, department, is_active) values ($1,$2,'mod003admin','mod003 admin','finance',true)`, [adminUser, companyId]);
    const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [companyId, adminUser])).rows[0].id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [m, companyId]);
  });

  afterAll(async () => {
    for (const co of [companyId, otherCompanyId]) {
      await db?.query(`delete from ai_model_attempts where company_id = $1`, [co]).catch(() => {});
      await db?.query(`delete from ai_model_budget_policies where company_id = $1`, [co]).catch(() => {});
      await db?.query(`delete from audit_events where company_id=$1`, [co]).catch(() => {});
      await db?.query(`delete from membership_roles where company_id=$1`, [co]).catch(() => {});
      await db?.query(`delete from memberships where company_id=$1`, [co]).catch(() => {});
      await db?.query(`delete from profiles where company_id=$1`, [co]).catch(() => {});
      await db?.query(`delete from users where id=$1`, [adminUser]).catch(() => {});
      await db?.query(`delete from companies where id = $1`, [co]).catch(() => {});
    }
    await db?.end().catch(() => {});
  });

  it("records one failed primary and one successful fallback, and replays idempotently", async () => {
    const failed: CompletionTransport = { complete: async () => { throw new Error("timeout"); } };
    const succeeded: CompletionTransport = {
      complete: async () => ({ text: "{}", usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: "0.01" }),
    };
    const registry = new ModelProviderRegistry([
      { candidate: { provider: "primary", model: "p", tasks: ["quotation"], estimatedCostUsd: "0.01", latencyMs: 1 }, transport: failed },
      { candidate: { provider: "fallback", model: "f", tasks: ["quotation"], estimatedCostUsd: "0.02", latencyMs: 1 }, transport: succeeded },
    ]);
    const telemetry = {
      recordAttempt: async (attempt: any) => {
        await db.query(
          `insert into ai_model_attempts (company_id, logical_request_id, task, provider, model, attempt, outcome, latency_ms, error_category)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (company_id, logical_request_id, attempt) do nothing`,
          [companyId, attempt.logicalRequestId, attempt.task, attempt.provider, attempt.model, attempt.attempt, attempt.outcome, attempt.latencyMs, attempt.errorCategory ?? null],
        );
      },
    };
    const executor = new ModelPolicyExecutor(registry, new ModelPolicyRouter(registry.candidates()), telemetry);
    const request = {
      logicalRequestId: "mod003-replay", selection: { companyId, task: "quotation" as const, budgetRemainingUsd: "1" },
      completion: { system: "system", user: "user", maxTokens: 1 },
    };

    await expect(executor.execute(request)).resolves.toMatchObject({ ok: true, attempts: 2 });
    await expect(executor.execute(request)).resolves.toMatchObject({ ok: true, attempts: 1 });
    const rows = (await db.query(
      `select attempt, provider, outcome from ai_model_attempts where company_id = $1 and logical_request_id = $2 order by attempt`,
      [companyId, request.logicalRequestId],
    )).rows;
    expect(rows).toEqual([
      { attempt: 1, provider: "primary", outcome: "failed" },
      { attempt: 2, provider: "fallback", outcome: "succeeded" },
    ]);
  });

  it("set_ai_model_budget_policy is reachable only by authenticated with ai.model_budget.manage", async () => {
    const noCapUser = (await db.query(`insert into auth.users (id) values (gen_random_uuid()) returning id`)).rows[0].id;
    await db.query(`insert into users (id, full_name, is_active) values ($1,'no cap',true)`, [noCapUser]);
    await db.query(`insert into profiles (id, company_id, username, full_name, department, is_active) values ($1,$2,'nocap','no cap','finance',true)`, [noCapUser, companyId]);
    const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [companyId, noCapUser])).rows[0].id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'staff_submitter')`, [m, companyId]);

    // anon and service_role have no EXECUTE grant.
    const anon = await runAs("anon", null, "select public.set_ai_model_budget_policy($1,'extraction',1.0,true,0)", [companyId]);
    expect(anon.ok).toBe(false);
    expect(anon.code).toBe("42501");

    const svc = await runAs("service_role", null, "select public.set_ai_model_budget_policy($1,'extraction',1.0,true,0)", [companyId]);
    expect(svc.ok).toBe(false);
    expect(svc.code).toBe("42501");

    // Authenticated but lacking the capability is refused INSIDE the function.
    const noCap = await runAs("authenticated", noCapUser, "select public.set_ai_model_budget_policy($1,'extraction',1.0,true,0)", [companyId]);
    expect(noCap.ok).toBe(false);
    expect(noCap.message).toMatch(/actor lacks ai\.model_budget\.manage|insufficient_privilege/i);

    // Owner/management can configure it.
    const ok = await runAs("authenticated", adminUser, "select public.set_ai_model_budget_policy($1,'extraction',1.0,true,0)", [companyId]);
    expect(ok.ok).toBe(true);

    await db.query(`delete from membership_roles where membership_id=$1`, [m]);
    await db.query(`delete from memberships where id=$1`, [m]);
    await db.query(`delete from profiles where id=$1`, [noCapUser]);
    await db.query(`delete from users where id=$1`, [noCapUser]);
  });

  it("set_ai_model_budget_policy enforces company isolation", async () => {
    // Admin can write their own company's policy.
    const own = await runAs("authenticated", adminUser, "select public.set_ai_model_budget_policy($1,'management',2.0,true,0)", [companyId]);
    expect(own.ok).toBe(true);

    // The same admin has no capability in another company, so the function refuses.
    const other = await runAs("authenticated", adminUser, "select public.set_ai_model_budget_policy($1,'management',2.0,true,0)", [otherCompanyId]);
    expect(other.ok).toBe(false);
    expect(other.message).toMatch(/actor lacks ai\.model_budget\.manage|insufficient_privilege/i);
  });

  it("set_ai_model_budget_policy rejects stale versions and invalid amounts", async () => {
    const first = await runAs("authenticated", adminUser, "select public.set_ai_model_budget_policy($1,'quotation',5.0,true,0)", [companyId]);
    expect(first.ok).toBe(true);

    // Same version again → stale.
    const stale = await runAs("authenticated", adminUser, "select public.set_ai_model_budget_policy($1,'quotation',6.0,true,0)", [companyId]);
    expect(stale.ok).toBe(false);
    expect(stale.message).toMatch(/stale policy version/i);

    // Negative / zero amount → invalid.
    for (const bad of ["-1", "0"]) {
      const neg = await runAs("authenticated", adminUser, `select public.set_ai_model_budget_policy($1,'quotation',${bad},true,1)`, [companyId]);
      expect(neg.ok).toBe(false);
      expect(neg.message).toMatch(/invalid AI model budget policy/i);
    }
  });

  it("loadAiTaskBudget uses exact decimal arithmetic and never returns a negative remainder", async () => {
    const { loadAiTaskBudget } = await import("@/db/consumer-store");
    const mockDb = {
      from: (table: string) => {
        if (table === "ai_model_budget_policies") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: { max_cost_usd: "0.3" }, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  data: [{ cost_usd: "0.1" }, { cost_usd: "0.1" }, { cost_usd: "0.1" }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      },
    };
    await expect(loadAiTaskBudget(mockDb as any, companyId, "extraction")).resolves.toBe("0");
  });

  it("the gateway fails closed when no active budget policy exists", async () => {
    const transport: CompletionTransport = {
      complete: async () => ({ text: "{}", usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: "0.01" }),
    };
    const ledger = { record: async () => {} };
    const executor = new ModelPolicyExecutor(
      new ModelProviderRegistry([
        { candidate: { provider: "only", model: "m", tasks: ["extraction"], estimatedCostUsd: "0.01", latencyMs: 1 }, transport },
      ]),
      new ModelPolicyRouter([]),
      { recordAttempt: async () => {} },
    );
    const gateway = new AiGateway(transport, ledger, { executor, loadBudget: async () => null });
    const result = await gateway.runExtraction({ content: "x", correlationId: "c", sourceEventId: null, companyId });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("transport_error");
    expect(result.issues?.[0]).toMatch(/no active model budget policy/i);
  });

  it("the gateway fails closed when the remaining budget is exhausted", async () => {
    const transport: CompletionTransport = {
      complete: async () => ({ text: "{}", usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: "0.01" }),
    };
    const ledger = { record: async () => {} };
    const executor = new ModelPolicyExecutor(
      new ModelProviderRegistry([]),
      new ModelPolicyRouter([]),
      { recordAttempt: async () => {} },
    );
    const gateway = new AiGateway(transport, ledger, { executor, loadBudget: async () => "0" });
    const result = await gateway.runExtraction({ content: "x", correlationId: "c", sourceEventId: null, companyId });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("transport_error");
    expect(result.issues?.[0]).toMatch(/model policy no_healthy_provider|no active model budget policy/i);
  });

  it("ai_model_attempts is append-only: authenticated cannot mutate existing rows", async () => {
    await db.query(
      `insert into ai_model_attempts (company_id, logical_request_id, task, provider, model, attempt, outcome, latency_ms)
       values ($1,'mod003-lock','extraction','p','m',1,'succeeded',10)`,
      [companyId],
    );
    const update = await runAs("authenticated", adminUser,
      `update ai_model_attempts set outcome='failed' where company_id=$1 and logical_request_id='mod003-lock'`, [companyId]);
    expect(update.ok).toBe(false);
    expect(update.code).toBe("42501");

    const del = await runAs("authenticated", adminUser,
      `delete from ai_model_attempts where company_id=$1 and logical_request_id='mod003-lock'`, [companyId]);
    expect(del.ok).toBe(false);
    expect(del.code).toBe("42501");
  });
});
