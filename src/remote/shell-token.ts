// The local shell token (flow 376, block 2).
//
// A second secret, separate from the serve bearer. A running shell holds it to
// reach `/v1/remote/*` on the listener of the SAME machine and nothing else; a
// serve bearer reaches every other route and not these. Neither grants the other.
//
// Lifecycle: `keryx serve` mints a FRESH token on every start (32 random bytes,
// mode 600, in `<user-global dir>/remote/`) and replaces the file atomically, so a
// reader sees the old token or the new one, never a half-written file. A token
// that leaked, or that belonged to a serve that died, therefore stops working the
// next time a serve starts. Shells re-read the file on every request and every
// reconnect, so they follow the rotation without doing anything. The token is
// never logged and never appears in an error message.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { constantTimeEqual } from "../lib/serve-credential";
import type { Loaded } from "./config";
import { ensureRemoteDir, remoteDirPath } from "./paths";

export const SHELL_TOKEN_FILE = "shell-token";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export function shellTokenPath(dir?: string): string {
  return path.join(remoteDirPath(dir), SHELL_TOKEN_FILE);
}

function readValidated(file: string): Loaded<string> {
  if (process.platform !== "win32") {
    try {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return { ok: false, reason: `shell token file ${file} is accessible to other users (mode ${mode.toString(8)}); run: chmod 600 ${file}` };
      }
    } catch {
      return { ok: false, reason: `no shell token at ${file}; is \`keryx serve\` running with remote control configured?` };
    }
  }
  const read = readConfigFile(file);
  if (!read.ok) {
    return { ok: false, reason: read.reason === "absent" ? `no shell token at ${file}; is \`keryx serve\` running with remote control configured?` : `shell token file ${file} cannot be read (${read.reason})` };
  }
  const token = read.text.trim();
  if (!TOKEN_SHAPE.test(token)) {
    // Not echoed: a malformed file may still hold something secret.
    return { ok: false, reason: `shell token file ${file} does not hold a shell token; delete it and restart \`keryx serve\`` };
  }
  return { ok: true, value: token };
}

/**
 * Serve side: mint a new token and replace the file with it, whatever was there.
 * Call it only once this serve owns the poller lock, so a second serve that is
 * about to be refused cannot rotate the token under the one that is running.
 */
export function mintShellToken(dir?: string): Loaded<string> {
  ensureRemoteDir(dir);
  const file = shellTokenPath(dir);
  const token = randomBytes(32).toString("base64url");
  try {
    writeOwnerOnlyFileAtomic(file, `${token}\n`);
  } catch {
    return { ok: false, reason: `could not write the shell token at ${file}` };
  }
  return { ok: true, value: token };
}

/** Shell side: read only, never create. The shell must not mint a secret serve does not know. */
export function readShellToken(dir?: string): Loaded<string> {
  return readValidated(shellTokenPath(dir));
}

// ---- mutual proof (F-002) ------------------------------------------------------
//
// The shell finds serve by `endpoint.json` and a pid check, which cannot tell serve
// from another program that bound the port after serve died uncleanly. So neither
// side hands the other its secret:
//
//   - the shell never sends the raw token. Each request carries a fresh random nonce
//     and HMAC(token, auth-domain || nonce) as its bearer, so a listener that is not
//     serve learns a value bound to one nonce of a token that dies at the next serve
//     start, and nothing it can sign with;
//   - serve answers every authenticated shell request with HMAC(token, proof-domain ||
//     nonce || route || status || body) in `SERVE_PROOF_HEADER`, and the shell refuses
//     an answer whose proof is missing or wrong before it acts on or writes anything
//     from it. The two domains differ, so a bearer is never a valid proof.

/** Response header carrying serve's proof. */
export const SERVE_PROOF_HEADER = "x-keryx-serve-proof";
const DERIVED_BEARER_PREFIX = "ksp1.";
const AUTH_DOMAIN = "keryx-shell-auth-v1";
const PROOF_DOMAIN = "keryx-serve-proof-v1";
const NONCE_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;
const MAC_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function mac(token: string, parts: readonly string[]): string {
  // Each part is length-prefixed, so no two different tuples hash the same input.
  const hmac = createHmac("sha256", token);
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hmac.update(`${bytes.byteLength}:`);
    hmac.update(bytes);
  }
  return hmac.digest("base64url");
}

function macEqual(a: string, b: string): boolean {
  return constantTimeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest());
}

/** Shell side: a fresh nonce and the bearer derived from it. The raw token never leaves the shell. */
export function shellRequestCredential(token: string): { nonce: string; bearer: string } {
  const nonce = randomBytes(18).toString("base64url");
  return { nonce, bearer: `${DERIVED_BEARER_PREFIX}${nonce}.${mac(token, [AUTH_DOMAIN, nonce])}` };
}

/** The nonce of a derived bearer (shape only, not verified), or undefined for anything else. */
export function derivedBearerNonce(presented: string): string | undefined {
  if (!presented.startsWith(DERIVED_BEARER_PREFIX)) {
    return undefined;
  }
  const [nonce, presentedMac, ...rest] = presented.slice(DERIVED_BEARER_PREFIX.length).split(".");
  if (rest.length > 0 || nonce === undefined || presentedMac === undefined || !NONCE_SHAPE.test(nonce) || !MAC_SHAPE.test(presentedMac)) {
    return undefined;
  }
  return nonce;
}

/** Serve side: the proof for one answer. */
export function serveResponseProof(token: string, nonce: string, route: string, status: number, body: string): string {
  return mac(token, [PROOF_DOMAIN, nonce, route, String(status), body]);
}

/** Shell side: is `presented` serve's proof for this exact nonce, route, status and body? Constant time. */
export function verifyServeResponseProof(token: string, nonce: string, route: string, status: number, body: string, presented: string | null): boolean {
  if (presented === null || !MAC_SHAPE.test(presented)) {
    return false;
  }
  return macEqual(serveResponseProof(token, nonce, route, status, body), presented);
}

/**
 * A verifier over a fixed token. It accepts the derived per-request bearer, and the
 * raw token (what a shell older than F-002 sends; it gives serve nothing new). Both
 * sides are hashed first, so the compared values are always 32 bytes and the
 * presented length never reaches the loop.
 */
export function createShellTokenVerifier(token: string): (presented: string) => boolean {
  const expected = createHash("sha256").update(token, "utf8").digest();
  return (presented) => {
    const nonce = derivedBearerNonce(presented);
    if (nonce !== undefined) {
      return macEqual(presented, `${DERIVED_BEARER_PREFIX}${nonce}.${mac(token, [AUTH_DOMAIN, nonce])}`);
    }
    return constantTimeEqual(createHash("sha256").update(presented, "utf8").digest(), expected);
  };
}
