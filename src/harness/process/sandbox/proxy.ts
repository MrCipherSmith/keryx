// Loopback network allowlist proxy (flow 098, v1.x network=restricted).
//
// The `network: "restricted"` sandbox posture denies all direct network from the
// contained process and forces its traffic through THIS proxy (loopback), which
// enforces a per-domain allowlist. HTTPS uses the standard `CONNECT` tunnel — the
// proxy checks the requested host and, if allowed, opens a blind TCP relay (no
// TLS termination / inspection by default, mirroring Claude Code). Plain HTTP is
// host-checked and forwarded.
//
// This module is the enforcement server only; wiring the sandbox to allow ONLY
// the loopback proxy socket + set HTTP(S)_PROXY is the launcher layer's job
// (seatbelt/bwrap). The proxy binds loopback and is created per run.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { unlinkSync } from "node:fs";
import { isPrivateOrReservedAddress } from "../../mutation/guard";
import type { RunCa } from "./tls-ca";

/** Canonical host form for comparison: lowercase, no trailing dot. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Match a host against an allowlist. Exact match, or a `*.example.com` wildcard
 * that covers the apex (`example.com`) and any subdomain. Case/trailing-dot
 * insensitive.
 */
export function matchesAllowlist(host: string, allowed: string[]): boolean {
  const h = normalizeHost(host);
  if (h.length === 0) {
    return false;
  }
  for (const pattern of allowed) {
    const p = normalizeHost(pattern);
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      if (base.length > 0 && (h === base || h.endsWith(`.${base}`))) {
        return true;
      }
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/** A single proxy decision, surfaced for audit/tests. */
export interface ProxyDecision {
  host: string;
  allowed: boolean;
  kind: "connect" | "http";
  /** Flow 301: the target port, when known. */
  port?: number;
  /** Flow 301: why a denial was refused (absent for an allow, or when `refuseReservedAddresses` is off). */
  reason?: string;
  /** Flow 301: ISO-8601, when this decision was made. */
  at?: string;
}

/** True when `host` is an IPv4 dotted-quad or an IPv6 literal — never a hostname. Domain names never contain a colon. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Default DNS resolver: one A/AAAA lookup through the OS resolver. */
async function defaultResolveHost(hostname: string): Promise<string | undefined> {
  try {
    const { address } = await dns.promises.lookup(hostname);
    return address;
  } catch {
    return undefined;
  }
}

/**
 * A credential to unmask on the wire. The contained process only ever sees
 * `sentinel`; the proxy substitutes `realValue` in the request headers of
 * requests to a host matching `injectHosts`.
 *
 * Applies to plaintext HTTP always, and to HTTPS ONLY when TLS termination is
 * enabled (`tlsTerminate`) — a blind `CONNECT` relay cannot rewrite encrypted
 * bytes, so without termination an HTTPS sentinel would leave the sandbox
 * unchanged (and fail auth).
 */
export interface CredentialMask {
  sentinel: string;
  realValue: string;
  injectHosts: string[];
}

export interface AllowlistProxyOptions {
  allowedDomains: string[];
  /** Bind host — loopback only. Default 127.0.0.1. Ignored when `unixSocketPath` is set. */
  host?: string;
  /** Bind port. Default 0 (ephemeral). Ignored when `unixSocketPath` is set. */
  port?: number;
  /**
   * Flow 301: bind a UNIX socket instead of TCP loopback. The unattended sandbox's
   * `--unshare-net` netns has only its own private `lo` — it cannot reach the host's
   * TCP loopback at all — so its proxy listens on a socket bind-mounted into the
   * sandbox instead (`src/harness/process/sandbox/unattended.ts`).
   */
  unixSocketPath?: string;
  /** Audit hook: called for every allow/deny decision. */
  onDecision?: (decision: ProxyDecision) => void;
  /** Credentials to unmask on outbound HTTP requests to their inject hosts. */
  masks?: CredentialMask[];
  /**
   * OPT-IN TLS termination (MITM). When set, an allowlisted `CONNECT` is
   * terminated with a leaf certificate issued by this run CA instead of being
   * blind-relayed, so request contents (and therefore credential masking) become
   * visible. The contained process must trust `ca.caCertPem` — delivered via CA
   * env vars, never the system trust store. Without this, HTTPS stays a blind
   * relay (the default).
   */
  tlsTerminate?: RunCa;
  /**
   * CA(s) used to verify the REAL upstream while terminating. Default: the
   * system trust store with `rejectUnauthorized: true`. Tests pass their own CA
   * so a local TLS upstream verifies.
   */
  upstreamCa?: string | string[];
  /**
   * Flow 301: harden the allowlist — refuse a bare IP-literal target outright, and
   * after resolving an allowed DOMAIN NAME, refuse a loopback/private/link-local/
   * CGNAT/unique-local/metadata resolved address (`isPrivateOrReservedAddress`).
   * The address that PASSED the check is then the address CONNECTED to — never a
   * fresh lookup — so a name that resolves public at check time and private on a
   * later (DNS-rebinding) lookup cannot slip through.
   *
   * Default false: the pre-flow-301 `network: "restricted"` posture (flow 098/142)
   * deliberately proxies to `localhost`/`127.0.0.1` test upstreams and would break
   * under this refusal — it stays exactly as it was unless a caller opts in.
   */
  refuseReservedAddresses?: boolean;
  /** Test seam for `refuseReservedAddresses`. Default: one OS `dns.lookup`. */
  resolveHost?: (hostname: string) => Promise<string | undefined>;
}

/**
 * Resolve `hostname` and return the address to connect to, or `undefined` to refuse:
 * an IP-literal target, a lookup failure, or a resolved loopback/private/link-local/
 * CGNAT/unique-local/metadata address. The caller connects to the RETURNED address —
 * never re-resolves — so this doubles as the DNS-rebinding pin (flow 301 AC4).
 */
async function checkedAddress(
  hostname: string,
  resolveHost: (h: string) => Promise<string | undefined>,
): Promise<{ address: string } | { reason: string }> {
  if (isIpLiteral(hostname)) return { reason: "IP-literal targets are refused — the allowlist is domains only" };
  const address = await resolveHost(hostname);
  if (address === undefined) return { reason: "could not be resolved" };
  if (isPrivateOrReservedAddress(address)) return { reason: `resolved to ${address}, a loopback/private/link-local/metadata address` };
  return { address };
}

/** Replace every mask's sentinel with its real value inside a header value. */
function substituteValue(value: string | string[] | undefined, masks: CredentialMask[]): string | string[] | undefined {
  if (value === undefined) return undefined;
  const one = (s: string): string => {
    let out = s;
    for (const m of masks) out = out.split(m.sentinel).join(m.realValue);
    return out;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/**
 * Return `headers` with each applicable mask's sentinel replaced by its real
 * value, for a request whose destination `hostname` matches the mask's
 * `injectHosts`. Non-applicable masks (or none) leave headers untouched.
 */
function applyMasks(
  headers: http.IncomingHttpHeaders,
  masks: CredentialMask[],
  hostname: string,
): http.IncomingHttpHeaders {
  const applicable = masks.filter((m) => matchesAllowlist(hostname, m.injectHosts));
  if (applicable.length === 0) return headers;
  const out: http.IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = substituteValue(value, applicable) as http.IncomingHttpHeaders[string];
  }
  return out;
}

export interface AllowlistProxy {
  host: string;
  port: number;
  /** Flow 301: set when `unixSocketPath` was requested — `host`/`port` are then meaningless (0). */
  unixSocketPath?: string;
  close: () => Promise<void>;
}

/** Parse the target host:port from a plain-HTTP proxied request. */
function httpTarget(req: http.IncomingMessage): { hostname: string; port: number } | undefined {
  // Proxied HTTP requests carry an absolute URL; fall back to the Host header.
  const raw = req.url ?? "";
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      return { hostname: u.hostname, port: u.port ? Number(u.port) : 80 };
    }
  } catch {
    // fall through to Host header
  }
  const hostHeader = req.headers.host;
  if (hostHeader) {
    const [hostname, port] = hostHeader.split(":");
    if (hostname) return { hostname, port: port ? Number(port) : 80 };
  }
  return undefined;
}

/** Create + start a loopback allowlist proxy. */
export async function createAllowlistProxy(opts: AllowlistProxyOptions): Promise<AllowlistProxy> {
  const host = opts.host ?? "127.0.0.1";
  const allowed = opts.allowedDomains;
  const hardened = opts.refuseReservedAddresses === true;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const decide = (d: Omit<ProxyDecision, "at">): boolean => {
    opts.onDecision?.({ ...d, at: new Date().toISOString() });
    return d.allowed;
  };

  const server = http.createServer((req, res) => {
    const target = httpTarget(req);
    const hostname = target?.hostname ?? "";
    const refuse = (reason?: string): void => {
      decide({ host: hostname, allowed: false, kind: "http", ...(target !== undefined ? { port: target.port } : {}), ...(reason !== undefined ? { reason } : {}) });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("blocked by keryx sandbox network allowlist");
    };
    if (!target || !matchesAllowlist(hostname, allowed)) {
      refuse(target ? "not on the allowlist" : "no target host");
      return;
    }
    const proceed = (connectHost: string): void => {
      decide({ host: hostname, allowed: true, kind: "http", port: target.port });
      const headers = applyMasks(req.headers, opts.masks ?? [], target.hostname);
      const upstream = http.request(
        { host: connectHost, port: target.port, method: req.method, path: pathFromUrl(req.url), headers: { ...headers, host: target.hostname } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("upstream error");
      });
      req.pipe(upstream);
    };
    if (!hardened) {
      proceed(target.hostname);
      return;
    }
    void checkedAddress(target.hostname, resolveHost).then((checked) => {
      if ("reason" in checked) refuse(checked.reason);
      else proceed(checked.address);
    });
  });

  // Decrypt-and-forward handler for terminated TLS connections: mask the request
  // and forward it to the real upstream over TLS (verified against the system
  // store, or `upstreamCa` when supplied).
  //
  // Bun constraints that shape this design:
  //   - `server.emit("connection", socket)` (Node's socket-injection trick) is
  //     NOT supported, so the decrypted stream is piped into a REAL loopback
  //     listener instead.
  //   - server-side `new tls.TLSSocket(sock, {isServer:true})` never completes a
  //     handshake, so termination uses a real `https.createServer`.
  //   - `SNICallback` is IGNORED, so we cannot serve every host from one TLS
  //     listener — instead one internal HTTPS listener is created PER TARGET with
  //     that host's leaf certificate, cached for the run.
  //
  // The handler is PINNED to the `CONNECT` target it was created for and
  // re-checks the in-tunnel `Host` header against the allowlist. Both matter:
  //   - Without the re-check, a contained process could `CONNECT` to an
  //     allowlisted host and then address an arbitrary destination inside the
  //     terminated tunnel — the allowlist would see only the allowed CONNECT.
  //   - Without the pin, each terminator is an open forward proxy on loopback
  //     for the duration of the run: anything that can reach its ephemeral port
  //     could relay through it to any allowlisted host.
  // Every in-tunnel request is reported through `decide`, so the audit trail
  // records the host actually addressed, not just the tunnel that carried it.
  const makeMitmHandler =
    (pinnedHost: string, pinnedPort: number) =>
    (req: http.IncomingMessage, res: http.ServerResponse): void => {
      const hostHeader = req.headers.host ?? "";
      const [rawHost, rawPort] = hostHeader.split(":");
      const hostname = rawHost ?? "";
      // An absent port in `Host` means the tunnel's own port, not a bare 443:
      // the request cannot go anywhere other than where the tunnel points.
      const upstreamPort = rawPort ? Number(rawPort) : pinnedPort;
      const permitted =
        matchesAllowlist(hostname, allowed) &&
        normalizeHost(hostname) === pinnedHost &&
        upstreamPort === pinnedPort;
      if (!decide({ host: hostname, allowed: permitted, kind: "http" })) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("blocked by keryx sandbox network allowlist");
        return;
      }
      const headers = applyMasks(req.headers, opts.masks ?? [], hostname);
      const upstreamReq = https.request(
        {
          host: hostname,
          port: upstreamPort,
          method: req.method,
          path: req.url ?? "/",
          headers,
          servername: hostname,
          ...(opts.upstreamCa !== undefined ? { ca: opts.upstreamCa } : {}),
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstreamReq.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("upstream error");
      });
      req.pipe(upstreamReq);
    };

  /** One internal HTTPS terminator per CONNECT target (Bun ignores SNICallback), cached. */
  const mitmServers = new Map<string, { server: https.Server; port: number }>();
  const mitmPortFor = async (hostname: string, targetPort: number, ca: RunCa): Promise<number> => {
    const host = normalizeHost(hostname);
    const key = `${host}:${targetPort}`;
    const hit = mitmServers.get(key);
    if (hit) return hit.port;
    const leaf = await ca.issueLeaf(host);
    const server = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      makeMitmHandler(host, targetPort),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    mitmServers.set(key, { server, port });
    return port;
  };

  server.on("connect", (req, clientSocket, head) => {
    const [reqHost, reqPort] = (req.url ?? "").split(":");
    const hostname = reqHost ?? "";
    const port = Number(reqPort) || 443;
    const refuse = (reason?: string): void => {
      decide({ host: hostname, allowed: false, kind: "connect", port, ...(reason !== undefined ? { reason } : {}) });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
    };
    if (!matchesAllowlist(hostname, allowed)) {
      refuse("not on the allowlist");
      return;
    }

    const proceed = (connectHost: string): void => {
      decide({ host: hostname, allowed: true, kind: "connect", port });

      // OPT-IN MITM: terminate TLS with a leaf for this host so contents (and
      // credential masking) are visible, instead of a blind byte relay.
      const ca = opts.tlsTerminate;
      if (ca) {
        void (async () => {
          try {
            const terminatorPort = await mitmPortFor(hostname, port, ca);
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            // The client now speaks TLS; hand the raw bytes to this host's
            // internal HTTPS terminator, which does the handshake and decrypts.
            const internal = net.connect(terminatorPort, "127.0.0.1", () => {
              if (head && head.length > 0) internal.write(head);
              clientSocket.pipe(internal);
              internal.pipe(clientSocket);
            });
            internal.on("error", () => clientSocket.destroy());
            clientSocket.on("error", () => internal.destroy());
          } catch {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            clientSocket.end();
          }
        })();
        return;
      }

      // Blind relay — connects to `connectHost` (the ADDRESS `checkedAddress`
      // just checked when hardened, never a fresh lookup: flow 301 AC4's
      // DNS-rebinding pin). Never terminated, so it cannot see SNI or an
      // in-tunnel Host — an inherent limit of a relay that inspects nothing.
      const upstream = net.connect(port, connectHost, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
      });
      clientSocket.on("error", () => upstream.destroy());
    };

    if (!hardened) {
      proceed(hostname);
      return;
    }
    void checkedAddress(hostname, resolveHost).then((checked) => {
      if ("reason" in checked) refuse(checked.reason);
      else proceed(checked.address);
    });
  });

  if (opts.unixSocketPath !== undefined) {
    // A stale socket file from a crashed prior run would otherwise fail `listen` with
    // EADDRINUSE — the run's scratch directory is per-run (flow 295's `agentTaskScratchParent`),
    // so removing whatever is there first is safe.
    try {
      unlinkSync(opts.unixSocketPath);
    } catch {
      // did not exist — fine
    }
    await new Promise<void>((resolve) => server.listen(opts.unixSocketPath, () => resolve()));
  } else {
    await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()));
  }
  const addr = server.address();
  const port = addr && typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    host,
    port,
    ...(opts.unixSocketPath !== undefined ? { unixSocketPath: opts.unixSocketPath } : {}),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Tear down every per-host TLS terminator created for this run.
      await Promise.all(
        [...mitmServers.values()].map(
          ({ server: s }) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
      mitmServers.clear();
    },
  };
}

/** Extract the path+query for the upstream request from a (possibly absolute) URL. */
function pathFromUrl(url: string | undefined): string {
  const raw = url ?? "/";
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      return `${u.pathname}${u.search}`;
    }
  } catch {
    // fall through
  }
  return raw;
}
