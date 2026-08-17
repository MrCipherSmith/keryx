import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIRM_TOKEN_TTL_MS, consumeConfirmToken, mintConfirmToken } from "./review-confirm-token";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-confirm-token-"));
}

test("a minted token is consumed exactly once for a given idempotencyKey", async () => {
  const root = await tmp();
  const { token } = await mintConfirmToken(root, "workspace-a", "proposal-a");
  const first = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", token);
  expect(first).toEqual({ ok: true });
  const reuse = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-2", token);
  expect(reuse).toEqual({ ok: false, reason: "token_invalid" });
  await rm(root, { recursive: true, force: true });
});

test("a retry with the SAME idempotencyKey needs no token — mirrors the crash-recovery approval/intent pattern", async () => {
  const root = await tmp();
  const { token } = await mintConfirmToken(root, "workspace-a", "proposal-a");
  await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", token);
  const retry = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", undefined);
  expect(retry).toEqual({ ok: true });
  await rm(root, { recursive: true, force: true });
});

test("no token minted yet is token_required", async () => {
  const root = await tmp();
  const result = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", undefined);
  expect(result).toEqual({ ok: false, reason: "token_required" });
  await rm(root, { recursive: true, force: true });
});

test("a wrong token value is token_invalid", async () => {
  const root = await tmp();
  await mintConfirmToken(root, "workspace-a", "proposal-a");
  const result = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", "not-the-real-token");
  expect(result).toEqual({ ok: false, reason: "token_invalid" });
  await rm(root, { recursive: true, force: true });
});

test("an expired token is token_invalid, never silently accepted", async () => {
  const root = await tmp();
  let now = new Date("2026-08-12T00:00:00.000Z");
  const { token } = await mintConfirmToken(root, "workspace-a", "proposal-a", { now: () => now });
  now = new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS + 1000);
  const result = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", token, { now: () => now });
  expect(result).toEqual({ ok: false, reason: "token_invalid" });
  await rm(root, { recursive: true, force: true });
});

test("a token minted for a different proposal does not confirm this one — each proposal has its own sidecar, so this reads as no token minted yet", async () => {
  const root = await tmp();
  const { token } = await mintConfirmToken(root, "workspace-a", "proposal-other");
  const result = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", token);
  expect(result).toEqual({ ok: false, reason: "token_required" });
  await rm(root, { recursive: true, force: true });
});

test("minting a fresh token after a used one lets a genuinely new accept attempt (new idempotencyKey) proceed", async () => {
  const root = await tmp();
  const first = await mintConfirmToken(root, "workspace-a", "proposal-a");
  await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-1", first.token);
  const second = await mintConfirmToken(root, "workspace-a", "proposal-a");
  const result = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-2", second.token);
  expect(result).toEqual({ ok: true });
  await rm(root, { recursive: true, force: true });
});
