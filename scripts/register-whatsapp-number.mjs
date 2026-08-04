/**
 * One-off: register a phone number on the WhatsApp Cloud API.
 *
 * Meta requires a /register call before a Cloud-API number can send/receive or
 * have its two-step PIN set. This performs that call. It reads WHATSAPP_ACCESS_TOKEN
 * from .env.local so the secret is never passed on the command line or printed.
 *
 * Usage:
 *   node scripts/register-whatsapp-number.mjs <PHONE_NUMBER_ID> <6_DIGIT_PIN>
 *
 * Get <PHONE_NUMBER_ID>: WhatsApp Manager → Phone numbers → click the number →
 * copy "Phone number ID". Choose any NEW 6-digit PIN and keep a note of it.
 */
import { readFileSync } from "node:fs";

const GRAPH_VERSION = "v20.0"; // matches src/lib/whatsapp.ts

// Minimal .env.local loader (no dependency). Only sets vars not already in env.
function loadEnvLocal(path = ".env.local") {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${path} — run this from the project root.`);
    process.exit(1);
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

loadEnvLocal();

const [, , phoneNumberId, pin] = process.argv;
if (!phoneNumberId || !/^\d{6}$/.test(pin ?? "")) {
  console.error("Usage: node scripts/register-whatsapp-number.mjs <PHONE_NUMBER_ID> <6_DIGIT_PIN>");
  process.exit(1);
}

const token = process.env.WHATSAPP_ACCESS_TOKEN;
if (!token) {
  console.error("WHATSAPP_ACCESS_TOKEN is not set in .env.local.");
  process.exit(1);
}

const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/register`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ messaging_product: "whatsapp", pin }),
});

const body = await res.json().catch(() => ({}));
console.log("HTTP", res.status);
console.log(JSON.stringify(body, null, 2));

if (res.ok && body?.success === true) {
  console.log(`\n✅ Registered on the Cloud API. Your two-step PIN is now: ${pin}`);
  console.log("   Next: the number should show 'Connected' in WhatsApp Manager.");
} else {
  const msg = body?.error?.message ?? `HTTP ${res.status}`;
  console.log(`\n⚠️  Not registered: ${msg}`);
  if (body?.error?.code === 190 || /token/i.test(msg)) {
    console.log("   → Your access token looks expired/invalid. Generate a fresh one and");
    console.log("     update WHATSAPP_ACCESS_TOKEN in .env.local, then re-run.");
  }
}
