import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportReviewAgentResult } from "./package-export";
import { readDrivers } from "../driver-read";
import { parseReviewResult } from "../ledger";
const reply = { reviewer: "review-logic", status: "DONE", summary: "Reviewed", findings: [], stats: { blocker: 0, major: 0, minor: 0, info: 0 } };
const stored = { runId: "r", dispatchId: "d", resultId: "answer", revision: "a".repeat(40), scopeIds: ["slice-01"], skillRef: "review-logic", content: { text: "commentary", submittedResult: reply } };
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-export-"));
  try {
    await mkdir(path.join(dir, "slices"));
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ target: { head: stored.revision } }));
    await writeFile(path.join(dir, "slices", "manifest.json"), JSON.stringify({ slices: [{ id: "slice-01" }] }));
    await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test("exports submission to ingest-compatible raw and driver with provenance", () => fixture(async (dir) => {
  const exported = await exportReviewAgentResult(dir, stored);
  expect(exported.ok).toBe(true);
  if (!exported.ok) return;
  const driver = JSON.parse(await readFile(path.join(dir, exported.value.driver), "utf8"));
  expect(driver.hierarchical).toEqual(stored);
  expect(parseReviewResult(await readFile(path.join(dir, exported.value.raw), "utf8"))?.reviewer).toBe(reply.reviewer);
  const records = await readDrivers(dir, dir);
  expect(records.payloadSlices[reply.reviewer]).toEqual(["slice-01"]);
  expect(records.replies.files.has(path.basename(exported.value.raw))).toBe(true);
  expect(await exportReviewAgentResult(dir, stored)).toEqual(exported);
}));
test("distinct dispatches of the same skill do not collide", () => fixture(async (dir) => {
  expect((await exportReviewAgentResult(dir, stored)).ok).toBe(true);
  expect((await exportReviewAgentResult(dir, { ...stored, dispatchId: "../another" })).ok).toBe(true);
  expect((await readdir(path.join(dir, "drivers"))).length).toBe(2);
}));
test("rejects invalid blocked mismatched results before writing", () => fixture(async (dir) => {
  for (const value of [undefined, {}, { ...stored, content: "done" }, { ...stored, revision: "b".repeat(40) },
    { ...stored, scopeIds: ["missing"] }, { ...stored, content: { ...reply, reviewer: "review-security" } },
    { ...stored, content: { ...reply, status: "BLOCKED" } }]) {
    expect((await exportReviewAgentResult(dir, value)).ok).toBe(false);
  }
  expect((await readdir(dir)).sort()).toEqual(["manifest.json", "slices"]);
}));
test("refuses conflicting re-export", () => fixture(async (dir) => {
  expect((await exportReviewAgentResult(dir, stored)).ok).toBe(true);
  expect((await exportReviewAgentResult(dir, { ...stored, content: { ...reply, summary: "changed" } })).ok).toBe(false);
}));
test("does not follow artifact directory symlinks", () => fixture(async (dir) => {
  await mkdir(path.join(dir, "outside"));
  await symlink(path.join(dir, "outside"), path.join(dir, "raw"));
  expect((await exportReviewAgentResult(dir, stored)).ok).toBe(false);
  expect(await readdir(path.join(dir, "outside"))).toEqual([]);
}));

import { runReviewAgentsCommand } from "../../commands/review-agents";
test("CLI exports authorized result and reports refusal without artifacts", () => fixture(async (dir) => {
  let answer: unknown = stored;
  const output: string[] = [], errors: string[] = [];
  const factory = { open: async () => ({ capabilities: () => [], status: () => ({}), spawn: () => ({ ok: false as const, code: "authority_denied" as const, message: "denied" }), wait: () => ({}), cancel: () => undefined, result: () => answer }) };
  const args = ["result", "--run-dir", dir, "--dispatch", stored.dispatchId, "--package", dir];
  const deps = { factory, log: (s: string) => output.push(s), error: (s: string) => errors.push(s) };
  expect(await runReviewAgentsCommand(args, deps)).toBe(0);
  expect(JSON.parse(output[0]!).raw).toStartWith("raw/hierarchical-");
  answer = undefined;
  expect(await runReviewAgentsCommand(args, deps)).toBe(1);
  expect(errors.length).toBe(1);
}));
