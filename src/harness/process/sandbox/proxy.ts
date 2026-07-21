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
import tls from "node:tls";
import type { RunCa } from "./tls-ca";

/**
 * Match a host against an allowlist. Exact match, or a `*.example.com` wildcard
 * that covers the apex (`example.com`) and any subdomain. Case/trailing-dot
 * insensitive.
 */
export function matchesAllowlist(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.length === 0) {
    return false;
  }
  for (const pattern of allowed) {
    const p = pattern.toLowerCase().replace(/\.$/, "");
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
}

/**
 * A credential to unmask on the wire. The contained process only ever sees
 * `sentinel`; the proxy substitutes `realValue` in the request headers of
 * plaintext HTTP requests to a host matching `injectHosts`. NOTE: substitution
 * is HTTP-only — HTTPS goes through the blind `CONNECT` relay (no TLS
 * termination), so masking does not apply to it in v1.x.
 */
export interface CredentialMask {
  sentinel: string;
  realValue: string;
  injectHosts: string[];
}

export interface AllowlistProxyOptions {
  allowedDomains: string[];
  /** Bind host — loopback only. Default 127.0.0.1. */
  host?: string;
  /** Bind port. Default 0 (ephemeral). */
  port?: number;
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
  const decide = (d: ProxyDecision): boolean => {
    opts.onDecision?.(d);
    return d.allowed;
  };

  const server = http.createServer((req, res) => {
    const target = httpTarget(req);
    const hostname = target?.hostname ?? "";
    if (!target || !decide({ host: hostname, allowed: matchesAllowlist(hostname, allowed), kind: "http" })) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("blocked by keryx sandbox network allowlist");
      return;
    }
    const headers = applyMasks(req.headers, opts.masks ?? [], target.hostname);
    const upstream = http.request(
      { host: target.hostname, port: target.port, method: req.method, path: pathFromUrl(req.url), headers },
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
  //     listener — instead one internal HTTPS listener is created PER HOST with
  //     that host's leaf certificate, cached for the run.
  const mitmHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const hostHeader = req.headers.host ?? "";
    const [rawHost, rawPort] = hostHeader.split(":");
    const hostname = rawHost ?? "";
    const upstreamPort = Number(rawPort) || 443;
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

  /** One internal HTTPS terminator per host (Bun ignores SNICallback), cached. */
  const mitmServers = new Map<string, { server: https.Server; port: number }>();
  const mitmPortFor = async (hostname: string, ca: RunCa): Promise<number> => {
    const key = hostname.toLowerCase();
    const hit = mitmServers.get(key);
    if (hit) return hit.port;
    const leaf = await ca.issueLeaf(key);
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, mitmHandler);
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
    if (!decide({ host: hostname, allowed: matchesAllowlist(hostname, allowed), kind: "connect" })) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }

    // OPT-IN MITM: terminate TLS with a leaf for this host so contents (and
    // credential masking) are visible, instead of a blind byte relay.
    const ca = opts.tlsTerminate;
    if (ca) {
      void (async () => {
        try {
          const terminatorPort = await mitmPortFor(hostname, ca);
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

    const upstream = net.connect(port, hostname, () => {
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
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    host,
    port,
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
