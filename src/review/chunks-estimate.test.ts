// Flow 431 AC11: the estimate before a large chunk run, and the ceiling that decides whether anyone is asked.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChunks } from "../commands/review-chunks";
import { saveRoutingConfig } from "../harness/routing/config";
import { recordChunk } from "./chunks";
import {
  AUTOMATIC_REVIEW_DISCLOSURE_FILE,
  DEFAULT_MAX_PASSES,
  answerChunkEstimate,
  chunkModeOf,
  chunkRunBlocker,
  decisionFor,
  estimateChunkRun,
  readChunkEstimate,
  readChunkLimits,
  recordChunkEstimate,
  renderChunkEstimate,
} from "./chunks-estimate";

let root: string;
let pkg: string;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;

function dropFiles(count: number): void {
  const dropped = Array.from({ length: count }, (_, index) => ({ file: `src/d-${String(index).padStart(4, "0")}.ts`, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" }));
  writeFileSync(path.join(pkg, "blast-radius.json"), JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped }));
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-estimate-")));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".metaproject"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  mkdirSync(pkg, { recursive: true });
  process.chdir(root);
});
afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  rmSync(root, { recursive: true, force: true });
});

test("the estimate shows chunk count, files, tokens, cost at the middle tier and duration", async () => {
  dropFiles(100);
  const estimate = await estimateChunkRun(pkg, root);
  expect(estimate).not.toBeNull();
  expect(estimate).toMatchObject({ tier: "middle", reviewer: "review-regression", chunks: 3, files: 100, maxPasses: 25, ceilingFiles: 1000, overCeiling: false, limitsSource: "default" });
  expect(estimate!.tokens.input).toBeGreaterThan(0);
  expect(estimate!.tokens.output).toBe(3 * 1500);
  expect(estimate!.costUsd).toBeGreaterThan(0);
  expect(estimate!.seconds).toBe(3 * 150);
  const record = await recordChunkEstimate(pkg, estimate!, "interactive");
  const text = renderChunkEstimate(record).join("\n");
  expect(text).toContain("3 chunk(s), 100 file(s)");
  expect(text).toContain("middle tier");
  expect(text).toMatch(/~\$\d+\.\d\d/);
  expect(text).toContain("ceiling: 25 passes of 40 files (1000 files)");
});

test("no dropped files means no plan and no estimate", async () => {
  writeFileSync(path.join(pkg, "blast-radius.json"), JSON.stringify({ schemaVersion: 1, changedFiles: [], files: [], dropped: [] }));
  expect(await estimateChunkRun(pkg, root)).toBeNull();
});

test("automatic mode: at or under the ceiling goes through without a question, over it asks once", async () => {
  writeFileSync(path.join(pkg, AUTOMATIC_REVIEW_DISCLOSURE_FILE), "{}");
  expect(chunkModeOf(pkg)).toBe("automatic");
  expect(decisionFor({ overCeiling: false }, "automatic")).toBe("proceed");
  expect(decisionFor({ overCeiling: true }, "automatic")).toBe("ask-once");

  dropFiles(1000);
  const atCeiling = await estimateChunkRun(pkg, root);
  expect(atCeiling).toMatchObject({ chunks: 25, overCeiling: false });
  expect((await recordChunkEstimate(pkg, atCeiling!, "automatic")).asked).toBe(false);
  expect(await chunkRunBlocker(pkg, root)).toBeUndefined();

  rmSync(path.join(pkg, "chunks.json"));
  dropFiles(1001);
  const over = await estimateChunkRun(pkg, root);
  expect(over).toMatchObject({ chunks: 26, overCeiling: true });
  const record = await recordChunkEstimate(pkg, over!, "automatic");
  expect(record).toMatchObject({ decision: "ask-once", asked: true });
});

test("interactive mode: a run over the ceiling waits for a yes, and `chunks next` refuses until it comes", async () => {
  dropFiles(1200);
  expect(chunkModeOf(pkg)).toBe("interactive");
  const blocked = await chunkRunBlocker(pkg, root);
  expect(blocked).toContain("exceed the ceiling of 25 passes (1000 files)");
  expect(blocked).toContain("--answer yes");

  const refused = await capture(() => runChunks(["next", "--package", pkg], { rejectUnknownFlags: () => {} }));
  expect(refused).toContain("blocked:");
  expect(process.exitCode).toBe(1);
  process.exitCode = originalExitCode;

  const estimate = (await estimateChunkRun(pkg, root))!;
  await recordChunkEstimate(pkg, estimate, "interactive");
  await expect(answerChunkEstimate(pkg, "yes", " ")).rejects.toThrow("operator's own words");
  const answered = await answerChunkEstimate(pkg, "yes", "yes, run them all", new Date("2026-10-13T10:00:00Z"));
  expect(answered.answer).toEqual({ value: "yes", quote: "yes, run them all", at: "2026-10-13T10:00:00.000Z" });
  expect(await chunkRunBlocker(pkg, root)).toBeUndefined();
  const next = await capture(() => runChunks(["next", "--package", pkg], { rejectUnknownFlags: () => {} }));
  expect(next).toContain("next: chunk-001");
});

test("a no keeps the run blocked, and an answer does not carry over to a different plan", async () => {
  dropFiles(1200);
  await recordChunkEstimate(pkg, (await estimateChunkRun(pkg, root))!, "interactive");
  await answerChunkEstimate(pkg, "no", "too expensive");
  expect(await chunkRunBlocker(pkg, root)).toContain("the operator answered no");

  await recordChunk(pkg, "chunk-001", { status: "DONE", findings: [] });
  const smaller = (await estimateChunkRun(pkg, root))!;
  expect(smaller.chunks).toBe(29);
  const record = await recordChunkEstimate(pkg, smaller, "interactive");
  expect(record.answer).toBeUndefined();
});

test("the estimate and the answer are recorded in the package", async () => {
  dropFiles(1200);
  await runChunks(["estimate", "--package", pkg], { rejectUnknownFlags: () => {} });
  await runChunks(["estimate", "--package", pkg, "--answer", "yes", "--quote", "go ahead"], { rejectUnknownFlags: () => {} });
  const saved = JSON.parse(readFileSync(path.join(pkg, "chunk-estimate.json"), "utf8"));
  expect(saved.estimate.chunks).toBe(30);
  expect(saved.answer).toMatchObject({ value: "yes", quote: "go ahead" });
  expect((await readChunkEstimate(pkg))?.decision).toBe("wait-for-yes");
});

test("the ceiling comes from routing.config.json reviewChunks.maxPasses and falls back to 25", async () => {
  expect((await readChunkLimits(root)).maxPasses).toBe(DEFAULT_MAX_PASSES);
  writeFileSync(path.join(root, "routing.config.json"), JSON.stringify({ categories: {}, reviewChunks: { maxPasses: 4, secondsPerPass: 60 } }));
  const limits = await readChunkLimits(root);
  expect(limits).toMatchObject({ maxPasses: 4, secondsPerPass: 60, source: "routing.config.json" });
  dropFiles(200);
  const estimate = (await estimateChunkRun(pkg, root))!;
  expect(estimate).toMatchObject({ chunks: 5, maxPasses: 4, ceilingFiles: 160, overCeiling: true, seconds: 300 });
  writeFileSync(path.join(root, "routing.config.json"), JSON.stringify({ reviewChunks: { maxPasses: -3 } }));
  expect((await readChunkLimits(root)).maxPasses).toBe(25);
});

test("saving the routing table keeps the reviewChunks key", async () => {
  writeFileSync(path.join(root, "routing.config.json"), JSON.stringify({ categories: {}, reviewChunks: { maxPasses: 7 } }));
  await saveRoutingConfig("project", { cwd: root }, { review: { kind: "session-default" } });
  const saved = JSON.parse(readFileSync(path.join(root, "routing.config.json"), "utf8"));
  expect(saved.reviewChunks).toEqual({ maxPasses: 7 });
  expect(saved.categories.review).toEqual({ kind: "session-default" });
});
