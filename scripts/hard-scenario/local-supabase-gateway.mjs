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
const POSTGREST = process.env.GATEWAY_POSTGREST ?? "http://127.0.0.1:55445";

const loopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);
for (const [name, u] of [["GOTRUE", GOTRUE], ["POSTGREST", POSTGREST]]) {
  if (!loopback(u)) {
    console.error(`refusing to start: ${name} upstream ${u} is not loopback`);
    process.exit(2);
  }
}

/** Path prefix -> upstream. Longest prefix wins. */
const ROUTES = [
  ["/auth/v1", GOTRUE],
  ["/rest/v1", POSTGREST],
];

const server = http.createServer((req, res) => {
  const route = ROUTES.find(([p]) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"));
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "no gateway route", path: req.url }));
    return;
  }
  const [prefix, upstream] = route;
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
  console.log(`local-supabase-gateway on http://127.0.0.1:${PORT}  auth->${GOTRUE}  rest->${POSTGREST}`);
});
