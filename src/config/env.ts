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

/**
 * Fail fast at server startup when a mandatory security setting is absent IN PRODUCTION.
 * A no-op in development/build so placeholder-only builds still succeed (nothing connects
 * at build time). Called from src/instrumentation.ts (Next's server boot hook).
 */
export function assertProductionConfig(): void {
  if ((process.env.APP_ENV ?? "development") !== "production") return;
  const missing = missingProductionConfig();
  if (missing.length) throw new Error(`Missing mandatory production config: ${missing.join(", ")}`);
}
