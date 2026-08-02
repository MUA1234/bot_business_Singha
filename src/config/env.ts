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
} as const;
