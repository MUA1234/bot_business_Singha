/** Cross-cutting constants for the app layer. */

/*
 * DEFAULT_COMPANY_ID was removed (FOUND-003). A hardcoded company constant is not a placeholder in
 * a multi-company system — it silently attributes every business's inbound messages, conversations
 * and quotations to one company. The receiving account now decides the company
 * (`resolve_channel_company`, migration 0074), and an account that cannot be attributed is not
 * processed at all. The pilot company row itself still exists; it is seeded by migration 0007.
 */

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
