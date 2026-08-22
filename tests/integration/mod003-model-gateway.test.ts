import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompletionTransport } from "@/ai/gateway";
import { ModelPolicyExecutor, ModelPolicyRouter, ModelProviderRegistry } from "@/ai/model-policy-router";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (url: string) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let companyId: string;

describe.skipIf(!enabled)("MOD-003 — durable provider attempt telemetry", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    companyId = (await db.query(
      `insert into companies (name, base_currency) values ('mod003-gateway', 'LKR') returning id`,
    )).rows[0].id;
  });

  afterAll(async () => {
    await db?.query(`delete from ai_model_attempts where company_id = $1`, [companyId]).catch(() => {});
    await db?.query(`delete from companies where id = $1`, [companyId]).catch(() => {});
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
});