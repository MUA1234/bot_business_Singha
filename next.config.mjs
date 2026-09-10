/** @type {import('next').NextConfig} */

// Content-Security-Policy. The browser never calls Supabase or any third party
// directly (all data access is server-side), so connect-src can stay 'self'.
// Inline styles/scripts are required by Next's hydration and the app's inline
// <style>/style={{}} usage, hence 'unsafe-inline' there. Everything else is locked
// down: no framing (anti-clickjacking), no plugins, no injected <base>, forms only
// to same origin.
/**
 * Is this deployment actually served over HTTPS?
 *
 * `upgrade-insecure-requests` and `Strict-Transport-Security` are correct and
 * required on a real HTTPS deployment, and actively BREAK a plain-HTTP origin:
 * the browser rewrites every same-origin navigation, prefetch and form post to
 * `https://`, which on `http://127.0.0.1:3000` fails with
 * ERR_SSL_PROTOCOL_ERROR. That made the application unusable end to end when
 * run locally, and it is why local browser verification could not follow a
 * sign-in redirect.
 *
 * The test is deliberately FAIL-SAFE: the headers are emitted unless this is
 * unambiguously a local, non-production, plain-HTTP deployment. A production
 * deployment that forgets to set APP_BASE_URL still gets them, because APP_ENV
 * alone is enough to switch them on.
 */
const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
const isProductionEnv = (process.env.APP_ENV ?? "development") === "production";
const httpsDeployment = isProductionEnv || baseUrl.startsWith("https://");

const cspDirectives = [
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
];
if (httpsDeployment) cspDirectives.push("upgrade-insecure-requests");
const csp = cspDirectives.join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  ...(httpsDeployment
    ? [
        // Force HTTPS for 2 years, including subdomains (protects the auth cookies).
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
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
