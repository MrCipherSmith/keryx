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

// S-1 (arena, flow 249): content past the first 20 KB was unreachable — there was
// no offset or range, so re-reading returned the same head forever.
function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1} ${"-".repeat(40)}`).join("\n") + "\n";
}

test("start_line reaches a line located past the first 20,000 bytes", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "long.ts"), numbered(2000)); // ~100 KB
    const head = await readTool(root).invoke({ path: "long.ts" });
    expect(head.output).not.toContain("line 1500 ");
    const deep = await readTool(root).invoke({ path: "long.ts", start_line: 1500 });
    expect(deep.isError).toBe(false);
    expect(deep.output.startsWith("line 1500 ")).toBe(true);
  });
});

test("a truncated read names the start_line to continue from, and paging loses nothing", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "long.ts"), numbered(2000));
    const seen: string[] = [];
    let start = 1;
    for (let guard = 0; guard < 50; guard++) {
      const result = await readTool(root).invoke({ path: "long.ts", start_line: start });
      const notice = /…\(truncated: showed lines \d+–\d+ of a \d+-byte file; continue with start_line: (\d+)\)$/.exec(result.output);
      const body = notice === null ? result.output : result.output.slice(0, notice.index - 1);
      seen.push(...body.split("\n").filter(Boolean));
      if (notice === null) break;
      start = Number(notice[1]);
    }
    expect(seen).toHaveLength(2000);
    expect(seen[0]).toStartWith("line 1 ");
    expect(seen.at(-1)).toStartWith("line 2000 ");
  });
});

test("start_line past the end is an error that states the file's real length", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "short.txt"), "a\nb\nc\n");
    const far = await readTool(root).invoke({ path: "short.txt", start_line: 10 });
    expect(far.isError).toBe(true);
    expect(far.output).toContain("it has 3 lines");
    // One past the last line of a newline-terminated file is past the end too —
    // not an empty success (review F-002).
    const justPast = await readTool(root).invoke({ path: "short.txt", start_line: 4 });
    expect(justPast.isError).toBe(true);
    expect(justPast.output).toContain("it has 3 lines");
    expect((await readTool(root).invoke({ path: "short.txt", start_line: 3 })).output).toBe("c\n");
    writeFileSync(path.join(root, "open.txt"), "a\nb");
    expect((await readTool(root).invoke({ path: "open.txt", start_line: 2 })).output).toBe("b");
    const openPast = await readTool(root).invoke({ path: "open.txt", start_line: 3 });
    expect(openPast.output).toContain("it has 2 lines");
    writeFileSync(path.join(root, "empty.txt"), "");
    expect((await readTool(root).invoke({ path: "empty.txt", start_line: 2 })).output).toContain("it has 0 lines");
  });
});

test("the truncation notice counts lines from start_line, not bytes against the whole file", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "long.ts"), numbered(2000));
    const result = await readTool(root).invoke({ path: "long.ts", start_line: 1500 });
    expect(result.output).toMatch(/…\(truncated: showed lines 1500–\d+ of a \d+-byte file; continue with start_line: \d+\)$/);
  });
});

test("a non-positive or fractional start_line is refused", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "short.txt"), "a\n");
    for (const bad of [0, -3, 1.5, "2"]) {
      const result = await readTool(root).invoke({ path: "short.txt", start_line: bad });
      expect(result.isError).toBe(true);
    }
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
