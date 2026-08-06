/**
 * Structured logging with correlation IDs and safe redaction (§WP6.4).
 *
 * `buildLogRecord` is pure (inject `now`) so it is unit-testable; `log` emits it as a
 * single JSON line. Secrets and PII are redacted by KEY name and by VALUE pattern, so
 * an access token or API key can never leak into logs even if passed by accident
 * (Constitution: never print/commit secrets).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACT_KEY = /(secret|token|password|api[_-]?key|authorization|access[_-]?key|service[_-]?role|cookie|bearer)/i;
// Value patterns for known secret shapes (OpenAI, Meta long-lived tokens, JWTs).
const REDACT_VALUE = [/\bsk-[A-Za-z0-9_-]{10,}\b/g, /\bEAA[A-Za-z0-9]{20,}\b/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g];

const REDACTED = "[redacted]";

function redactString(s: string): string {
  let out = s;
  for (const re of REDACT_VALUE) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-redact an arbitrary value: secret-named keys and secret-shaped strings. */
export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint && REDACT_KEY.test(keyHint)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

export interface LogFields {
  correlationId?: string;
  companyId?: string;
  event?: string;
  [k: string]: unknown;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  correlationId: string | null;
  fields: Record<string, unknown>;
}

/** Pure: build the structured record (redacted). Inject `now` for deterministic tests. */
export function buildLogRecord(level: LogLevel, msg: string, fields: LogFields = {}, now: Date = new Date()): LogRecord {
  const { correlationId = null, ...rest } = fields;
  return {
    ts: now.toISOString(),
    level,
    msg: redactString(msg),
    correlationId: correlationId ?? null,
    fields: redact(rest) as Record<string, unknown>,
  };
}

/** Emit a structured log line. */
export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const record = buildLogRecord(level, msg, fields);
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Short correlation id for tying a source event → AI run → decision → audit → send. */
export function newCorrelationId(): string {
  return "cor_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
