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
