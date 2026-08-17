/**
 * Operational health endpoint (WP E). Aggregates the system's health signals for a
 * monitor/dashboard, DISTINGUISHING a real value from an UNAVAILABLE source (never a
 * misleading 0). CRON_SECRET-gated (fail-closed) because it exposes operational counts.
 * It reports — it changes nothing. No recipient/body/PII is returned.
 *
 * Signals: outbox pending/oldest-age/failed/dead, source events failed/unprocessed,
 * dead-letters, unanalysed conversations, ledger integrity (imbalance / header-line
 * mismatch / orphaned lines / locked-period postings), and missing mandatory config.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { probeCount, metricLabel, metricNumber, type Metric } from "@/lib/metric";
import { classifyHealth } from "@/management/ai-manager/health";
import { buildAlerts, stampSeen } from "@/management/ai-manager/alerts";
import { missingConfig, outboxAgeLevel, ledgerIntegrityLevel, worstLevel, type SignalLevel } from "@/lib/health-signals";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_CONFIG = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OPENAI_API_KEY", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "CRON_SECRET",
];

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new NextResponse("health not configured", { status: 500 });
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const probe = (qb: PromiseLike<{ count: number | null; error: unknown }>): Promise<Metric> =>
    probeCount(async () => {
      const r = await qb;
      return { count: r.count, error: r.error };
    });

  // Simple status counts (each classified value vs unavailable).
  const [outboxPending, outboxFailed, outboxDead, sourceFailed, sourceUnprocessed, deadLetters, unanalysed] = await Promise.all([
    probe(db.from("message_outbox").select("*", { count: "exact", head: true }).eq("status", "pending")),
    probe(db.from("message_outbox").select("*", { count: "exact", head: true }).eq("status", "failed")),
    probe(db.from("message_outbox").select("*", { count: "exact", head: true }).eq("status", "dead")),
    probe(db.from("source_events").select("*", { count: "exact", head: true }).eq("status", "failed")),
    probe(db.from("source_events").select("*", { count: "exact", head: true }).in("status", ["received", "processing"])),
    probe(db.from("dead_letter_events").select("*", { count: "exact", head: true })),
    probe(db.from("wa_conversations").select("*", { count: "exact", head: true }).is("ai_analyzed_at", null)),
  ]);

  // Oldest pending outbox age (minutes) — value vs unavailable.
  let oldestPendingMin: number | null = null;
  let oldestAvailable = true;
  try {
    const { data, error } = await db.from("message_outbox").select("created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(1);
    const row0 = data?.[0];
    if (error) oldestAvailable = false;
    else if (row0) oldestPendingMin = Math.round((Date.now() - new Date(row0.created_at as string).getTime()) / 60000);
  } catch {
    oldestAvailable = false;
  }

  // Completion P1C — core APPLICATION tables the dashboards read. A missing table, revoked
  // permission, or failed query on these must be OBSERVABLE here (the pages themselves render a
  // user-safe degraded banner, never a fake "all clear"). Each probe distinguishes ok/unavailable.
  const CORE_TABLES = [
    "tasks", "customer_invoices", "supplier_bills", "management_cases",
    "capacity_snapshots", "bank_accounts", "cash_accounts", "payments",
  ] as const;
  const coreTableResults = await Promise.all(
    CORE_TABLES.map(async (t) => {
      const m = await probe(db.from(t).select("*", { count: "exact", head: true }));
      return [t, metricLabel(m)] as const;
    }),
  );
  const unavailableTables = coreTableResults.filter(([, v]) => v === "unavailable").map(([t]) => t);
  if (unavailableTables.length) {
    log("error", "core table probe failed", { event: "health.table_unavailable", tables: unavailableTables });
  }

  // Ledger integrity via the read-only report (migration 0041).
  let ledger: { level: SignalLevel; issues: string[]; available: boolean } = { level: "ok", issues: [], available: true };
  try {
    const { data, error } = await db.rpc("ledger_integrity_report", { p_company: null });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) ledger = { level: "warn", issues: ["ledger integrity report unavailable"], available: false };
    else {
      const r = ledgerIntegrityLevel({
        imbalancedJournals: Number(row.imbalanced_journals ?? 0),
        headerLineMismatch: Number(row.header_line_mismatch ?? 0),
        orphanedLines: Number(row.orphaned_lines ?? 0),
        lockedPeriodPostings: Number(row.locked_period_postings ?? 0),
      });
      ledger = { ...r, available: true };
    }
  } catch {
    ledger = { level: "warn", issues: ["ledger integrity report unavailable"], available: false };
  }

  const missing = missingConfig(Object.fromEntries(REQUIRED_CONFIG.map((k) => [k, !!process.env[k]])), REQUIRED_CONFIG);

  // Overall health from the core Metrics (never "ok" when a source is unavailable).
  const health = classifyHealth({ failedEvents: sourceFailed, deadLetters, outboxFailed, unprocessedEvents: sourceUnprocessed });

  // Alerts with owner + runbook + first/last-seen (no persistence here → both = now).
  const alerts = stampSeen(
    buildAlerts({
      failedEvents: metricNumber(sourceFailed) ?? 0,
      deadLetters: metricNumber(deadLetters) ?? 0,
      outboxFailed: (metricNumber(outboxFailed) ?? 0) + (metricNumber(outboxDead) ?? 0),
      repeatedAiFailures: 0,
      accountingIntegrityBreaches: ledger.level === "crit" ? 1 : 0,
      migrationMismatch: false,
    }),
    {},
  );

  const overall = worstLevel([
    health.level === "critical" ? "crit" : health.level === "warn" ? "warn" : "ok",
    outboxAgeLevel(oldestAvailable ? oldestPendingMin : null),
    ledger.level,
    missing.length ? (process.env.APP_ENV === "production" ? "crit" : "warn") : "ok",
    unavailableTables.length ? "warn" : "ok", // a dashboard-critical table failing is never "all clear"
  ]);

  if (overall === "crit") log("error", "health critical", { event: "health.critical", alerts: alerts.map((a) => a.key) });

  const label = (m: Metric) => metricLabel(m);
  return NextResponse.json({
    ok: true,
    level: overall,
    generatedAt: new Date().toISOString(),
    metrics: {
      outboxPending: label(outboxPending),
      outboxFailed: label(outboxFailed),
      outboxDead: label(outboxDead),
      oldestPendingMinutes: oldestAvailable ? (oldestPendingMin ?? 0) : "unavailable",
      sourceFailed: label(sourceFailed),
      sourceUnprocessed: label(sourceUnprocessed),
      deadLetters: label(deadLetters),
      unanalysedConversations: label(unanalysed),
    },
    ledgerIntegrity: ledger,
    coreTables: Object.fromEntries(coreTableResults),
    config: { missing },
    alerts,
  });
}
