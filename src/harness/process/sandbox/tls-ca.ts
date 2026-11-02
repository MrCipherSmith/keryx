// Ephemeral run CA + on-demand leaf certificates (flow 102, slice 1).
//
// TLS-terminate needs a certificate authority whose leaf certs the contained
// process will trust (via CA env vars, never the system trust store). Node/Bun
// `crypto` can PARSE X.509 but cannot ISSUE certificates, so issuance shells out
// to the system `openssl` binary — the same "system binary, no npm dependency"
// pattern as `sandbox-exec` / `bwrap` (keeps `dependencies: {}`).
//
// Extensions are passed via a generated CONFIG FILE rather than `-addext`,
// because macOS ships LibreSSL (3.3.x) which does not support `-addext` on
// `req`. The config form works on both LibreSSL and OpenSSL 3.
//
// SECURITY: the CA private key is an ephemeral, per-run secret. It lives in a
// 0700 temp directory that `dispose()` removes; it is never logged and never
// leaves the process that created it.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Leaves kept per run: the same size class as the proxy's 64 live terminators
 * (`MAX_TERMINATORS`). Unbounded, every distinct host a wildcard allowlist let
 * a contained command reach stayed resident (about 3 KB each) for the whole run.
 * Least recently used goes first; an evicted host is simply issued again.
 */
export const MAX_CACHED_LEAVES = 64;

/**
 * Concurrent `openssl` issuances (two processes each). 100 distinct hosts at
 * once used to start 100 issuances, 58 of them running openssl together.
 */
export const MAX_CONCURRENT_ISSUANCES = 4;

/** Issued key material for one host. */
export interface LeafCertificate {
  certPem: string;
  keyPem: string;
}

export interface RunCa {
  /** PEM of the run CA certificate (safe to expose to the contained process). */
  caCertPem: string;
  /** Issue (or return the cached) leaf certificate for `host`. */
  issueLeaf(host: string): Promise<LeafCertificate>;
  /** Remove all on-disk key material for this run. */
  dispose(): Promise<void>;
}

export interface CreateRunCaOptions {
  /** Path to the openssl binary. Default `openssl` (resolved via PATH). */
  openssl?: string;
  /** Parent directory for the ephemeral CA workspace. Default os tmpdir. */
  tmpDir?: string;
  /** Certificate lifetime in days. Default 1 (ephemeral, per run). */
  days?: number;
}

/** Run a command, resolving with stdout; rejects with stderr on non-zero exit. */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} ${args[0]} failed (exit ${code}): ${err.trim()}`)),
    );
  });
}

/** A random positive 128-bit certificate serial, as the `0x…` form `x509 -set_serial` takes. */
function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f; // keep it positive
  bytes[15] = (bytes[15] ?? 0) | 0x01; // and non-zero
  return `0x${bytes.toString("hex")}`;
}

/** openssl config enabling a CA cert (basicConstraints CA:TRUE). */
const CA_CONFIG = `[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = keryx sandbox run CA

[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

/** openssl config for a leaf CSR + its SAN extension, bound to `host`. */
function leafConfig(host: string): string {
  // An IP SAN must be `IP:`; anything else is a DNS name.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const san = isIp ? `IP:${host}` : `DNS:${host}`;
  return `[req]
distinguished_name = dn
req_extensions = v3_req
prompt = no

[dn]
CN = ${host}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${san}
`;
}

/**
 * Create an ephemeral run CA and a per-host leaf issuer. All key material lives
 * under a private temp directory removed by {@link RunCa.dispose}.
 */
export async function createRunCa(options: CreateRunCaOptions = {}): Promise<RunCa> {
  const openssl = options.openssl ?? "openssl";
  const days = String(options.days ?? 1);
  const root = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), "keryx-ca-"));
  await mkdir(root, { recursive: true, mode: 0o700 });

  const caKey = path.join(root, "ca.key");
  const caCert = path.join(root, "ca.crt");
  const caCfg = path.join(root, "ca.cnf");
  await writeFile(caCfg, CA_CONFIG, { mode: 0o600 });

  // Self-signed CA: key + cert in one `req -x509` invocation.
  await run(openssl, [
    "req", "-x509", "-nodes",
    "-newkey", "rsa:2048",
    "-keyout", caKey,
    "-out", caCert,
    "-days", days,
    "-config", caCfg,
  ]);

  const caCertPem = await readFile(caCert, "utf8");
  const cache = new Map<string, LeafCertificate>();
  // In-flight issuances, keyed like `cache`: concurrent callers for one host share ONE
  // issuance (and so one key/cert pair) instead of racing over the same files. An entry
  // is dropped on rejection so a transient openssl failure can be retried.
  const inflight = new Map<string, Promise<LeafCertificate>>();

  // A counting semaphore over `issue`: at most MAX_CONCURRENT_ISSUANCES run, the rest wait in order.
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (running < MAX_CONCURRENT_ISSUANCES) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight over: `running` is unchanged
    else running -= 1;
  };
  const issueLimited = async (key: string): Promise<LeafCertificate> => {
    await acquire();
    try {
      return await issue(key);
    } finally {
      release();
    }
  };

  const issue = async (key: string): Promise<LeafCertificate> => {
    // A private working directory per issuance: two issuances (even for the same host
    // after a rejection) never share a key/CSR/cert/config file name.
    const work = await mkdtemp(path.join(root, "leaf-"));
    try {
      const leafKey = path.join(work, "leaf.key");
      const leafCsr = path.join(work, "leaf.csr");
      const leafCrt = path.join(work, "leaf.crt");
      const leafCfg = path.join(work, "leaf.cnf");
      await writeFile(leafCfg, leafConfig(key), { mode: 0o600 });

      await run(openssl, [
        "req", "-new", "-nodes",
        "-newkey", "rsa:2048",
        "-keyout", leafKey,
        "-out", leafCsr,
        "-config", leafCfg,
      ]);
      // An explicit random serial instead of `-CAcreateserial`: that rewrites the one
      // shared `ca.srl`, which concurrent issuances for different hosts would race on.
      await run(openssl, [
        "x509", "-req",
        "-in", leafCsr,
        "-CA", caCert,
        "-CAkey", caKey,
        "-set_serial", randomSerial(),
        "-out", leafCrt,
        "-days", days,
        "-extfile", leafCfg,
        "-extensions", "v3_req",
      ]);

      return {
        certPem: await readFile(leafCrt, "utf8"),
        keyPem: await readFile(leafKey, "utf8"),
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };

  return {
    caCertPem,
    issueLeaf(host: string): Promise<LeafCertificate> {
      const key = host.toLowerCase();
      const hit = cache.get(key);
      if (hit) {
        // Refresh recency: a Map iterates in insertion order, so re-inserting makes this the newest.
        cache.delete(key);
        cache.set(key, hit);
        return Promise.resolve(hit);
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const started = issueLimited(key).then(
        (issued) => {
          cache.set(key, issued);
          while (cache.size > MAX_CACHED_LEAVES) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          inflight.delete(key);
          return issued;
        },
        (error: unknown) => {
          inflight.delete(key);
          throw error;
        },
      );
      inflight.set(key, started);
      return started;
    },
    async dispose(): Promise<void> {
      cache.clear();
      inflight.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}
