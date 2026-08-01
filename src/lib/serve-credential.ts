// The `keryx serve` bearer credential (flow 128 / roadmap R4b).
//
// docs/requirements/keryx-remote-entry/security-policy.md is explicit about
// what this file may hold: the token lives in the user-global credential store
// at mode 0600 and is "referenced by opaque id", and `keryx serve status`
// "never prints the token, only a redacted fingerprint".
//
// So the token is knowable exactly once, at the moment it is generated. What
// reaches disk is a random salt, the SHA-256 of salt‖token, and an opaque id.
// There is no function in this module that returns a stored token, because
// there is no stored token to return — which is a stronger guarantee than a
// convention that nobody prints it.
//
// The comparison is the other load-bearing part. `constantTimeEqual` folds
// every byte of both inputs and the length difference into one accumulator and
// returns once, at the end. An early return on the first differing byte leaks
// where a guess diverges; an early return on a length mismatch leaks the length
// of the stored value. Neither is acceptable on a route an attacker can call in
// a loop.
//
// Every function is best-effort and never throws.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { keryxConfigDir } from "./config-dir";
import { withFileLock } from "./file-lock";

/** What is persisted. Note the absence of anything usable as a token. */
export interface ServeCredentialRecord {
  /** Opaque. Referenced by `credentialRef.id` in serve.json. Not a secret. */
  id: string;
  algorithm: "sha256";
  /** 32 random bytes, hex. */
  salt: string;
  /** sha256(salt ‖ token), hex. */
  hash: string;
  createdAt: string;
}

interface ServeCredentialStore {
  schemaVersion: 1;
  active: ServeCredentialRecord | null;
}

export type IssueOutcome =
  | { ok: true; token: string; record: ServeCredentialRecord }
  | { ok: false; reason: "already-issued" | "write-failed"; message: string };

export type RotateOutcome =
  | { ok: true; token: string; record: ServeCredentialRecord; replacedId: string | null }
  | { ok: false; reason: "write-failed"; message: string };

export type RevokeOutcome = "revoked" | "not-found" | "write-failed";

/** Absolute path to the credential store, in the shared user-global directory. */
export function serveCredentialPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "serve-credentials.json");
}

/**
 * Compare two byte sequences without revealing where — or whether — they differ.
 *
 * The loop runs over the WIDER of the two inputs and never returns early, and
 * the length difference is folded into the same accumulator rather than
 * short-circuiting the comparison. Both properties are asserted structurally in
 * serve-credential.test.ts by feeding this function index-counting proxies:
 * every index of both inputs must be read even when byte 0 already differs.
 *
 * `ArrayLike<number>` rather than `Uint8Array` so the test can observe the
 * access pattern. Every production caller passes a fixed-width digest.
 */
export function constantTimeEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const width = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < width; index += 1) {
    // `a[index] ?? 0` rather than a length guard: a guard would be a branch on
    // the length of the secret, which is the thing being hidden.
    const left = (a[index] ?? 0) & 0xff;
    const right = (b[index] ?? 0) & 0xff;
    difference |= left ^ right;
  }
  return difference === 0;
}

function hashToken(salt: string, token: string): string {
  return createHash("sha256").update(Buffer.from(salt, "hex")).update(Buffer.from(token, "utf8")).digest("hex");
}

/**
 * A short, non-reversible label for a credential, safe to print.
 *
 * Derived from the STORED hash, not from the token: the token is gone by the
 * time anything could want to label it, and a fingerprint of a secret is a
 * partial disclosure of that secret.
 */
export function credentialFingerprint(record: ServeCredentialRecord): string {
  return createHash("sha256").update(`keryx-serve-fingerprint:${record.hash}`).digest("hex").slice(0, 8);
}

function isValidRecord(value: unknown): value is ServeCredentialRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    record.algorithm === "sha256" &&
    typeof record.salt === "string" &&
    /^[0-9a-f]{64}$/.test(record.salt) &&
    typeof record.hash === "string" &&
    /^[0-9a-f]{64}$/.test(record.hash) &&
    typeof record.createdAt === "string"
  );
}

/**
 * Absent, damaged, and present are THREE answers, not two.
 *
 * `specification.md` lists "unreadable credential" as its own startup refusal
 * reason, and it is a different instruction to the operator: absent means "issue
 * one", damaged means "something wrote to the store and you should look at it
 * before issuing over the top".
 */
export type ServeCredentialResult =
  | { status: "absent" }
  | { status: "unreadable"; message: string }
  | { status: "ok"; record: ServeCredentialRecord };

/**
 * True when anyone but the owner can read or write `file`.
 *
 * POSIX only. On Windows the mode bits are not meaningful and this returns
 * false — the check is a hardening measure, not the primary control.
 */
function isGroupOrOtherAccessible(file: string): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const mode = statSync(file, { throwIfNoEntry: false })?.mode;
  return mode !== undefined && (mode & 0o077) !== 0;
}

/** Read the credential store, distinguishing absence from damage. */
export function readServeCredential(dir?: string): ServeCredentialResult {
  const file = serveCredentialPath(dir);
  if (!existsSync(file)) {
    return { status: "absent" };
  }
  // Fail closed on a widened mode. Every write below tightens the file to 0600,
  // so a group- or other-accessible store means something OUTSIDE keryx changed
  // it — and the demonstrated attack is exactly that: replace the store with a
  // salt and hash of a token the attacker chose. Silently re-tightening it on
  // the next write would authenticate the attacker in the meantime.
  if (isGroupOrOtherAccessible(file)) {
    return {
      status: "unreadable",
      message:
        "the serve credential store has permissions that allow group or other access; it may have been tampered with. Inspect it, then `chmod 600` it or re-issue",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return { status: "unreadable", message: "the serve credential store is unreadable or malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "unreadable", message: "the serve credential store is not an object" };
  }
  const active = (parsed as ServeCredentialStore).active;
  if (active === null || active === undefined) {
    return { status: "absent" };
  }
  if (!isValidRecord(active)) {
    return { status: "unreadable", message: "the serve credential store does not hold a well-formed credential" };
  }
  return { status: "ok", record: active };
}

/** The active credential, or null when absent, unreadable or structurally wrong. */
export function loadServeCredential(dir?: string, onWarn?: (message: string) => void): ServeCredentialRecord | null {
  const result = readServeCredential(dir);
  if (result.status === "ok") {
    return result.record;
  }
  if (result.status === "unreadable") {
    onWarn?.(result.message);
  }
  return null;
}

/**
 * Write the store atomically at 0600, inside a directory forced to 0700.
 *
 * Both `chmod` calls are deliberate and neither is redundant: `mkdirSync`'s
 * `mode` and `writeFileSync`'s `mode` apply at CREATION only. The shared
 * user-global directory is usually created first by `saveShellConfig`, with no
 * mode at all, so under the common `umask 002` it already exists as 0775 by the
 * time this runs and the mode argument is a no-op. A security review
 * demonstrated the consequence end to end: on a group-writable directory an
 * attacker replaces this file with a salt and hash of a token they chose and
 * authenticates as the operator.
 *
 * Temp-file + fsync + rename rather than a truncating write, matching
 * `saveProjectRegistry`: a process killed mid-write would otherwise leave a
 * readable zero-length store, which reads as "no credential" and locks the
 * operator out of their own listener.
 */
function writeStore(store: ServeCredentialStore, dir?: string): boolean {
  const base = keryxConfigDir(dir);
  const file = serveCredentialPath(dir);
  // A pid is not unique across PID namespaces sharing a bind-mounted home.
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    tighten(base, 0o700);
    const handle = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8" });
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, file);
    // Not observable under an ordinary umask — `openSync(…, 0o600)` cannot
    // produce anything wider, and rename preserves the mode — so no test here
    // fails when it is removed. It is kept for the case that is not ordinary: a
    // directory carrying a default POSIX ACL grants group access to newly
    // created files whatever mode the caller asked for. Stated rather than
    // presented as a tested control.
    tighten(file, 0o600);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // nothing to clean up
    }
    return false;
  }
}

/** Force `target` to `mode`. Best-effort: not every filesystem honours it. */
function tighten(target: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    chmodSync(target, mode);
  } catch {
    // A filesystem that refuses chmod (some network mounts) is reported by the
    // permission check in readServeCredential rather than silently accepted.
  }
}

/**
 * Serialize the whole read-modify-write of the credential store.
 *
 * Same primitive `projects.json` uses, for the same reason: an atomic write
 * stops a TORN file and does nothing about a LOST update, and every operation
 * below decides what to write based on what it just read.
 */
function withServeCredentialLock<T>(dir: string | undefined, fn: () => T): T | null {
  return withFileLock(`${serveCredentialPath(dir)}.lock`, fn, {
    waitingMessage: "waiting for the serve credential lock…",
  });
}

function mintRecord(now: string): { token: string; record: ServeCredentialRecord } {
  // 32 bytes of CSPRNG output — 256 bits, the same strength as the digest it is
  // compared through, so the hash is not the weak half.
  const token = randomBytes(32).toString("base64url");
  const salt = randomBytes(32).toString("hex");
  return {
    token,
    record: { id: randomUUID(), algorithm: "sha256", salt, hash: hashToken(salt, token), createdAt: now },
  };
}

/**
 * Generate a token, print-once at the call site, and persist only its hash.
 *
 * Refuses when a credential already exists. Silently replacing one would
 * invalidate a token that something is currently authenticating with, and the
 * operator would learn about it from a 401 rather than from this command.
 * `rotate` is the operation that deliberately replaces.
 */
export function issueServeToken(dir?: string, now: () => string = () => new Date().toISOString()): IssueOutcome {
  // The check and the write are ONE critical section. Without the lock this is
  // a check-then-write, and a security review ran eight concurrent `issue`
  // processes: six printed a token to their operator and only one of those
  // tokens actually worked. A token printed once and immediately overwritten is
  // the worst possible outcome for a credential that cannot be recovered.
  const outcome = withServeCredentialLock(dir, (): IssueOutcome => {
    if (readServeCredential(dir).status !== "absent") {
      return {
        ok: false,
        reason: "already-issued",
        message: "a serve credential already exists; use `keryx serve token rotate` to replace it, or `revoke` to remove it",
      };
    }
    const { token, record } = mintRecord(now());
    if (!writeStore({ schemaVersion: 1, active: record }, dir)) {
      return { ok: false, reason: "write-failed", message: "could not write the serve credential store" };
    }
    return { ok: true, token, record };
  });
  return outcome ?? { ok: false, reason: "write-failed", message: "could not acquire the serve credential lock" };
}

/**
 * Replace the credential: a new token becomes valid and the previous one stops
 * being valid, in ONE write.
 *
 * Not implemented as revoke-then-issue: that leaves a window with no valid
 * credential, and a failure between the two steps leaves the operator locked
 * out with no token to show for it.
 */
export function rotateServeToken(dir?: string, now: () => string = () => new Date().toISOString()): RotateOutcome {
  const outcome = withServeCredentialLock(dir, (): RotateOutcome => {
    // `readServeCredential`, not `loadServeCredential`: a store this call is
    // about to replace may legitimately be damaged, and reporting the id it
    // replaced is best-effort, not a precondition.
    const previous = readServeCredential(dir);
    const { token, record } = mintRecord(now());
    if (!writeStore({ schemaVersion: 1, active: record }, dir)) {
      return { ok: false, reason: "write-failed", message: "could not write the serve credential store" };
    }
    return { ok: true, token, record, replacedId: previous.status === "ok" ? previous.record.id : null };
  });
  return outcome ?? { ok: false, reason: "write-failed", message: "could not acquire the serve credential lock" };
}

/** Invalidate the credential. Reported distinctly from "there was none". */
export function revokeServeToken(dir?: string): RevokeOutcome {
  const outcome = withServeCredentialLock(dir, (): RevokeOutcome => {
    // A damaged store still has something to revoke: writing `active: null` is
    // how the operator recovers from one, and reporting "not-found" would leave
    // the damaged file in place while claiming there was nothing there.
    if (readServeCredential(dir).status === "absent") {
      return "not-found";
    }
    return writeStore({ schemaVersion: 1, active: null }, dir) ? "revoked" : "write-failed";
  });
  return outcome ?? "write-failed";
}

/**
 * Whether `presented` is the token this record was minted from.
 *
 * The presented value is hashed with the stored salt BEFORE comparison, so the
 * compared values are always 32 bytes and the presented token's own length
 * never reaches the loop. `constantTimeEqual` is still length-independent, so
 * this holds even if a future caller hands it two raw values.
 */
export function verifyServeToken(presented: string, record: ServeCredentialRecord): boolean {
  const expected = Buffer.from(record.hash, "hex");
  // `actual` is always a 32-byte digest, so a stored hash that is not 32 bytes
  // of hex cannot match it — the length difference is folded into the
  // accumulator by constantTimeEqual rather than short-circuiting. An extra
  // `expected.length === 32` clause here would look like a guard and be dead
  // code, which is worse than no clause at all.
  const actual = Buffer.from(hashToken(record.salt, presented), "hex");
  return constantTimeEqual(actual, expected);
}
