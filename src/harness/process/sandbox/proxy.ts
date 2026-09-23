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
import { isPrivateOrReservedAddress, looksLikeIpHost } from "../../mutation/guard";
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

/**
 * Flow 301 (F1): strictly parse a TCP port — digits only, no sign, no whitespace,
 * no trailing junk, 1-65535 — or `undefined` for anything else. A client-controlled
 * port string (a CONNECT authority, a Host header) is NEVER handed to `Number()`
 * and then straight to `net.connect`/`http.request`: an out-of-range value there
 * throws a SYNCHRONOUS `ERR_SOCKET_BAD_PORT` that nothing in this file caught,
 * crashing the whole dispatcher process (confirmed: `nc`-ing a `CONNECT
 * allowed.test:-1` request killed it and leaked the run's scratch tree, because
 * the crash skipped every `finally`). This is the one place a port string becomes
 * a number; every call site below uses it and refuses rather than parses again.
 */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Flow 301 (F2): is `port` reachable for a request of this `kind`, given the
 * grant's `allowedPorts`? Absent `allowedPorts` (not hardened, or a hardened run
 * that named none) falls back to the historical default: 443 for `connect`
 * (HTTPS), 80 for `http` (plain) — the allowlist restricts host AND port, not
 * "any port on an allowed host". A non-empty `allowedPorts` REPLACES that default
 * for both kinds at once (the grant's `ports` field applies to every listed
 * domain, for whichever kind of request reaches it).
 */
function portAllowed(port: number, kind: "http" | "connect", allowedPorts: readonly number[] | undefined): boolean {
  if (allowedPorts !== undefined && allowedPorts.length > 0) return allowedPorts.includes(port);
  return kind === "connect" ? port === 443 : port === 80;
}

/**
 * Flow 301 (F1 defence-in-depth): run a synchronous call that MIGHT throw on
 * client-controlled input (a malformed port/host that somehow reaches
 * `net.connect`/`http.request`/`https.request` despite the strict checks above —
 * for instance a Node/Bun version whose validation differs) and report failure
 * through `onError` instead of letting the exception escape a request handler
 * and crash the whole dispatcher process. Every constructor call below goes
 * through this, not only the ones the strict port parser already protects.
 */
function trySync<T>(make: () => T, onError: () => void): T | undefined {
  try {
    return make();
  } catch {
    onError();
    return undefined;
  }
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
  /**
   * Flow 301 (F2): restrict every allowed domain to these ports, for BOTH plain HTTP
   * and `CONNECT` — "the allowlist is domains only" otherwise means every port on an
   * allowed host is reachable, not just the API endpoint the grant intended. A
   * non-empty list here is enforced on its own — it is an explicit instruction —
   * even without `refuseReservedAddresses`; the DEFAULT restriction (443 for
   * `CONNECT`, 80 for plain HTTP, when this is absent/empty) is enforced only when
   * `refuseReservedAddresses` is on, so the pre-flow-301 `network: "restricted"`
   * posture (flow 098/142, arbitrary test-upstream ports, neither option set) is
   * unaffected.
   */
  allowedPorts?: readonly number[];
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
  // Flow 301 (F3): `looksLikeIpHost` catches more than a strict dotted-quad — inet_aton
  // short/mixed-radix forms (`127.1`), flat encoded integers, and a numeric final
  // label — every shape that let an IP slip past the original, narrower check.
  if (looksLikeIpHost(hostname)) return { reason: "IP-literal targets are refused — the allowlist is domains only" };
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

/**
 * Flow 301 (F1): the target host/port from a plain-HTTP proxied request, or WHY
 * there is none — `"no-target"` (no absolute URL and no Host header) is a
 * different finding from `"invalid-port"` (a port present but not 1-65535 digits),
 * and the caller reports each with its own reason rather than a single silent
 * `undefined`. Never returns a `port` that was not parsed by {@link parsePort}, so
 * nothing downstream can hand an unchecked value to `http.request`.
 */
type HttpTarget =
  | { readonly kind: "ok"; readonly hostname: string; readonly port: number }
  | { readonly kind: "invalid-port"; readonly hostname: string }
  | { readonly kind: "no-target" };

function httpTarget(req: http.IncomingMessage): HttpTarget {
  // Proxied HTTP requests carry an absolute URL; fall back to the Host header.
  const raw = req.url ?? "";
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      if (u.hostname.length === 0) return { kind: "no-target" };
      if (u.port.length === 0) return { kind: "ok", hostname: u.hostname, port: 80 };
      const port = parsePort(u.port);
      return port === undefined ? { kind: "invalid-port", hostname: u.hostname } : { kind: "ok", hostname: u.hostname, port };
    }
  } catch {
    // fall through to Host header
  }
  const hostHeader = req.headers.host;
  if (hostHeader !== undefined && hostHeader.length > 0) {
    const colon = hostHeader.lastIndexOf(":");
    const hostname = colon === -1 ? hostHeader : hostHeader.slice(0, colon);
    const portRaw = colon === -1 ? undefined : hostHeader.slice(colon + 1);
    if (hostname.length === 0) return { kind: "no-target" };
    if (portRaw === undefined || portRaw.length === 0) return { kind: "ok", hostname, port: 80 };
    const port = parsePort(portRaw);
    return port === undefined ? { kind: "invalid-port", hostname } : { kind: "ok", hostname, port };
  }
  return { kind: "no-target" };
}

/** Create + start a loopback allowlist proxy. */
export async function createAllowlistProxy(opts: AllowlistProxyOptions): Promise<AllowlistProxy> {
  const host = opts.host ?? "127.0.0.1";
  const allowed = opts.allowedDomains;
  const hardened = opts.refuseReservedAddresses === true;
  // F2: the default port restriction (443/80) is part of the SAME opt-in hardening
  // as `refuseReservedAddresses` (flow-098's existing tests use arbitrary ports and
  // must stay unaffected) — but an explicit, non-empty `allowedPorts` is an
  // unambiguous instruction on its own, so it is enforced even when a caller has
  // not also turned on address hardening.
  const portRestricted = hardened || (opts.allowedPorts !== undefined && opts.allowedPorts.length > 0);
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const decide = (d: Omit<ProxyDecision, "at">): boolean => {
    opts.onDecision?.({ ...d, at: new Date().toISOString() });
    return d.allowed;
  };

  const server = http.createServer((req, res) => {
    const target = httpTarget(req);
    const hostname = target.kind === "no-target" ? "" : target.hostname;
    const refuse = (reason: string): void => {
      decide({ host: hostname, allowed: false, kind: "http", ...(target.kind === "ok" ? { port: target.port } : {}), reason });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("blocked by keryx sandbox network allowlist");
    };
    if (target.kind === "no-target") {
      refuse("no target host");
      return;
    }
    if (target.kind === "invalid-port") {
      // F1: a malformed port (`-1`, `99999`, non-digits) is refused here, strictly
      // parsed by {@link parsePort} — never handed to `http.request`, which throws
      // synchronously (uncaught) on an out-of-range port.
      refuse("invalid port");
      return;
    }
    if (!matchesAllowlist(hostname, allowed)) {
      refuse("not on the allowlist");
      return;
    }
    // F2: host allowed does not mean every port on it is — 80 by default, or the
    // grant's own `ports` list when the caller (the unattended allowlist) set one.
    if (portRestricted && !portAllowed(target.port, "http", opts.allowedPorts)) {
      refuse(`port ${target.port} is not allowed`);
      return;
    }
    const proceed = (connectHost: string): void => {
      decide({ host: hostname, allowed: true, kind: "http", port: target.port });
      const headers = applyMasks(req.headers, opts.masks ?? [], target.hostname);
      // F1 defence-in-depth: `target.port` is already strictly parsed above, but
      // wrap the call anyway — nothing client-controlled may throw synchronously in
      // a request handler and crash the whole dispatcher.
      const upstream = trySync(
        () =>
          http.request(
            { host: connectHost, port: target.port, method: req.method, path: pathFromUrl(req.url), headers: { ...headers, host: target.hostname } },
            (up) => {
              res.writeHead(up.statusCode ?? 502, up.headers);
              up.pipe(res);
            },
          ),
        () => {
          if (!res.headersSent) res.writeHead(502);
          res.end("upstream error");
        },
      );
      if (upstream === undefined) return;
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
      const colon = hostHeader.lastIndexOf(":");
      const hostname = colon === -1 ? hostHeader : hostHeader.slice(0, colon);
      const rawPort = colon === -1 ? undefined : hostHeader.slice(colon + 1);
      // F1: strictly parsed — never `Number(rawPort)` straight into `https.request`,
      // which throws synchronously on an out-of-range port. An absent port in `Host`
      // means the tunnel's own port, not a bare 443: the request cannot go anywhere
      // other than where the tunnel points. A malformed port simply cannot equal
      // `pinnedPort` (a known-good number), so it falls out of `permitted` below —
      // strict parsing here is about an accurate decision record, not just safety.
      const upstreamPort = rawPort === undefined || rawPort.length === 0 ? pinnedPort : parsePort(rawPort);
      const permitted =
        upstreamPort !== undefined &&
        matchesAllowlist(hostname, allowed) &&
        normalizeHost(hostname) === pinnedHost &&
        upstreamPort === pinnedPort;
      if (!decide({ host: hostname, allowed: permitted, kind: "http", ...(upstreamPort !== undefined ? { port: upstreamPort } : {}) })) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("blocked by keryx sandbox network allowlist");
        return;
      }
      const headers = applyMasks(req.headers, opts.masks ?? [], hostname);
      const upstreamReq = trySync(
        () =>
          https.request(
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
          ),
        () => {
          if (!res.headersSent) res.writeHead(502);
          res.end("upstream error");
        },
      );
      if (upstreamReq === undefined) return;
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
    const url = req.url ?? "";
    const colon = url.lastIndexOf(":");
    const hostname = colon === -1 ? url : url.slice(0, colon);
    const portRaw = colon === -1 ? undefined : url.slice(colon + 1);
    // F1: strictly parsed (digits only, 1-65535) — the original `Number(reqPort) ||
    // 443` handed `-1`/`99999`/garbage straight to `net.connect`, which throws
    // SYNCHRONOUSLY and UNCAUGHT on an out-of-range port (`ERR_SOCKET_BAD_PORT`).
    // Confirmed from inside a real sandbox: a single crafted `CONNECT
    // allowed.test:-1` killed the whole dispatcher process, and because the crash
    // skipped every `finally`, the run's socket and scratch tree leaked with it.
    const parsedPort = portRaw === undefined || portRaw.length === 0 ? 443 : parsePort(portRaw);
    const refuse = (reason: string): void => {
      decide({ host: hostname, allowed: false, kind: "connect", ...(parsedPort !== undefined ? { port: parsedPort } : {}), reason });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
    };
    if (parsedPort === undefined) {
      refuse("invalid port");
      return;
    }
    const port = parsedPort;
    if (!matchesAllowlist(hostname, allowed)) {
      refuse("not on the allowlist");
      return;
    }
    // F2: host allowed does not mean every port on it is — 443 by default, or the
    // grant's own `ports` list when the caller (the unattended allowlist) set one.
    if (portRestricted && !portAllowed(port, "connect", opts.allowedPorts)) {
      refuse(`port ${port} is not allowed`);
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
            // `terminatorPort` is this process's OWN ephemeral listen port, never
            // client-controlled, but the whole branch is inside this try anyway.
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
      // F1 defence-in-depth: `port` is already strictly parsed above, but wrap the
      // call anyway — nothing client-controlled may throw synchronously here.
      const onUpstreamConnect = (upstream: net.Socket): void => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      };
      const onUpstreamFailure = (): void => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
      };
      const upstream = trySync(() => net.connect(port, connectHost), onUpstreamFailure);
      if (upstream === undefined) return;
      upstream.once("connect", () => onUpstreamConnect(upstream));
      upstream.on("error", onUpstreamFailure);
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
