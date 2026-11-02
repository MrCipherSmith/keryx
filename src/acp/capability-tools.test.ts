// The client-routed read_file keeps the local read_file contract: the same
// 20,000-character cap and continuation notice, the same start_line rule, and
// the same past-the-end error (perimeter review, logic-03 F-001).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { acpAwareReadFileTool } from "./capability-tools";

let root = "";
let local: InteractiveTool;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-read-")));
  local = builtinReadOnlyTools(root).find((t) => t.definition.name === "read_file")!;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 2,000 numbered lines of 20 characters each: 40,000 characters in all. */
function bigText(): string {
  return Array.from({ length: 2000 }, (_, i) => `line ${String(i + 1).padStart(5, "0")} ........\n`).join("");
}

/** A client that serves `text` from the requested line, like fs/read_text_file does. */
function clientServing(text: string, calls: (number | undefined)[] = []) {
  return async (_path: string, line?: number) => {
    calls.push(line);
    return text.split(/(?<=\n)/).slice((line ?? 1) - 1).join("");
  };
}

function viaClient(text: string, calls?: (number | undefined)[]): InteractiveTool {
  return acpAwareReadFileTool(local, root, { fs: { readTextFile: true } }, clientServing(text, calls));
}

describe("client-routed read_file honours the local read_file contract", () => {
  test("a file over 20,000 characters is capped and paged exactly like the local tool", async () => {
    const text = bigText();
    writeFileSync(path.join(root, "big.txt"), text, "utf8");
    const client = await viaClient(text).invoke({ path: "big.txt" });
    const disk = await local.invoke({ path: "big.txt" });

    expect(client.isError).toBe(false);
    expect(client.output.length).toBeLessThan(20_200);
    expect(client.output.slice(-120)).toContain("continue with start_line: 1001");
    // Same text, same continuation line; only the notice names its source differently.
    expect(client.output.split("\n…(")[0]).toBe(disk.output.split("\n…(")[0]);
  });

  test("a later page starts and continues on the same lines as the local tool", async () => {
    const text = bigText();
    writeFileSync(path.join(root, "big.txt"), text, "utf8");
    const calls: (number | undefined)[] = [];
    const client = await viaClient(text, calls).invoke({ path: "big.txt", start_line: 500 });
    const disk = await local.invoke({ path: "big.txt", start_line: 500 });

    expect(calls).toEqual([500]);
    expect(client.output.slice(0, 10)).toBe("line 00500");
    expect(client.output.slice(-120)).toContain("showed lines 500–1499 of the file; continue with start_line: 1500");
    expect(disk.output.slice(-120)).toContain("continue with start_line: 1500");
    expect(client.output.split("\n…(")[0]).toBe(disk.output.split("\n…(")[0]);
  });

  test("a small file comes back whole, with no notice", async () => {
    const out = await viaClient("served by the client").invoke({ path: "small.txt" });
    expect(out).toEqual({ output: "served by the client", isError: false });
  });

  test.each([0, -5, 2.5, "10"])("start_line %p is refused before any client round trip", async (startLine) => {
    const calls: (number | undefined)[] = [];
    const out = await viaClient("anything", calls).invoke({ path: "small.txt", start_line: startLine });
    expect(out).toEqual({ output: "read_file: start_line must be a positive integer", isError: true });
    expect(calls).toEqual([]);
  });

  test("start_line past the end reports past-the-end, not an empty success", async () => {
    writeFileSync(path.join(root, "short.txt"), "one\ntwo\n", "utf8");
    const out = await viaClient("one\ntwo\n").invoke({ path: "short.txt", start_line: 50 });
    expect(out).toEqual({ output: "read_file: start_line 50 is past the end of the file (it has 2 lines)", isError: true });
  });
});
