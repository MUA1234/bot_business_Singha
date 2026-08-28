/**
 * AI operations (§44, §45).
 *
 * Where a manager goes to see what the AI has been doing, what it cost, how
 * often its structured output validated, and — most importantly — where the
 * boundary of its authority sits.
 *
 * WHAT THIS SCREEN IS NOT. It is not an agent builder and it is not an agent
 * control room. Autonomous AI agents, a self-service agent builder and
 * customer-facing AI agents are gated behind a separate legal and privacy
 * review in this repository and are NOT implemented. This screen says so
 * plainly rather than presenting an empty console that implies the capability
 * exists and merely has nothing in it.
 *
 * Every figure is read from `ai_runs`, which the AI gateway writes on each call.
 * A failed read is reported as unreadable, never as zero.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { decSum } from "@/lib/money";
import { fmtNumber } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { env } from "@/config/env";
import {
  Facts,
  PageHead,
  Provenance,
  Section,
  Signal,
  StateNote,
} from "@/components/os/primitives";

export const metadata = { title: "AI operations — Singha Central" };

export default async function AiOperationsPage() {
  const admin = await requireAdmin();
  const db = supabaseReadClient();

  let runs: any[] = [];
  let runsUnreadable = false;
  try {
    const { data, error } = await db
      .from("ai_runs")
      .select("task, model, cost_usd, validation_ok, created_at")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) runsUnreadable = true;
    else runs = data ?? [];
  } catch {
    runsUnreadable = true;
  }

  const totalCost = decSum(runs.map((r) => r.cost_usd ?? "0"));
  const validated = runs.filter((r) => r.validation_ok === true).length;
  const failedValidation = runs.filter((r) => r.validation_ok === false).length;

  // Cost and volume by task, so a manager can see WHAT the spend was on.
  const byTask = new Map<string, { count: number; failures: number }>();
  for (const r of runs) {
    const key = String(r.task ?? "unrecorded");
    const cur = byTask.get(key) ?? { count: 0, failures: 0 };
    cur.count++;
    if (r.validation_ok === false) cur.failures++;
    byTask.set(key, cur);
  }
  const tasks = [...byTask.entries()].sort((a, b) => b[1].count - a[1].count);

  const configured = Boolean(process.env.OPENAI_API_KEY);

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Platform"
        title="AI operations"
        lede="What the AI Manager has done, what it cost, and how often its structured output was valid. Every run is recorded with its model, prompt version, cost and validation result."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/command/analyze">Run an analysis</Link>
            <Link className="btn ghost sm" href="/app/admin/model-budgets">Model budgets</Link>
          </>
        }
      />

      {/* The authority boundary, stated once, before any number. */}
      <div className="card">
        <Provenance kind="ai" label="What the AI may and may not do">
          <p className="muted" style={{ fontSize: "var(--t-data)", lineHeight: 1.55 }}>
            The AI observes, explains and proposes. It validates every structured output against a
            schema, then passes the proposal through deterministic authority rules, a permission
            check and the audit log before anything reaches business state. It{" "}
            <strong>cannot</strong> approve a payment, post a material journal, change a permission,
            hire or dismiss anyone, or make a commitment to a customer. Free-text model output never
            triggers a sensitive action directly.
          </p>
        </Provenance>
      </div>

      {!configured && (
        <StateNote kind="config" title="AI gateway not configured in this environment">
          No AI call can be made from here. Historical runs, if any were recorded previously, still
          appear below; nothing new will be added until the gateway is configured.
        </StateNote>
      )}

      <Section title="Recorded activity" meta="the 2,000 most recent runs" />
      {runsUnreadable ? (
        <StateNote kind="error" title="The AI run ledger could not be read">
          This screen cannot say how many runs occurred or what they cost. That is not a statement
          that there were none.
        </StateNote>
      ) : (
        <div className="grid cols-4">
          <div className="card stat">
            <div className="k">Runs recorded</div>
            <div className="v">{fmtNumber(runs.length)}</div>
            <div className="d">Each with model, cost and validation result</div>
          </div>
          <div className="card stat">
            <div className="k">Cost (USD)</div>
            <div className="v">${Number(totalCost).toFixed(4)}</div>
            <div className="d">Charged by the provider, recorded per run</div>
          </div>
          <div className="card stat">
            <div className="k">Output validated</div>
            <div className="v">{fmtNumber(validated)}</div>
            <div className="d">
              <Signal kind="ok">Matched its schema</Signal>
            </div>
          </div>
          <div className="card stat">
            <div className="k">Validation failures</div>
            <div className="v">{fmtNumber(failedValidation)}</div>
            <div className="d">
              {failedValidation > 0 ? (
                <Signal kind="warn">Rejected before reaching business state</Signal>
              ) : (
                <Signal kind="ok">None rejected</Signal>
              )}
            </div>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <>
          <Section title="By task" meta="what the spend was on" />
          <div className="card">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th className="num">Runs</th>
                    <th className="num">Validation failures</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map(([task, stat]) => (
                    <tr key={task} className={stat.failures > 0 ? "is-priority" : undefined}>
                      <td className="mono">{task}</td>
                      <td className="num">{fmtNumber(stat.count)}</td>
                      <td className="num">{fmtNumber(stat.failures)}</td>
                      <td>
                        {stat.failures > 0 ? (
                          <Signal kind="warn">Some output did not validate</Signal>
                        ) : (
                          <Signal kind="ok">All output validated</Signal>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Section title="Where to go" />
      <div className="grid cols-3">
        {[
          { href: "/app/command/analyze", label: "Analysis", icon: "radar", note: "Turn an update into facts, tasks and required authority" },
          { href: "/app/command/cases", label: "Management cases", icon: "briefcase", note: "What the AI raised for a human to decide" },
          { href: "/app/command/memory", label: "Memory", icon: "database", note: "What the manager has retained, and why" },
          { href: "/app/admin/model-budgets", label: "Model budgets", icon: "wallet", note: "Spend limits per task, and their enforcement" },
          { href: "/app/admin/directives", label: "Directives", icon: "megaphone", note: "Management instruction with a response obligation" },
          { href: "/app/admin/health", label: "System health", icon: "heart-pulse", note: "Queues, failures and AI cost in context" },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="node-card">
            <span className="node-card-ico" aria-hidden="true">
              <Icon name={item.icon} size={17} strokeWidth={1.6} />
            </span>
            <span className="node-card-text">
              <span className="node-card-title">{item.label}</span>
              <span className="node-card-note">{item.note}</span>
            </span>
            <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
          </Link>
        ))}
      </div>

      {/* ── THE GATED CAPABILITIES, NAMED ───────────────────────────────── */}
      <Section title="Not built, and why" meta="an honest absence, not an empty console" />
      <div className="card">
        <StateNote kind="denied" title="Autonomous agents and the agent builder are gated">
          A self-service agent builder, autonomous AI workers and customer-facing AI agents are
          gated behind a separate legal and privacy review in this repository and are deliberately
          NOT implemented. Presenting an empty agent console here would imply the capability exists
          and merely has nothing in it, which is not true.
        </StateNote>
        <div className="mt-3">
          <Facts
            items={[
              { k: "Agent builder", v: "Not implemented — requires written approval" },
              { k: "Autonomous agents", v: "Not implemented — requires written approval" },
              { k: "Customer-facing AI agents", v: "Not implemented — requires written approval" },
              { k: "Facial recognition", v: "Not implemented — requires separate written approval" },
              { k: "GPS / location tracking", v: "Not implemented — legal and privacy review" },
              { k: "CCTV event review", v: "Not implemented — notices and retention policy first" },
            ]}
          />
        </div>
      </div>

      {env.flags.spatialWorkspace() && (
        <div className="card mt-2">
          <Section title="Spatial workspace" meta="feature flag is ON in this environment" />
          <p className="small muted">
            The multi-window spatial operations workspace is enabled here.{" "}
            <Link href="/app/spatial">Open it</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
