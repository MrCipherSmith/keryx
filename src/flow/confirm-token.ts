// Flow 299 (AC1-AC3): a completion confirmation token that no agent TOOL can
// mint.
//
// The mechanism is SAC's `review-confirm-token.ts` pattern, applied to
// `flow complete`:
// - `keryx flow confirm <id>` mints the token. It is a separate CLI verb that
//   requires a terminal and a challenge typed back via `/dev/tty`.
// - Only the token's sha256 reaches disk, bound to the flow, the completion
//   kind and the AC checksum in force. It lives in `confirm-token.json` in the
//   flow's own directory, where `isManagedFlowFile` already refuses
//   harness/ACP edits.
// - `flow complete --confirm-token <t>` checks the token when the attempt
//   starts, and spends it only on a passing completion.
//
// What this does NOT prove is stated in TM-03 and the CLI reference:
// - A shell-capable agent can fake a terminal (`script`).
// - It can write its own hash into this file.
// - It can spell the command so the approval floor's text match misses it.
// So a spent token records that an interactive confirmation step ran within
// the TTL for exactly this AC checksum. It does not record who ran it.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, writeFileAtomic } from "../lib/fs";
import { REVIEW_GATE_CONFIG_PATH } from "./review-gate";
import { flowsRoot } from "./store";
import type { SignatureConfirmation } from "./types";

/** Long enough to outlast a `flow complete` whose health gate runs the whole check. */
export const CONFIRMATION_TOKEN_TTL_MS = 10 * 60_000;

/**
 * The one-sentence honesty caveat. `flow complete`, `flow confirm` and the help
 * text all repeat it (flow 299, AC8).
 */
export const CONFIRMATION_CAVEAT =
  "The token proves an interactive confirmation step ran outside the agent's tool roster, within its TTL, " +
  "for this criteria checksum — not that a human ran it, and not who.";

/** File name of the token store inside a flow directory. Named by the unattended floor. */
export const CONFIRM_TOKEN_FILE = "confirm-token.json";

/** Length of the hash prefix recorded as `tokenRef`: enough to correlate, never the token. */
const TOKEN_REF_LENGTH = 12;

export type StoredConfirmationToken = {
  schemaVersion: 1;
  /** sha256 of the token, hex. The plaintext token is never written. */
  hash: string;
  tokenRef: string;
  flowId: string;
  kind: "complete";
  acChecksum: string;
  mintedAt: string;
  expiresAt: string;
  usedAt?: string | undefined;
};

export type ConfirmationTokenFailure =
  | "token_required"
  | "token_not_minted"
  | "token_unreadable"
  | "token_mismatch"
  | "token_expired"
  | "token_used"
  | "token_other_flow"
  | "token_stale_criteria";

export type ConfirmationTokenCheck =
  | { ok: true; stored: StoredConfirmationToken }
  | { ok: false; reason: ConfirmationTokenFailure };

export function confirmTokenPath(cwd: string, dir: string): string {
  return path.join(flowsRoot(cwd), dir, CONFIRM_TOKEN_FILE);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Write a fresh token's hash for `flowId`, replacing any earlier one: only the
 * latest mint is spendable. Returns the plaintext token, once, to the caller.
 * The caller holds the flow lock.
 */
export async function mintConfirmationToken(
  cwd: string,
  dir: string,
  binding: { flowId: string; acChecksum: string },
  deps: { now: () => Date; randomToken?: () => string },
): Promise<{ token: string; stored: StoredConfirmationToken }> {
  // The flow id is the token's visible prefix, so a token pasted into the wrong
  // flow is refused as "other flow" rather than as an anonymous mismatch.
  const token = `${binding.flowId}.${(deps.randomToken ?? (() => randomBytes(24).toString("base64url")))()}`;
  const mintedAt = deps.now();
  const hash = sha256(token);
  const stored: StoredConfirmationToken = {
    schemaVersion: 1,
    hash,
    tokenRef: hash.slice(0, TOKEN_REF_LENGTH),
    flowId: binding.flowId,
    kind: "complete",
    acChecksum: binding.acChecksum,
    mintedAt: mintedAt.toISOString(),
    expiresAt: new Date(mintedAt.getTime() + CONFIRMATION_TOKEN_TTL_MS).toISOString(),
  };
  await writeFileAtomic(confirmTokenPath(cwd, dir), `${JSON.stringify(stored, null, 2)}\n`);
  return { token, stored };
}

/**
 * Check `token` against the stored hash. Pure read: nothing is written. The
 * reasons are ordered so the caller hears the most specific one.
 */
export async function checkConfirmationToken(
  cwd: string,
  dir: string,
  binding: { flowId: string; acChecksum: string | null },
  token: string | undefined,
  now: Date,
): Promise<ConfirmationTokenCheck> {
  if (token === undefined || token.trim() === "") return { ok: false, reason: "token_required" };
  const presented = token.trim();
  const prefix = presented.includes(".") ? presented.slice(0, presented.indexOf(".")) : undefined;
  if (prefix !== undefined && /^\d{3}$/.test(prefix) && prefix !== binding.flowId) {
    return { ok: false, reason: "token_other_flow" };
  }
  let stored: StoredConfirmationToken;
  try {
    stored = JSON.parse(await readFile(confirmTokenPath(cwd, dir), "utf8")) as StoredConfirmationToken;
  } catch (error) {
    return { ok: false, reason: isNotFound(error) ? "token_not_minted" : "token_unreadable" };
  }
  if (typeof stored.hash !== "string" || stored.hash !== sha256(presented)) {
    return { ok: false, reason: "token_mismatch" };
  }
  if (stored.flowId !== binding.flowId || stored.kind !== "complete") return { ok: false, reason: "token_other_flow" };
  if (stored.usedAt !== undefined) return { ok: false, reason: "token_used" };
  if (new Date(stored.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: "token_expired" };
  if (binding.acChecksum === null || stored.acChecksum !== binding.acChecksum) {
    return { ok: false, reason: "token_stale_criteria" };
  }
  return { ok: true, stored };
}

/** Mark the stored token spent and return what the signature records. The caller holds the flow lock. */
export async function consumeConfirmationToken(
  cwd: string,
  dir: string,
  stored: StoredConfirmationToken,
  now: Date,
): Promise<SignatureConfirmation> {
  const consumedAt = now.toISOString();
  await writeFileAtomic(
    confirmTokenPath(cwd, dir),
    `${JSON.stringify({ ...stored, usedAt: consumedAt }, null, 2)}\n`,
  );
  return {
    mechanism: "terminal-token",
    tokenRef: stored.tokenRef,
    mintedAt: stored.mintedAt,
    consumedAt,
    boundTo: { kind: stored.kind, acChecksum: stored.acChecksum },
  };
}

/** One operator-facing sentence per refusal. Never echoes the token. */
export function describeConfirmationFailure(reason: ConfirmationTokenFailure, flowId: string): string {
  const mint = `mint one from a terminal: \`keryx flow confirm ${flowId}\``;
  switch (reason) {
    case "token_required":
      return `this flow requires a confirmation token, passed as --confirm-token; ${mint}`;
    case "token_not_minted":
      return `no confirmation token was minted for this flow; ${mint}`;
    case "token_unreadable":
      return `the confirmation token store could not be read; ${mint}`;
    case "token_mismatch":
      return `the confirmation token does not match the one minted for this flow (only the latest mint is valid); ${mint}`;
    case "token_expired":
      return `the confirmation token expired; ${mint}`;
    case "token_used":
      return `the confirmation token was already spent; ${mint}`;
    case "token_other_flow":
      return `the confirmation token was minted for a different flow; ${mint}`;
    case "token_stale_criteria":
      return `the acceptance criteria changed after the confirmation token was minted; ${mint}`;
  }
}

/**
 * The project default for new flows: `completion.require_confirmation: true`
 * in `.metaproject/tasks.config.json`. Anything else, including an unreadable
 * or unparsable file, is `false`: the gate stays opt-in. `flow init` reads it
 * once and stamps the answer into the new flow's `gates`, so a later edit
 * never reaches an existing flow.
 */
export async function readRequireConfirmationDefault(cwd: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const completion = (parsed as Record<string, unknown>)["completion"];
    if (typeof completion !== "object" || completion === null) return false;
    return (completion as Record<string, unknown>)["require_confirmation"] === true;
  } catch {
    return false;
  }
}
