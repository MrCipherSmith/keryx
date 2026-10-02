import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_OUTPUT_DIRNAME, resolveSpillReadable } from "../output-spill";
import { builtinReadOnlyTools, type InteractiveTool } from "./interactive-tools";
import { applyPatchTool } from "./apply-patch-tool";
import { withSpillSearch } from "./spill-search";

// Flow 387 T14: read_file / search_code may read the live session's spilled output
// by absolute path, and nothing else outside the project root.

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "spill-read-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const project = tmp();
  const dataDir = tmp();
  const sessionDir = path.join(dataDir, "sessions", "s1");
  const spillDir = path.join(sessionDir, TOOL_OUTPUT_DIRNAME);
  mkdirSync(spillDir, { recursive: true });
  const lines = Array.from({ length: 3000 }, (_, i) => `row ${i} ${"p".repeat(30)}`);
  const spillFile = path.join(spillDir, "call_1.txt");
  writeFileSync(spillFile, lines.join("\n"));
  const secret = path.join(dataDir, "sessions", "credentials.json");
  writeFileSync(secret, "TOP-SECRET");
  const otherSession = path.join(dataDir, "sessions", "s2", TOOL_OUTPUT_DIRNAME);
  mkdirSync(otherSession, { recursive: true });
  const otherFile = path.join(otherSession, "x.txt");
  writeFileSync(otherFile, "other session");
  const readFile = builtinReadOnlyTools(project, { getSessionDir: () => sessionDir }).find(
    (t) => t.definition.name === "read_file",
  ) as InteractiveTool;
  return { project, dataDir, sessionDir, spillDir, spillFile, secret, otherFile, readFile };
}

describe("flow 387 T14 read_file on spilled output", () => {
  test("reads a spilled file by absolute path and pages it with start_line", async () => {
    const f = fixture();
    const first = await f.readFile.invoke({ path: f.spillFile });
    expect(first.isError).toBe(false);
    expect(first.output).toContain("row 0 ");
    const next = /start_line: (\d+)/.exec(first.output);
    expect(next).not.toBeNull();
    const second = await f.readFile.invoke({ path: f.spillFile, start_line: Number(next?.[1]) });
    expect(second.isError).toBe(false);
    expect(second.output).toContain(`row ${Number(next?.[1]) - 1} `);
  });

  test("another path in the data dir is rejected", async () => {
    const f = fixture();
    for (const p of [f.secret, f.otherFile, f.sessionDir, path.join(f.sessionDir, "slate.json")]) {
      const result = await f.readFile.invoke({ path: p });
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain("TOP-SECRET");
    }
  });

  test("a .. escape out of tool-output is rejected", async () => {
    const f = fixture();
    const viaDots = path.join(f.spillDir, "..", "..", "credentials.json");
    const result = await f.readFile.invoke({ path: viaDots });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("TOP-SECRET");
  });

  test("a symlink inside tool-output pointing outside is rejected", async () => {
    const f = fixture();
    const link = path.join(f.spillDir, "link.txt");
    symlinkSync(f.secret, link);
    const result = await f.readFile.invoke({ path: link });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("TOP-SECRET");
  });

  test("without a session dir nothing outside the project is readable", async () => {
    const f = fixture();
    const bare = builtinReadOnlyTools(f.project).find((t) => t.definition.name === "read_file") as InteractiveTool;
    expect((await bare.invoke({ path: f.spillFile })).isError).toBe(true);
  });

  test("a relative path keeps meaning project-relative", async () => {
    const f = fixture();
    writeFileSync(path.join(f.project, "a.txt"), "in project");
    expect((await f.readFile.invoke({ path: "a.txt" })).output).toBe("in project");
    expect((await f.readFile.invoke({ path: "call_1.txt" })).isError).toBe(true);
  });
});

describe("flow 387 T14 resolveSpillReadable", () => {
  test("accepts the dir and entries, refuses siblings that share the prefix", () => {
    const f = fixture();
    expect(resolveSpillReadable(f.sessionDir, f.spillDir)).toBe(f.spillDir);
    expect(resolveSpillReadable(f.sessionDir, f.spillFile)).toBe(f.spillFile);
    const sibling = path.join(f.sessionDir, `${TOOL_OUTPUT_DIRNAME}-evil`);
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, "e.txt"), "e");
    expect(resolveSpillReadable(f.sessionDir, path.join(sibling, "e.txt"))).toBeNull();
    expect(resolveSpillReadable(f.sessionDir, path.join(f.spillDir, "missing.txt"))).toBeNull();
    expect(resolveSpillReadable(undefined, f.spillFile)).toBeNull();
  });
});

describe("flow 387 T14 write tools never gain the spill dir", () => {
  test("apply_patch still rejects a path in the spill dir", async () => {
    const f = fixture();
    const tool = applyPatchTool(f.project);
    const patch = [
      `--- a/${f.spillFile}`,
      `+++ b/${f.spillFile}`,
      "@@ -1 +1 @@",
      "-row 0 pppppppppppppppppppppppppppppp",
      "+tampered",
      "",
    ].join("\n");
    const result = await tool.invoke({ patch });
    expect(result.isError).toBe(true);
    expect(await Bun.file(f.spillFile).text()).toContain("row 0 ");
  });
});

describe("flow 387 T14 search_code on spilled output", () => {
  function base(): { tool: InteractiveTool; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    const tool: InteractiveTool = {
      definition: {
        name: "search_code",
        description: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "read",
      },
      invoke: async (input) => {
        calls.push(input);
        return { output: "project search", isError: false };
      },
    };
    return { tool, calls };
  }

  test("an absolute spill path is searched with a fixed argv; the wrapped tool is not called", async () => {
    const f = fixture();
    const { tool, calls } = base();
    const seen: string[][] = [];
    const wrapped = withSpillSearch(tool, () => f.sessionDir, async (argv) => {
      seen.push(argv);
      return { stdout: "hit", stderr: "", exitCode: 0 };
    });
    const result = await wrapped.invoke({ pattern: "--pre=/bin/sh", path: f.spillFile });
    expect(result).toEqual({ output: "hit", isError: false });
    expect(calls).toEqual([]);
    expect(seen[0]?.slice(-3)).toEqual(["--", "--pre=/bin/sh", f.spillFile]);
  });

  test("any other path falls through to the wrapped tool", async () => {
    const f = fixture();
    const { tool, calls } = base();
    const wrapped = withSpillSearch(tool, () => f.sessionDir, async () => {
      throw new Error("must not run");
    });
    for (const p of [f.secret, f.otherFile, path.join(f.spillDir, "..", "credentials.json"), "src"]) {
      expect((await wrapped.invoke({ pattern: "x", path: p })).output).toBe("project search");
    }
    expect(calls).toHaveLength(4);
  });
});
