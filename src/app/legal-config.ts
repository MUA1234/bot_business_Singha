/**
 * Business identity shown on the public legal pages (privacy, terms, data deletion).
 *
 * IMPORTANT: these are the single source of truth for those pages. Review the values
 * and the page copy with a qualified legal adviser and replace the TODO placeholders
 * with your registered details BEFORE relying on them for production / Meta app review.
 */
export const LEGAL = {
  appName: "Singha Central",
  // TODO: replace with your registered legal company name.
  legalEntity: "Singha Holdings",
  // TODO: replace with a monitored business contact address.
  contactEmail: "lakanthi7@gmail.com",
  // The WhatsApp number users message. CORRECTED 2026-09-01: this read "+94 76 096 3935",
  // which is NOT the business number. It is rendered on the privacy, terms AND data-deletion
  // pages, so a user following our own deletion instructions would have messaged a stranger.
  // Env-overridable so a number change is configuration, not a code release.
  whatsappNumber: process.env.NEXT_PUBLIC_WHATSAPP_DISPLAY_NUMBER?.trim() || "+94 70 113 5556",
  jurisdiction: "Sri Lanka",
  dataProtectionLaw: "the Personal Data Protection Act, No. 9 of 2022 of Sri Lanka (PDPA)",
  // Follows wherever the app is actually deployed rather than naming one host; the app now
  // runs on Railway with Vercel still live, and a legal page must not cite a stale origin.
  websiteUrl: process.env.APP_BASE_URL?.trim() || "https://singha-web-production.up.railway.app",
  lastUpdated: "3 August 2026",
} as const;
