#!/usr/bin/env node
/**
 * Local Supabase-compatible gateway for the hard-scenario campaign.
 *
 * The application talks to Supabase through `@supabase/ssr` / `@supabase/supabase-js`,
 * which address ONE origin and split by path prefix:
 *   /auth/v1/*     -> GoTrue
 *   /rest/v1/*     -> PostgREST
 * A hosted project puts Kong in front of those two services to do exactly this. There is
 * no Supabase CLI here, so this stands in for Kong and NOTHING else.
 *
 * WHAT THIS IS NOT. It is not a substitute for any application API, and it does not
 * inspect, rewrite or fabricate a single response body. It rewrites the path prefix,
 * forwards the method, headers and body verbatim, and streams the upstream reply back.
 * Authentication is performed by REAL GoTrue and authorisation by REAL PostgREST + RLS,
 * so every scenario exercises the true trust boundary.
 *
 * Local only: it refuses to start if an upstream is not a loopback address.
 */
import http from "node:http";

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const GOTRUE = process.env.GATEWAY_GOTRUE ?? "http://127.0.0.1:55444";
/** PostgREST serving anon/authenticated traffic. Its login role cannot reach service_role. */
const REST_API = process.env.GATEWAY_POSTGREST ?? "http://127.0.0.1:55445";
/** PostgREST serving service-role traffic ONLY. Its login role has no api membership. */
const REST_SVC = process.env.GATEWAY_POSTGREST_SERVICE ?? "http://127.0.0.1:55446";

const loopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);
for (const [name, u] of [["GOTRUE", GOTRUE], ["REST_API", REST_API], ["REST_SVC", REST_SVC]]) {
  if (!loopback(u)) {
    console.error(`refusing to start: ${name} upstream ${u} is not loopback`);
    process.exit(2);
  }
}

/**
 * Which PostgREST should serve this request?
 *
 * A hosted Supabase project puts ONE `authenticator` login role behind Kong, and that role
 * holds anon, authenticated AND service_role — so a single `SET ROLE` from public API
 * traffic reaches full service authority. `found-006-caller-trust` calls that topology out
 * (OF-017) and fails while it is present.
 *
 * The harness therefore does what that test asks production to do: two login identities,
 * neither holding the other's memberships, and the service one serves no public traffic.
 * Routing is by the token's `role` claim, decided HERE rather than by the database, so the
 * api identity is never even connected to for a service-role request.
 *
 * The claim is read only to choose an upstream. It is NOT trusted for authorisation —
 * PostgREST still verifies the signature, and a forged claim simply lands on an instance
 * whose role cannot serve it.
 */
function isServiceRoleToken(headers) {
  const auth = headers.authorization || headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(auth));
  if (!m) return false;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims.role === "service_role";
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const matches = (p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?");
  let prefix = null;
  let upstream = null;
  if (matches("/auth/v1")) {
    prefix = "/auth/v1";
    upstream = GOTRUE;
  } else if (matches("/rest/v1")) {
    prefix = "/rest/v1";
    upstream = isServiceRoleToken(req.headers) ? REST_SVC : REST_API;
  }
  if (!prefix) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "no gateway route", path: req.url }));
    return;
  }
  const target = new URL(upstream);
  const rest = req.url.slice(prefix.length) || "/";

  // Forward headers verbatim except hop-by-hop and the rewritten host.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;

  const proxied = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: rest.startsWith("/") ? rest : "/" + rest,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "gateway upstream error", error: String(e) }));
  });
  req.pipe(proxied);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`local-supabase-gateway on http://127.0.0.1:${PORT}  auth->${GOTRUE}  rest(api)->${REST_API}  rest(service)->${REST_SVC}`);
});
