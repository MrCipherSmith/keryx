// Flow 115 follow-up / stress findings T1 and L3: `read_file` applied its 20 KB
// cap AFTER loading the entire file into memory.
//
// Measured: a 256 MiB file cost +246 MiB RSS to return 20 KB of text, and 20
// concurrent reads of a 16 MiB file peaked at +301 MiB. There was no size
// pre-check, no streaming, and no concurrency limit — a plausible path to OOM
// from a single tool call the model can issue freely.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinReadOnlyTools } from "./interactive-tools";

// NB: must await `fn` before cleaning up — a sync `finally` would delete the
// fixture at the callback's first suspension point, mid-test.
async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-read-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readTool(root: string) {
  const tool = builtinReadOnlyTools(root).find((t) => t.definition.name === "read_file");
  if (tool === undefined) throw new Error("read_file tool missing");
  return tool;
}

test("a large file is bounded WITHOUT being loaded whole", async () => {
  await withRoot(async (root) => {
    const mib = 96;
    const file = path.join(root, "big.bin");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const writer = Bun.file(file).writer();
    for (let i = 0; i < mib; i++) writer.write(chunk);
    await writer.end();

    Bun.gc(true);
    const before = process.memoryUsage().rss / 1024 / 1024;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss / 1024 / 1024);
    }, 10);
    const result = await readTool(root).invoke({ path: "big.bin" });
    clearInterval(sampler);

    expect(result.isError).toBe(false);
    expect(result.output.length).toBeLessThan(32_000);
    expect(result.output).toMatch(/truncated/i);
    // The whole point: reading 96 MiB must not cost anything like 96 MiB.
    expect(peak - before).toBeLessThan(mib / 2);
  });
});

test("the truncation notice states the real size so the model is not misled", async () => {
  await withRoot(async (root) => {
    const file = path.join(root, "medium.txt");
    writeFileSync(file, "x".repeat(50_000));
    const result = await readTool(root).invoke({ path: "medium.txt" });
    expect(result.output).toMatch(/50000|50,000/);
  });
});

test("a small file is returned verbatim, with no notice", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "small.txt"), "hello\nworld\n");
    const result = await readTool(root).invoke({ path: "small.txt" });
    expect(result.output).toBe("hello\nworld\n");
    expect(result.isError).toBe(false);
  });
});

test("a missing file and a directory are still errors, not crashes", async () => {
  await withRoot(async (root) => {
    const missing = await readTool(root).invoke({ path: "nope.txt" });
    expect(missing.isError).toBe(true);
    const dir = await readTool(root).invoke({ path: "." });
    expect(dir.isError).toBe(true);
  });
});
