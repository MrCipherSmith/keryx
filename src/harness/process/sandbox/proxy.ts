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
import net from "node:net";

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

export interface AllowlistProxyOptions {
  allowedDomains: string[];
  /** Bind host — loopback only. Default 127.0.0.1. */
  host?: string;
  /** Bind port. Default 0 (ephemeral). */
  port?: number;
  /** Audit hook: called for every allow/deny decision. */
  onDecision?: (decision: ProxyDecision) => void;
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
    const upstream = http.request(
      { host: target.hostname, port: target.port, method: req.method, path: pathFromUrl(req.url), headers: req.headers },
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

  server.on("connect", (req, clientSocket, head) => {
    const [reqHost, reqPort] = (req.url ?? "").split(":");
    const hostname = reqHost ?? "";
    const port = Number(reqPort) || 443;
    if (!decide({ host: hostname, allowed: matchesAllowlist(hostname, allowed), kind: "connect" })) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
