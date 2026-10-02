import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TOOL_OUTPUT_DIRNAME,
  TOOL_OUTPUT_PREVIEW_CHARS,
  TOOL_OUTPUT_SPILL_MAX_BYTES,
  TOOL_OUTPUT_SPILL_MAX_LINES,
  spillLargeToolOutput,
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

describe("flow 387 T10 spillLargeToolOutput (AC7)", () => {
  test("over the byte threshold: file equals original, model gets head/tail/counts/path", async () => {
    const dir = tmp();
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const original = lines.join("\n");
    expect(Buffer.byteLength(original)).toBeGreaterThan(TOOL_OUTPUT_SPILL_MAX_BYTES);
    const visible = await spillLargeToolOutput(original, { sessionDir: dir, toolCallId: "call_1" });
    const file = path.join(dir, TOOL_OUTPUT_DIRNAME, "call_1.txt");
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
    expect(readFileSync(path.join(dir, TOOL_OUTPUT_DIRNAME, "c2.txt"), "utf8")).toBe(original);
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
    expect(readdirSync(path.join(dir, TOOL_OUTPUT_DIRNAME))).toEqual(["______evil.txt"]);
  });
});
