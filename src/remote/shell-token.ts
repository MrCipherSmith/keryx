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

import { createHash, randomBytes } from "node:crypto";
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

/**
 * A verifier over a fixed token. Both sides are hashed first, so the compared
 * values are always 32 bytes and the presented length never reaches the loop.
 */
export function createShellTokenVerifier(token: string): (presented: string) => boolean {
  const expected = createHash("sha256").update(token, "utf8").digest();
  return (presented) => constantTimeEqual(createHash("sha256").update(presented, "utf8").digest(), expected);
}
