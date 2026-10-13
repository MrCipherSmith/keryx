import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHUNKS_FILE, CHUNK_PASS_FILE, ensureChunkPlan, mergeChunkPass, mergeFindings, nextChunk, planChunks, readChunkPlan, recordChunk } from "./chunks";

let root: string;
let packageDir: string;

const drop = (file: string, hop = 1, fanIn = 1) => ({ file, hop, fanIn, via: "src/a.ts", source: "graph" as const, reason: "cap" as const, detail: "over the cap" });

async function writeRadius(dropped: ReturnType<typeof drop>[]): Promise<void> {
  await writeFile(
    path.join(packageDir, "blast-radius.json"),
    JSON.stringify({ schemaVersion: 1, scope: "blast-radius", depth: 2, maxFiles: 40, changedFiles: ["src/a.ts"], files: [], dropped, unresolved: [], counts: {}, graph: { nodes: 1, edges: 0 } }),
  );
}

async function sizedFiles(names: string[], bytes = 600): Promise<void> {
  for (const name of names) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), "x".repeat(bytes));
  }
}

const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `src/dep-${String(index).padStart(3, "0")}.ts`);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-chunks-"));
  packageDir = path.join(root, ".metaproject", "reviews", "r1");
  await mkdir(packageDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the chunk plan over the dropped blast-radius files (AC8a)", () => {
  test("puts every dropped file in exactly one chunk, at most 40 per chunk", async () => {
    const files = names(95);
    await sizedFiles(files, 10);
    await writeRadius(files.map((file) => drop(file)));
    const plan = await ensureChunkPlan(packageDir, root);
    expect(plan).not.toBeNull();
    const placed = plan!.chunks.flatMap((chunk) => chunk.files);
    expect(placed.sort()).toEqual([...files].sort());
    expect(new Set(placed).size).toBe(95);
    expect(plan!.chunks.map((chunk) => chunk.files.length)).toEqual([40, 40, 15]);
    expect(plan!.dropped).toBe(95);
  });

  test("respects the byte cap: files that do not fit together go to separate chunks", () => {
    const chunks = planChunks({ dropped: names(6).map((file) => drop(file)), maxBytes: 1000, sizeOf: () => 400 });
    expect(chunks.map((chunk) => chunk.files.length)).toEqual([2, 2, 2]);
    const alone = planChunks({ dropped: names(2).map((file) => drop(file)), maxBytes: 100, sizeOf: () => 5000 });
    expect(alone.map((chunk) => chunk.files.length)).toEqual([1, 1]);
  });

  test("is deterministic: the same dropped set in any order gives the same plan", () => {
    const files = names(50).map((file, index) => drop(file, (index % 3) + 1, index % 5));
    const first = planChunks({ dropped: files });
    const second = planChunks({ dropped: [...files].reverse() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first[0]?.files[0]).toBeDefined();
  });

  test("writes chunks.json before any pass, and keeps it afterwards", async () => {
    const files = names(3);
    await sizedFiles(files);
    await writeRadius(files.map((file) => drop(file)));
    expect(existsSync(path.join(packageDir, CHUNKS_FILE))).toBe(false);
    const first = await ensureChunkPlan(packageDir, root);
    expect(existsSync(path.join(packageDir, CHUNKS_FILE))).toBe(true);
    await writeRadius([...files, "src/extra.ts"].map((file) => drop(file)));
    expect(await ensureChunkPlan(packageDir, root)).toEqual(first);
    expect((await readChunkPlan(packageDir))?.chunks).toEqual(first!.chunks);
  });

  test("no dropped files means no plan and no file", async () => {
    await writeRadius([]);
    expect(await ensureChunkPlan(packageDir, root)).toBeNull();
    expect(existsSync(path.join(packageDir, CHUNKS_FILE))).toBe(false);
    expect(await ensureChunkPlan(path.join(root, "nothing"), root)).toBeNull();
  });
});

describe("running the chunks one at a time through the retry plan (AC8b, AC8c)", () => {
  async function planOf(count: number, bytes = 600, extra: { maxFiles?: number } = {}): Promise<void> {
    const files = names(count);
    await sizedFiles(files, bytes);
    await writeRadius(files.map((file) => drop(file)));
    await ensureChunkPlan(packageDir, root, extra);
  }

  test("hands out one chunk at a time on the middle tier, review-regression", async () => {
    await planOf(6, 600, { maxFiles: 2 });
    const first = await nextChunk(packageDir);
    expect(first.chunk?.id).toBe("chunk-001");
    expect(first.reviewer).toBe("review-regression");
    expect(first.tier).toBe("middle");
    expect(first.remaining).toBe(3);
    await recordChunk(packageDir, "chunk-001", { status: "DONE", findings: [] });
    expect((await nextChunk(packageDir)).chunk?.id).toBe("chunk-002");
  });

  test("a failed chunk is retried smaller per the retry plan", async () => {
    await planOf(4, 600, { maxFiles: 4 });
    const outcome = await recordChunk(packageDir, "chunk-001", { status: "INCOMPLETE" });
    expect(outcome.decision).toBe("retry");
    expect(outcome.state).toBe("failed");
    const next = await nextChunk(packageDir);
    expect(next.chunk?.retryOf).toEqual(["chunk-001"]);
    expect(next.chunk?.files).toHaveLength(2);
    await recordChunk(packageDir, next.chunk!.id, { status: "DONE" });
    const second = await nextChunk(packageDir);
    await recordChunk(packageDir, second.chunk!.id, { status: "DONE" });
    const pass = await mergeChunkPass(packageDir);
    expect(pass?.chunks[0]?.state).toBe("done");
    expect(pass?.uncoveredFiles).toEqual([]);
  });

  test("a chunk the retry plan gives up on stays pending, never done", async () => {
    await planOf(2, 600, { maxFiles: 2 });
    let last = await recordChunk(packageDir, "chunk-001", { status: "BLOCKED" });
    for (let round = 0; round < 8 && last.decision !== "not-run"; round += 1) {
      const next = await nextChunk(packageDir);
      if (next.chunk === null) break;
      last = await recordChunk(packageDir, next.chunk.id, { status: "BLOCKED" });
    }
    expect(last.decision).toBe("not-run");
    expect(last.state).toBe("pending");
    const pass = await mergeChunkPass(packageDir);
    expect(pass?.chunks[0]?.state).toBe("pending");
    expect(pass?.uncoveredFiles.length).toBe(2);
  });

  test("merge writes chunk-pass.json with per-chunk state and collapses duplicates by file and line", async () => {
    await planOf(4, 600, { maxFiles: 2 });
    await recordChunk(packageDir, "chunk-001", { status: "DONE", findings: [{ file: "src/x.ts", line: 3, severity: "low", title: "a" }, { file: "src/y.ts", line: 9, severity: "high", title: "b" }] });
    await recordChunk(packageDir, "chunk-002", { status: "INCOMPLETE" });
    const pass = await mergeChunkPass(packageDir);
    expect(existsSync(path.join(packageDir, CHUNK_PASS_FILE))).toBe(true);
    expect(pass?.chunks.map((chunk) => [chunk.id, chunk.state])).toEqual([["chunk-001", "done"], ["chunk-002", "failed"]]);
    expect(pass?.totals).toMatchObject({ chunks: 2, files: 4, done: 1, failed: 1, pending: 0 });
    expect(pass?.findings).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(packageDir, CHUNK_PASS_FILE), "utf8"))).toEqual(pass as object);
  });

  test("two findings on one file and line collapse into the more severe one", () => {
    const merged = mergeFindings([
      { chunk: "chunk-001", findings: [{ file: "src/x.ts", line: 3, severity: "low", title: "weak" }] },
      { chunk: "chunk-002", findings: [{ file: "src/x.ts", line: 3, severity: "high", title: "strong" }, { file: "src/x.ts", line: 4, severity: "low", title: "other" }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ file: "src/x.ts", line: 3, severity: "high", title: "strong", chunks: ["chunk-001", "chunk-002"] });
  });
});
