import { createPublicKey, verify } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fail } from "./domain";

export type AccessRole = "operator" | "reviewer";
export type CloudflareAccessConfig = { issuer: string; audience: string; rolesFile: string };
export type VerifiedAccessIdentity = { issuer: string; subject: string; email: string; expiresAt: number };
export type AccessFetch = (url: string, options: RequestInit) => Promise<Response>;
export type AccessDependencies = { fetch?: AccessFetch; now?: () => number };
const MAX_ROLES_BYTES = 64 * 1024;
const MAX_JWKS_BYTES = 128 * 1024;
const KEY_CACHE_MS = 5 * 60 * 1000;
const KEY_REFRESH_INTERVAL_MS = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 320) return;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}
export function validateAccessConfig(config: CloudflareAccessConfig): void {
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(config.issuer)) throw new Error("Cloudflare Access issuer must be an HTTPS team origin");
  if (typeof config.audience !== "string" || !config.audience.trim() || config.audience.length > 256 || /\s/.test(config.audience)) throw new Error("Cloudflare Access audience is required");
  if (typeof config.rolesFile !== "string" || !isAbsolute(config.rolesFile)) throw new Error("Cloudflare Access roles file must be an absolute path");
}
/** Array form preserves duplicate entries so normalized identity conflicts can be rejected. */
export function readAccessRoles(path: string): Map<string, AccessRole> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_ROLES_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_ROLES_BYTES) throw new Error("roles quota");
    const rows: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error("roles must be an array");
    const roles = new Map<string, AccessRole>();
    for (const row of rows) {
      const item = record(row); const email = normalizedEmail(item?.email); const role = item?.role;
      if (!item || !email || (role !== "operator" && role !== "reviewer") || Object.keys(item).some((key) => key !== "email" && key !== "role") || roles.has(email)) throw new Error("invalid or duplicate mapping");
      roles.set(email, role);
    }
    return roles;
  } catch {
    throw new Error("Cloudflare Access role mapping is unavailable or invalid");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function invalid(): never { fail(401, "access-invalid", "Cloudflare Access identity could not be verified"); }
function decodeObject(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) invalid();
  try {
    const result = record(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
    if (!result) invalid();
    return result;
  } catch { invalid(); }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("keys unavailable");
  if (Number(response.headers.get("content-length") ?? "0") > MAX_JWKS_BYTES) throw new Error("keys quota");
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_JWKS_BYTES) { await reader.cancel(); throw new Error("keys quota"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}
export function createAccessVerifier(config: CloudflareAccessConfig, dependencies: AccessDependencies = {}) {
  validateAccessConfig(config);
  const now = dependencies.now ?? Date.now;
  const fetchKeys = dependencies.fetch ?? fetch;
  let cache: { keys: Map<string, ReturnType<typeof createPublicKey>>; expiresAt: number } | undefined;
  let refresh: Promise<void> | undefined;
  let lastFetch = -Infinity;
  async function refreshKeys() {
    if (refresh) return refresh;
    lastFetch = now();
    refresh = (async () => {
      const response = await fetchKeys(`${config.issuer}/cdn-cgi/access/certs`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      const body = record(await boundedJson(response));
      if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 16) throw new Error("invalid keys");
      const keys = new Map<string, ReturnType<typeof createPublicKey>>();
      for (const raw of body.keys) {
        const key = record(raw);
        if (!key || key.kty !== "RSA" || typeof key.kid !== "string" || !key.kid || key.kid.length > 256 || typeof key.n !== "string" || typeof key.e !== "string" || (key.alg !== undefined && key.alg !== "RS256") || (key.use !== undefined && key.use !== "sig") || keys.has(key.kid)) throw new Error("invalid key");
        const imported = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
        if ((imported.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("weak key");
        keys.set(key.kid, imported);
      }
      cache = { keys, expiresAt: now() + KEY_CACHE_MS };
    })();
    try { await refresh; } finally { refresh = undefined; }
  }
  return {
    async verify(token: string | null): Promise<VerifiedAccessIdentity> {
      try {
        if (!token || token.length > 32 * 1024) invalid();
        const parts = token.split(".");
        if (parts.length !== 3) invalid();
        const [encodedHeader, encodedClaims, signature] = parts;
        if (!encodedHeader || !encodedClaims || !signature || !/^[A-Za-z0-9_-]+$/.test(signature)) invalid();
        const header = decodeObject(encodedHeader); const claims = decodeObject(encodedClaims);
        if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256 || header.crit !== undefined) invalid();
        if (!cache || cache.expiresAt <= now()) {
          if (now() - lastFetch < KEY_REFRESH_INTERVAL_MS && !refresh) invalid();
          await refreshKeys();
        } else if (!cache.keys.has(header.kid) && now() - lastFetch >= KEY_REFRESH_INTERVAL_MS) await refreshKeys();
        const key = cache?.keys.get(header.kid); if (!key || !cache || cache.expiresAt <= now()) invalid();
        if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, Buffer.from(signature, "base64url"))) invalid();
        const aud = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
        const email = normalizedEmail(claims.email);
        const epoch = now() / 1000;
        if (claims.iss !== config.issuer || !Array.isArray(aud) || !aud.every((entry) => typeof entry === "string") || !aud.includes(config.audience) || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= epoch || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > epoch)) || typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 512 || !email) invalid();
        return { issuer: config.issuer, subject: claims.sub, email, expiresAt: claims.exp * 1000 };
      } catch { invalid(); }
    },
  };
}
