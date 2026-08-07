/** @type {import('next').NextConfig} */

// Content-Security-Policy. The browser never calls Supabase or any third party
// directly (all data access is server-side), so connect-src can stay 'self'.
// Inline styles/scripts are required by Next's hydration and the app's inline
// <style>/style={{}} usage, hence 'unsafe-inline' there. Everything else is locked
// down: no framing (anti-clickjacking), no plugins, no injected <base>, forms only
// to same origin.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Force HTTPS for 2 years, including subdomains (protects the auth cookies).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig = {
  reactStrictMode: true,
  // Run src/instrumentation.ts on server boot (production config fail-fast, §11).
  experimental: { instrumentationHook: true },
  // Don't advertise the framework/version to attackers.
  poweredByHeader: false,
  // Linting runs in CI (.github/workflows/ci.yml), not during the Vercel build —
  // this silences the "ESLint must be installed" build warning. Type errors still fail.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
