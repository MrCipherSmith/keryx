import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TOOL_OUTPUT_DIRNAME,
  TOOL_OUTPUT_PREVIEW_CHARS,
  TOOL_OUTPUT_SPILL_MAX_BYTES,
  TOOL_OUTPUT_SPILL_MAX_LINES,
  spillLargeToolOutput,
  spillToolOutput,
  writeToolOutputFile,
} from "./output-spill";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "spill-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** The one file in `<dir>/tool-output`. */
function only(dir: string): string {
  const names = readdirSync(path.join(dir, TOOL_OUTPUT_DIRNAME));
  expect(names).toHaveLength(1);
  return names[0] as string;
}

describe("flow 387 T10 spillLargeToolOutput (AC7)", () => {
  test("over the byte threshold: file equals original, model gets head/tail/counts/path", async () => {
    const dir = tmp();
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const original = lines.join("\n");
    expect(Buffer.byteLength(original)).toBeGreaterThan(TOOL_OUTPUT_SPILL_MAX_BYTES);
    const visible = await spillLargeToolOutput(original, { sessionDir: dir, toolCallId: "call_1" });
    const file = path.join(dir, TOOL_OUTPUT_DIRNAME, only(dir));
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(visible.startsWith("line 0 ")).toBe(true);
    expect(visible.endsWith("x".repeat(60))).toBe(true);
    expect(visible).toContain("line 1499");
    expect(visible).toContain("1500 lines");
    expect(visible).toContain(`${Buffer.byteLength(original)} bytes`);
    expect(visible).toContain(file);
    // Flow 387 T14: the hint names the real tools and their real input fields.
    expect(visible).toContain(`read_file {"path": ${JSON.stringify(file)}, "start_line": <line>}`);
    expect(visible).toContain(`search_code {"pattern": "<regex>", "path": ${JSON.stringify(file)}}`);
    expect(visible.length).toBeLessThan(TOOL_OUTPUT_PREVIEW_CHARS + 900);
  });

  test("over the line threshold with short lines also spills", async () => {
    const dir = tmp();
    const original = Array.from({ length: TOOL_OUTPUT_SPILL_MAX_LINES + 1 }, () => "ab").join("\n");
    expect(Buffer.byteLength(original)).toBeLessThan(TOOL_OUTPUT_SPILL_MAX_BYTES);
    const visible = await spillLargeToolOutput(original, { sessionDir: dir, toolCallId: "c2" });
    expect(readFileSync(path.join(dir, TOOL_OUTPUT_DIRNAME, only(dir)), "utf8")).toBe(original);
    expect(visible).toContain("2001 lines");
  });

  test("under both thresholds is untouched and writes nothing", async () => {
    const dir = tmp();
    const small = "hello\nworld";
    expect(await spillLargeToolOutput(small, { sessionDir: dir, toolCallId: "c3" })).toBe(small);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("no session dir falls back to the original text", async () => {
    const big = "y".repeat(TOOL_OUTPUT_SPILL_MAX_BYTES + 10);
    expect(await spillLargeToolOutput(big, { sessionDir: undefined, toolCallId: "c4" })).toBe(big);
  });

  test("a hostile tool call id cannot escape the tool-output dir", async () => {
    const dir = tmp();
    const big = "z".repeat(TOOL_OUTPUT_SPILL_MAX_BYTES + 10);
    await spillLargeToolOutput(big, { sessionDir: dir, toolCallId: "../../evil" });
    const names = readdirSync(path.join(dir, TOOL_OUTPUT_DIRNAME));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d+-[0-9a-f]{8}-______evil\.txt$/);
  });
});

describe("flow 387 review r1 spill files", () => {
  test("F-004: two rounds with the same toolCallId write two intact files", async () => {
    const dir = tmp();
    const first = "a".repeat(TOOL_OUTPUT_SPILL_MAX_BYTES + 10);
    const second = "b".repeat(TOOL_OUTPUT_SPILL_MAX_BYTES + 10);
    const one = await spillToolOutput(first, { sessionDir: dir, toolCallId: "read_file#0" });
    const two = await spillToolOutput(second, { sessionDir: dir, toolCallId: "read_file#0" });
    expect(one.spillPath).toBeDefined();
    expect(two.spillPath).toBeDefined();
    expect(one.spillPath).not.toBe(two.spillPath);
    expect(readFileSync(one.spillPath as string, "utf8")).toBe(first);
    expect(readFileSync(two.spillPath as string, "utf8")).toBe(second);
    expect(one.text).toContain(one.spillPath as string);
    expect(two.text).toContain(two.spillPath as string);
    expect(readdirSync(path.join(dir, TOOL_OUTPUT_DIRNAME))).toHaveLength(2);
  });

  test("F-004: identical content under the same id in the same millisecond still gets a distinct file", async () => {
    const dir = tmp();
    const same = "c".repeat(TOOL_OUTPUT_SPILL_MAX_BYTES + 10);
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async () => (await spillToolOutput(same, { sessionDir: dir, toolCallId: "call_idx:0" })).spillPath),
      );
      expect(new Set(paths).size).toBe(5);
      for (const p of paths) {
        expect(readFileSync(p as string, "utf8")).toBe(same);
      }
    } finally {
      Date.now = realNow;
    }
  });

  test("F-011: the directory is 0700 and each file 0600", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tmp();
    const spilled = await spillToolOutput("d".repeat(TOOL_OUTPUT_SPILL_MAX_BYTES + 10), { sessionDir: dir, toolCallId: "m1" });
    const written = await writeToolOutputFile(dir, "m2", "small");
    expect(statSync(path.join(dir, TOOL_OUTPUT_DIRNAME)).mode & 0o777).toBe(0o700);
    expect(statSync(spilled.spillPath as string).mode & 0o777).toBe(0o600);
    expect(statSync(written as string).mode & 0o777).toBe(0o600);
  });

  test("an under-threshold output returns no spillPath", async () => {
    const dir = tmp();
    expect((await spillToolOutput("tiny", { sessionDir: dir, toolCallId: "m3" })).spillPath).toBeUndefined();
  });
});
