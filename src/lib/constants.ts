/** Cross-cutting constants for the app layer. */

/** Pilot company seeded in migration 0007. Single-company pilot. */
export const DEFAULT_COMPANY_ID = "00000000-0000-0000-0000-00000000515a";

/**
 * Employees log in with a username; Supabase Auth is email-based, so we map
 * <username>@singha.local ↔ the account. The domain is internal and never shown.
 */
export const USERNAME_EMAIL_DOMAIN = "singha.local";

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;
}

export function emailToUsername(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

/** Basic username policy: lowercase letters, digits, dot, dash, underscore. */
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
