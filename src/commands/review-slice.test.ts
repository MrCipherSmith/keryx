// Command-level behaviour of `keryx review slice` and `retry-plan` (flow 441 AC17, closing D-02).
// Flow 427 AC2 and AC5 name this file as their verify command; the parser itself is covered in src/review/ledger.test.ts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";

const ORIGINAL_CWD = process.cwd();
const realError = console.error;
const realLog = console.log;
let root = "";
let logs: string[] = [];
let errors: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-review-slice-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  process.chdir(root);
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  process.chdir(ORIGINAL_CWD);
  await rm(root, { recursive: true, force: true });
});

function gitFile(filePath: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+export const v${n} = ${n};`);
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,0 +1,${count} @@\n${lines.join("\n")}\n`;
}

async function sliceOnce(): Promise<{ ids: string[]; slicePath: string }> {
  await writeFile(path.join(root, "change.diff"), gitFile("src/m/a.ts", 40), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "30000", "--out", "out"]);
  expect(process.exitCode).toBe(0);
  const manifest = JSON.parse(await readFile(path.join(root, "out", "manifest.json"), "utf8")) as { slices: Array<{ id: string; path: string }> };
  logs = [];
  return { ids: manifest.slices.map((s) => s.id), slicePath: path.join(root, "out", manifest.slices[0]!.path) };
}

test("a result is read through the command from a raw reply with a REVIEW_RESULT marker and from plain JSON naming no reviewer", async () => {
  const { ids } = await sliceOnce();
  await writeFile(path.join(root, "raw.txt"), `Looked at everything.\n\nREVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: ids })}\n`, "utf8");
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "raw.txt", "--dry-run", "--json"]);
  expect(process.exitCode).toBe(0);
  const fromReply = JSON.parse(logs.join("\n"));
  expect(fromReply).toMatchObject({ decision: "accepted", reviewer: "review-logic", status: "DONE" });

  logs = [];
  await writeFile(path.join(root, "plain.json"), JSON.stringify({ status: "DONE", slices: ids }), "utf8");
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "plain.json", "--reviewer", "review-style", "--dry-run", "--json"]);
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(logs.join("\n"))).toMatchObject({ decision: "accepted", reviewer: "review-style" });
});

test("an unreadable or result-less file is the UnreadableInput exit: code 2, a named reason, nothing written", async () => {
  await sliceOnce();
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "missing.json"]);
  expect(process.exitCode).toBe(2);
  expect(errors.join("\n")).toContain("result is unreadable");

  for (const [name, body] of [
    ["prose.txt", "looks fine to me"],
    ["truncated.txt", '{"status":"DONE","reviewer":"review-logic","slices":[{"id":"slice-01","status":"DONE"}'],
  ] as const) {
    errors = [];
    process.exitCode = 0;
    await writeFile(path.join(root, name), body, "utf8");
    await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", name]);
    expect(process.exitCode).toBe(2);
    expect(errors.join("\n")).toContain("holds no usable reviewer result");
    expect(errors.join("\n")).toContain("a truncated or ambiguous reply is refused");
    expect(errors.join("\n")).toContain("a ```REVIEW_RESULT block with a status");
    expect(errors.join("\n")).toContain("bare or after a REVIEW_RESULT marker");
  }
  expect(await Bun.file(path.join(root, "out", "retry-state.json")).exists()).toBe(false);
});

test("a plain JSON file without a status is refused, and the reason is the exit code 2 contract", async () => {
  const { ids } = await sliceOnce();
  await writeFile(path.join(root, "nostatus.json"), JSON.stringify({ reviewer: "review-logic", slices: ids }), "utf8");
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "nostatus.json", "--reviewer", "review-logic", "--dry-run", "--json"]);
  expect(process.exitCode).toBe(2);
  expect(errors.join("\n")).toContain("holds no usable reviewer result");
});

test("a status-only result is accepted as a whole file with --reviewer and written, and refused after a bare marker with nothing written (flow 441 AC13)", async () => {
  const { ids } = await sliceOnce();
  const statusOnly = JSON.stringify({ status: "DONE", slices: ids });
  await writeFile(path.join(root, "refused.txt"), `REVIEW_RESULT: ${statusOnly}\n`, "utf8");
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "refused.txt", "--reviewer", "review-style", "--json"]);
  expect(process.exitCode).toBe(2);
  expect(errors.join("\n")).toContain("holds no usable reviewer result");
  expect(await Bun.file(path.join(root, "out", "retry-state.json")).exists()).toBe(false);

  errors = [];
  process.exitCode = 0;
  await writeFile(path.join(root, "whole.json"), statusOnly, "utf8");
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "whole.json", "--reviewer", "review-style", "--json"]);
  expect(process.exitCode).toBe(0);
  expect(await Bun.file(path.join(root, "out", "retry-state.json")).exists()).toBe(true);
});

test("a result is read from stdin when the source is -, and an empty stdin is the unreadable-input exit", async () => {
  const { ids } = await sliceOnce();
  const run = async (stdin: string) => {
    const child = Bun.spawn(["bun", path.join(ORIGINAL_CWD, "src", "cli.ts"), "review", "retry-plan", "--manifest", "out/manifest.json", "--result", "-", "--reviewer", "review-style", "--dry-run", "--json"], { cwd: root, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  const accepted = await run(JSON.stringify({ status: "DONE", slices: ids }));
  expect(accepted.code).toBe(0);
  expect(JSON.parse(accepted.out)).toMatchObject({ decision: "accepted", reviewer: "review-style" });
  const refused = await run("");
  expect(refused.code).toBe(2);
  expect(refused.err).toContain("holds no usable reviewer result");
}, 60_000);

test("scopeFingerprint changes when a slice file changes without changing its size", async () => {
  const { slicePath } = await sliceOnce();
  const fingerprint = async (): Promise<string> => {
    logs = [];
    await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--reviewer", "review-logic", "--next-wave", "--dry-run", "--json"]);
    expect(process.exitCode).toBe(0);
    const value = JSON.parse(logs.join("\n")).scopeFingerprint;
    expect(typeof value).toBe("string");
    return value as string;
  };
  const before = await fingerprint();
  const original = await readFile(slicePath, "utf8");
  const edited = original.replace("v0 = 0;", "v0 = 1;");
  expect(edited).not.toBe(original);
  expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(original));
  await writeFile(slicePath, edited, "utf8");
  expect(await fingerprint()).not.toBe(before);
});

async function plantLate(ids: string[], raw: string): Promise<void> {
  await mkdir(path.join(root, "pkg", "raw"), { recursive: true });
  await mkdir(path.join(root, "pkg", "drivers"), { recursive: true });
  await writeFile(path.join(root, "pkg", "raw", "review-logic.txt"), raw, "utf8");
  await writeFile(path.join(root, "pkg", "drivers", "review-logic-1.json"), JSON.stringify({ reviewer: "review-logic", slices: ids, result: "raw/review-logic.txt" }), "utf8");
}

async function nextWave(extra: string[] = ["--json"]): Promise<string> {
  logs = [];
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--reviewer", "review-logic", "--next-wave", "--package", "pkg", "--dry-run", ...extra]);
  expect(process.exitCode).toBe(0);
  return logs.join("\n");
}

test("retry-plan --package: a finished result written after the deadline covers its slices and is reported as collected late", async () => {
  const { ids } = await sliceOnce();
  await plantLate(ids, `Done.\n\nREVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "DONE_WITH_CONCERNS", slices: ids })}\n`);
  const plan = JSON.parse(await nextWave());
  expect(plan.dispatch).toEqual([]);
  expect(plan.collectedLate).toBe(1);
  expect(await nextWave([])).toContain("collected late: 1");
});

test("retry-plan --package: a malformed or INCOMPLETE result covers nothing, the slice is handed out again", async () => {
  const { ids } = await sliceOnce();
  await plantLate(ids, "REVIEW_RESULT: {\"reviewer\": \"review-logic\", \"status\": \"DO");
  let plan = JSON.parse(await nextWave());
  expect(plan.dispatch.map((d: { slice: string }) => d.slice)).toEqual(ids);
  expect(plan.collectedLate).toBe(0);
  await plantLate(ids, `REVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "INCOMPLETE", slices: ids })}\n`);
  plan = JSON.parse(await nextWave());
  expect(plan.dispatch.map((d: { slice: string }) => d.slice)).toEqual(ids);
  expect(plan.collectedLate).toBe(0);
});

test("retry-plan --package: a late result counts the slices it reported, not the whole assignment (same rule as the ledger)", async () => {
  await writeFile(path.join(root, "change.diff"), ["a", "b", "c"].map((n) => gitFile(`src/m/${n}.ts`, 40)).join(""), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "1500", "--out", "out"]);
  expect(process.exitCode).toBe(0);
  const ids = (JSON.parse(await readFile(path.join(root, "out", "manifest.json"), "utf8")) as { slices: Array<{ id: string }> }).slices.map((slice) => slice.id);
  logs = [];
  expect(ids.length).toBeGreaterThanOrEqual(3);
  await plantLate(ids, `REVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: [ids[0]] })}\n`);
  const plan = JSON.parse(await nextWave());
  expect(plan.dispatch.map((d: { slice: string }) => d.slice)).toEqual(ids.slice(1));
  expect(plan.collectedLate).toBe(1);
});

test("retry-plan --package: a late result for a different scope fingerprint covers nothing", async () => {
  const { ids } = await sliceOnce();
  await plantLate(ids, `REVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "DONE", scopeFingerprint: "stale", slices: ids })}\n`);
  const plan = JSON.parse(await nextWave());
  expect(plan.dispatch.map((d: { slice: string }) => d.slice)).toEqual(ids);
  expect(plan.collectedLate).toBe(0);
});

test("retry-plan --package: two drivers naming the same raw file are collected once", async () => {
  const { ids } = await sliceOnce();
  await plantLate(ids, `REVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: ids })}\n`);
  await writeFile(path.join(root, "pkg", "drivers", "review-logic-2.json"), JSON.stringify({ reviewer: "review-logic", slices: ids, result: "raw/review-logic.txt" }), "utf8");
  const plan = JSON.parse(await nextWave());
  expect(plan.dispatch).toEqual([]);
  expect(plan.collectedLate).toBe(1);
});

test("slice writes the routing into the manifest: roles from content, review-logic on every slice, a depth", async () => {
  await sliceOnce();
  const manifest = JSON.parse(await readFile(path.join(root, "out", "manifest.json"), "utf8")) as { slices: Array<{ roles?: string[]; depth?: string; risk?: { score: number } }> };
  for (const slice of manifest.slices) {
    expect(slice.roles).toContain("review-logic");
    expect(slice.roles).toContain("review-architecture");
    expect(["deep", "light"].includes(slice.depth ?? "")).toBe(true);
    expect(typeof slice.risk?.score).toBe("number");
  }
});

test("retry-plan re-opens a light slice deep when a result reports a major finding on it", async () => {
  const { ids } = await sliceOnce();
  await writeFile(path.join(root, "major.json"), JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: ids, findings: [{ id: "F-1", severity: "major", file: "src/m/a.ts" }] }), "utf8");
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "major.json", "--json"]);
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(logs.join("\n")).escalations).toEqual([{ slice: ids[0]!, finding: "F-1", severity: "major", by: "review-logic" }]);
  const manifest = JSON.parse(await readFile(path.join(root, "out", "manifest.json"), "utf8")) as { slices: Array<{ id: string; depth?: string; roles?: string[]; escalated?: unknown }> };
  const slice = manifest.slices.find((entry) => entry.id === ids[0]!)!;
  expect(slice.depth).toBe("deep");
  expect(slice.roles).toContain("review-security-code");
  expect(slice.escalated).toEqual({ by: "review-logic", finding: "F-1" });
});
