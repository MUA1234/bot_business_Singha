/**
 * Shared formatting helpers for dates, times and numbers. Centralised so the UI stays
 * consistent across departments and locales.
 */

const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const DATETIME_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

export function fmtDate(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString(undefined, DATE_OPTS);
}

export function fmtDateTime(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleString(undefined, DATETIME_OPTS);
}

export function fmtRelativeDays(input: string | Date | null | undefined, now: Date = new Date()): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return String(input);
  const diff = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1) return `in ${diff} days`;
  return `${Math.abs(diff)} days ago`;
}

export function fmtNumber(n: number | string | null | undefined, digits = 0): string {
  if (n == null || n === "") return "—";
  const num = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
