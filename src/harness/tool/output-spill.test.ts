import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TOOL_OUTPUT_DIRNAME,
  TOOL_OUTPUT_PREVIEW_CHARS,
  TOOL_OUTPUT_SPILL_MAX_BYTES,
  TOOL_OUTPUT_SPILL_MAX_LINES,
  isInsideToolOutputDir,
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
  test("two rounds with the same toolCallId write two intact files", async () => {
    // flow 387 review r1 F-004
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

  test("identical content under the same id in the same millisecond still gets a distinct file", async () => {
    // flow 387 review r1 F-004
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

  test("the directory is 0700 and each file 0600", async () => {
    // flow 387 review r1 F-011
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

// flow 387 review r2 F-028: the check prune applies to a recorded `spillPath`. It is LEXICAL by
// design (no realpath), so a tampered path can never name a placeholder target outside the
// directory; `read_file` still resolves real paths before it opens anything.
describe("isInsideToolOutputDir", () => {
  const session = path.join(path.sep, "sessions", "s1");
  const inside = path.join(session, TOOL_OUTPUT_DIRNAME);

  test.each([
    ["a file directly inside", path.join(inside, "1-aaaaaaaa-c0.txt"), true],
    ["a file in a nested directory", path.join(inside, "sub", "c0.txt"), true],
    ["the directory itself", inside, false],
    ["the directory with a trailing separator", `${inside}${path.sep}`, false],
    ["a sibling whose name starts with the directory name", `${inside}-evil${path.sep}c0.txt`, false],
    ["a path that climbs out with ..", path.join(inside, "..", "x.txt"), false],
    ["a path that climbs out and back in with ..", path.join(inside, "..", TOOL_OUTPUT_DIRNAME, "c0.txt"), true],
    ["another file in the session dir", path.join(session, "context.jsonl"), false],
    ["an unrelated absolute path", "/etc/passwd", false],
    ["a relative path", path.join(TOOL_OUTPUT_DIRNAME, "c0.txt"), false],
    ["an empty path", "", false],
  ])("%s", (_name, candidate, expected) => {
    expect(isInsideToolOutputDir(session, candidate)).toBe(expected);
  });

  test("is lexical: a symlink inside the directory is accepted by name, not followed", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tmp();
    const outside = tmp();
    mkdirSync(path.join(dir, TOOL_OUTPUT_DIRNAME));
    const link = path.join(dir, TOOL_OUTPUT_DIRNAME, "link.txt");
    symlinkSync(path.join(outside, "secret.txt"), link);
    expect(isInsideToolOutputDir(dir, link)).toBe(true);
  });
});
