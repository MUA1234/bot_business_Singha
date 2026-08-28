/**
 * OUTBOUND NETWORK GUARD — hard-scenario campaign.
 *
 * Loaded with `node --require` so it is installed before any application code runs.
 *
 * WHY IT EXISTS. Provider credentials can reach a process from more places than the
 * command line — `.env.local`, a shell profile, an inherited parent environment. Setting
 * fake values covers the ones you remembered to set. This covers the ones you did not:
 * it makes the boundary a property of the PROCESS rather than of the configuration, so
 * "no real message, model call or payment can leave" does not depend on an env audit
 * being exhaustive.
 *
 * It fails CLOSED. Every outbound connection to a non-loopback address is refused with a
 * distinctive error, and the attempt is logged with host and port — never with headers,
 * bodies or credentials. A scenario that unexpectedly tries to reach a real provider
 * therefore fails loudly and identifiably instead of quietly succeeding.
 *
 * Loopback is allowed because the whole test stack (PostgREST, GoTrue, the gateway, the
 * mock provider server) lives there.
 */
const net = require("node:net");
const dns = require("node:dns");

const ALLOW_HOST = /^(127(\.\d+){3}|::1|::ffff:127(\.\d+){3}|localhost|0\.0\.0\.0)$/i;

class OutboundBlocked extends Error {
  constructor(target) {
    super(
      `HARD-SCENARIO NET GUARD: refused outbound connection to ${target}. ` +
        `The campaign runs fully offline; only loopback is permitted. ` +
        `If a scenario needs this, it needs a deterministic local mock, not the real provider.`,
    );
    this.code = "EHSTNETGUARD";
    this.name = "OutboundBlocked";
  }
}

const attempts = [];
function record(host, port) {
  attempts.push({ host, port, at: new Date().toISOString() });
  // Host and port only. Never headers, never bodies, never credentials.
  console.error(`[net-guard] BLOCKED outbound ${host}:${port}`);
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (options, ...rest) {
  let host;
  let port;
  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    host = options.host ?? options.hostname ?? "localhost";
    port = options.port;
    if (options.path) return origConnect.call(this, options, ...rest); // unix socket / named pipe
  } else {
    port = options;
    host = typeof rest[0] === "string" ? rest[0] : "localhost";
  }
  if (host && !ALLOW_HOST.test(String(host))) {
    record(String(host), port);
    const err = new OutboundBlocked(`${host}:${port}`);
    // Surface asynchronously as a socket error too, so http/undici callers see a normal failure.
    process.nextTick(() => this.emit("error", err));
    throw err;
  }
  return origConnect.call(this, options, ...rest);
};

// DNS is blocked as well, so a resolver-based egress cannot slip past the socket check.
const origLookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  const cb = args[args.length - 1];
  if (!ALLOW_HOST.test(String(hostname))) {
    record(String(hostname), "dns");
    const err = new OutboundBlocked(`${hostname} (dns)`);
    if (typeof cb === "function") return process.nextTick(() => cb(err));
    throw err;
  }
  return origLookup.call(dns, hostname, ...args);
};
if (dns.promises && dns.promises.lookup) {
  const origP = dns.promises.lookup;
  dns.promises.lookup = async function (hostname, ...a) {
    if (!ALLOW_HOST.test(String(hostname))) { record(String(hostname), "dns"); throw new OutboundBlocked(`${hostname} (dns)`); }
    return origP.call(dns.promises, hostname, ...a);
  };
}

globalThis.__HST_NET_GUARD__ = { active: true, attempts };
console.error("[net-guard] active — loopback only, outbound fails closed");
