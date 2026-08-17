// SLATE-20: short-lived, single-use confirm token for `workspace review
// --decision accepted`. Closes a real self-accept trust gap: ProposalLifecycleService.review()
// only ever saw a caller-supplied `interactive: true` flag, which an MCP
// client (or any agent with sac_review) can set on itself — it proves
// nothing about a human actually being present. Minting a token requires
// running `keryx workspace confirm-review` as a real shell command (risk:
// "shell", approval-gated, never exposed as an agent-native tool/MCP tool),
// so a caller that only has MCP/tool access cannot mint one on its own, and
// a caller that also has shell_exec still needs a human to approve that one
// command.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, pathExists, withFileLock, writeFileAtomic } from "../lib/fs";

export const CONFIRM_TOKEN_TTL_MS = 2 * 60_000;

interface StoredToken {
  schemaVersion: 1;
  hash: string;
  workspaceId: string;
  proposalId: string;
  mintedAt: string;
  expiresAt: string;
  usedAt?: string;
}

export type ConfirmTokenDeps = {
  now?: () => Date;
  randomToken?: () => string;
};

export function confirmTokenPath(cwd: string, workspaceId: string, proposalId: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.confirm-token.json`);
}

/**
 * Mirrors `approvalPath`/`intentPath`/`decisionPath` in proposal-lifecycle.ts
 * exactly (`${proposalId}.${hash(idempotencyKey)}.<kind>.json`), for the same
 * reason: once one accept attempt for this idempotencyKey has consumed a
 * token, a crash-recovery retry of that SAME attempt (identical
 * idempotencyKey, no terminal transition recorded yet) must succeed without
 * demanding a second token — a token is a per-ATTEMPT gate, not a per-CALL
 * one, exactly like `writeApproval`/`ensureWriteIntent`'s own recovery
 * short-circuit.
 */
function confirmReceiptPath(cwd: string, workspaceId: string, proposalId: string, idempotencyKey: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.${sha256(idempotencyKey)}.confirm-receipt.json`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function mintConfirmToken(
  cwd: string,
  workspaceId: string,
  proposalId: string,
  deps: ConfirmTokenDeps = {},
): Promise<{ token: string; expiresAt: string }> {
  const now = deps.now ?? (() => new Date());
  const randomToken = deps.randomToken ?? (() => randomBytes(24).toString("base64url"));
  const token = randomToken();
  const mintedAt = now();
  const expiresAt = new Date(mintedAt.getTime() + CONFIRM_TOKEN_TTL_MS);
  const file = confirmTokenPath(cwd, workspaceId, proposalId);
  const stored: StoredToken = {
    schemaVersion: 1,
    hash: sha256(token),
    workspaceId,
    proposalId,
    mintedAt: mintedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await withFileLock(`${file}.lock`, async () => {
    await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
  });
  return { token, expiresAt: stored.expiresAt };
}

export type ConfirmTokenResult = { ok: true } | { ok: false; reason: "token_required" | "token_invalid" };

/**
 * Verifies and consumes the token for one accept attempt, keyed by
 * `idempotencyKey` so a legitimate crash-recovery retry of the same attempt
 * (see `confirmReceiptPath` above) never needs a second token — only a
 * genuinely new idempotencyKey (a fresh accept attempt) does. Runs the
 * receipt-check, token-verify, and both writes under one lock so two
 * concurrent first-attempts for the same idempotencyKey can't both consume
 * the token.
 */
export async function consumeConfirmToken(
  cwd: string,
  workspaceId: string,
  proposalId: string,
  idempotencyKey: string,
  token: string | undefined,
  deps: ConfirmTokenDeps = {},
): Promise<ConfirmTokenResult> {
  const now = deps.now ?? (() => new Date());
  const file = confirmTokenPath(cwd, workspaceId, proposalId);
  const receipt = confirmReceiptPath(cwd, workspaceId, proposalId, idempotencyKey);
  return withFileLock(`${file}.lock`, async () => {
    if (await pathExists(receipt)) return { ok: true };
    if (token === undefined || token.length === 0) return { ok: false, reason: "token_required" };
    let stored: StoredToken;
    try {
      stored = JSON.parse(await readFile(file, "utf8")) as StoredToken;
    } catch (error) {
      return { ok: false, reason: isNotFound(error) ? "token_required" : "token_invalid" };
    }
    if (
      stored.usedAt !== undefined ||
      new Date(stored.expiresAt).getTime() <= now().getTime() ||
      stored.hash !== sha256(token) ||
      stored.workspaceId !== workspaceId ||
      stored.proposalId !== proposalId
    ) {
      return { ok: false, reason: "token_invalid" };
    }
    const consumed: StoredToken = { ...stored, usedAt: now().toISOString() };
    await writeFileAtomic(file, `${JSON.stringify(consumed, null, 2)}\n`);
    await writeFileAtomic(receipt, `${JSON.stringify({ schemaVersion: 1, idempotencyKey, consumedAt: now().toISOString() }, null, 2)}\n`);
    return { ok: true };
  });
}
