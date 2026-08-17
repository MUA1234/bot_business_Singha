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
  // The WhatsApp number users message.
  whatsappNumber: "+94 76 096 3935",
  jurisdiction: "Sri Lanka",
  dataProtectionLaw: "the Personal Data Protection Act, No. 9 of 2022 of Sri Lanka (PDPA)",
  websiteUrl: "https://bot-business-singha.vercel.app",
  lastUpdated: "3 August 2026",
} as const;
