/**
 * Environment access. Secrets are read here and nowhere else. Missing required
 * vars fail loudly at startup rather than at first use. NEVER log these values.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  appEnv: optional("APP_ENV") ?? "development",
  appBaseUrl: optional("APP_BASE_URL") ?? "http://localhost:3000",

  supabase: {
    url: () => required("SUPABASE_URL"),
    anonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  },

  openai: {
    apiKey: () => required("OPENAI_API_KEY"),
    priceInputPerMTok: () => optional("OPENAI_PRICE_GPT56_INPUT_PER_MTOK"),
    priceOutputPerMTok: () => optional("OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK"),
  },

  inngest: {
    eventKey: () => optional("INNGEST_EVENT_KEY"),
    signingKey: () => optional("INNGEST_SIGNING_KEY"),
  },

  whatsapp: {
    verifyToken: () => required("WHATSAPP_VERIFY_TOKEN"),
    appSecret: () => required("WHATSAPP_APP_SECRET"),
    accessToken: () => required("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: () => required("WHATSAPP_PHONE_NUMBER_ID"),
  },

  // Staged-cutover feature flags (default OFF = no behaviour change).
  flags: {
    rlsReads: () => process.env.RLS_READS === "on",
    rlsWrites: () => process.env.RLS_WRITES === "on",
    whatsappAsync: () => process.env.WHATSAPP_ASYNC === "on",
    spatialWorkspace: () => process.env.NEXT_PUBLIC_SPATIAL_WORKSPACE === "on",
    /**
     * Design lab — an isolated, development-only surface that renders the
     * Spatial Executive OS design system against clearly-labelled synthetic
     * fixtures, so the interface can be inspected in a real browser without a
     * database. It is refused outright when APP_ENV is production, regardless
     * of this flag, and it reads no business data of any kind.
     */
    designLab: () =>
      process.env.NEXT_PUBLIC_DESIGN_LAB === "on" &&
      (process.env.APP_ENV ?? "development") !== "production",
  },

  cronSecret: () => optional("CRON_SECRET"),
  databaseUrl: () => optional("DATABASE_URL"),
} as const;

/** Mandatory production security settings. Empty list = all present. */
export function missingProductionConfig(): string[] {
  const mandatory = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OPENAI_API_KEY", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "CRON_SECRET",
  ];
  return mandatory.filter((k) => !process.env[k]);
}

/** The isolation switches that must never be left to a default in production. */
export const ISOLATION_SETTINGS = ["RLS_READS", "RLS_WRITES"] as const;

/**
 * Problems with the database-isolation configuration. Empty list = safe to start.
 *
 * WHY THIS IS SEPARATE FROM `missingProductionConfig`. Those settings are absent-or-present:
 * a missing `WHATSAPP_APP_SECRET` breaks loudly the first time it is used. The isolation
 * switches are worse than that, because absence is INDISTINGUISHABLE FROM A DECISION. The
 * repository's convention is that a flag is on only when its value is exactly `"on"`, so an
 * unset `RLS_READS` silently means "read through the service-role client, bypassing RLS" — and
 * that is precisely the state production was found in on 2026-09-10 (finding H-2 /  PR-F-012):
 * both switches unset, company isolation resting on application code rather than the database,
 * with nothing anywhere saying so.
 *
 * So absence is refused. Either switch must be set EXPLICITLY to `on` or `off`. Choosing `off`
 * remains possible — the cutover to `on` is gated on the staging proof owner decision 5
 * requires — but it becomes a recorded decision that someone typed, not a default nobody saw.
 *
 * Returns human-readable problems rather than booleans because this text is what an operator
 * reads at 3am when the server refuses to boot.
 */
export function isolationConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const key of ISOLATION_SETTINGS) {
    const raw = env[key];
    if (raw === undefined || raw === "") {
      problems.push(
        `${key} is not set. It must be exactly "on" or "off". Unset means OFF — the app would ` +
          `read and write through the service-role client and database tenant isolation would ` +
          `not be enforced. Set it deliberately.`,
      );
      continue;
    }
    if (raw !== "on" && raw !== "off") {
      problems.push(
        `${key} is "${raw}", which is neither "on" nor "off". Any value other than "on" is ` +
          `treated as OFF, so a typo silently disables isolation. Use "on" or "off".`,
      );
    }
  }
  return problems;
}

/**
 * True when production is running with database isolation disabled by explicit choice.
 * Not an error — the staging proof gates the cutover — but it is worth saying out loud at boot.
 */
export function isolationDisabledDeliberately(env: NodeJS.ProcessEnv = process.env): boolean {
  return ISOLATION_SETTINGS.some((k) => env[k] === "off");
}

/**
 * Fail fast at server startup when a mandatory security setting is absent IN PRODUCTION.
 * A no-op in development/build so placeholder-only builds still succeed (nothing connects
 * at build time). Called from src/instrumentation.ts (Next's server boot hook).
 */
export function assertProductionConfig(): void {
  if ((process.env.APP_ENV ?? "development") !== "production") return;
  const missing = missingProductionConfig();
  if (missing.length) throw new Error(`Missing mandatory production config: ${missing.join(", ")}`);

  // Isolation is checked separately and refuses on ABSENCE, not just on an unsafe value.
  // See `isolationConfigProblems` for why a default is more dangerous here than elsewhere.
  const isolation = isolationConfigProblems();
  if (isolation.length) {
    throw new Error(
      "Refusing to start: database isolation is not configured explicitly.\n  - " +
        isolation.join("\n  - ") +
        "\nSee docs/release-1/DEPLOYMENT-READINESS.md (RLS cutover).",
    );
  }
}
