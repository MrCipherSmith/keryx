import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyToolCall, countLayerUsage, layersUsedFrom, readToolLog, summarizeLayersUsage } from "./layers-usage";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-layers-usage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("layers used by a reviewer run, counted from its tool-call log (AC7)", () => {
  test("classifies CLI commands and MCP tools into the four layers", () => {
    expect(classifyToolCall("keryx gdgraph affected src/a.ts")).toBe("graph");
    expect(classifyToolCall("mcp__keryx__graph_symbol")).toBe("graph");
    expect(classifyToolCall('keryx wiki ask "why"')).toBe("wiki");
    expect(classifyToolCall("mcp__keryx__read_wiki")).toBe("wiki");
    expect(classifyToolCall('keryx memory search "x"')).toBe("memory");
    expect(classifyToolCall("keryx ctx rg foo")).toBe("ctx");
    expect(classifyToolCall("mcp__keryx__search_code")).toBe("ctx");
    expect(classifyToolCall("git diff HEAD")).toBeUndefined();
    expect(classifyToolCall("Read src/a.ts")).toBeUndefined();
  });

  test("counts JSON lines and plain command lines, one call each", () => {
    const log = [
      JSON.stringify({ name: "Bash", input: { command: "keryx gdgraph affected src/a.ts" } }),
      JSON.stringify({ name: "mcp__keryx__gdgraph_affected", arguments: "{}" }),
      JSON.stringify({ name: "Bash", command: 'keryx wiki ask "q"' }),
      JSON.stringify({ name: "Read", input: { file_path: "src/a.ts" } }),
      "keryx ctx rg needle",
      "",
    ].join("\n");
    expect(countLayerUsage(log)).toEqual({ graph: 2, wiki: 1, memory: 0, ctx: 1 });
  });

  test("a log with calls but none into a layer is a real zero", () => {
    expect(layersUsedFrom(JSON.stringify({ name: "Read" }))).toEqual({ graph: 0, wiki: 0, memory: 0, ctx: 0 });
  });

  test("an empty or blank log is unknown, never a claim that nothing was used", () => {
    const unknown = { graph: "unknown", wiki: "unknown", memory: "unknown", ctx: "unknown" } as const;
    expect(layersUsedFrom("")).toEqual(unknown);
    expect(layersUsedFrom(" \n\t\n")).toEqual(unknown);
  });

  test("a missing log is unknown on every layer, never zero", () => {
    expect(layersUsedFrom(undefined)).toEqual({ graph: "unknown", wiki: "unknown", memory: "unknown", ctx: "unknown" });
  });

  test("reads <input>/tool-calls/<reviewer>.jsonl by default and a driver-named log when given", async () => {
    await mkdir(path.join(dir, "tool-calls"), { recursive: true });
    await writeFile(path.join(dir, "tool-calls", "review-logic.jsonl"), "keryx ctx rg x\n", "utf8");
    await writeFile(path.join(dir, "mine.log"), "keryx memory search y\n", "utf8");
    expect(await readToolLog(dir, "review-logic")).toBe("keryx ctx rg x\n");
    expect(await readToolLog(dir, "review-logic", "mine.log")).toBe("keryx memory search y\n");
    expect(await readToolLog(dir, "review-security-code")).toBeUndefined();
  });

  test("a driver-named log outside the input directory is not read", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "keryx-layers-outside-"));
    try {
      await writeFile(path.join(outside, "secret.log"), "keryx ctx rg x\n", "utf8");
      expect(await readToolLog(dir, "review-logic", path.join(outside, "secret.log"))).toBeUndefined();
      expect(await readToolLog(dir, "review-logic", "../escape.log")).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a driver-named log that is a symlink out of the input directory, or not a regular file, is not read", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "keryx-layers-outside-"));
    try {
      await writeFile(path.join(outside, "secret.log"), "keryx ctx rg x\n", "utf8");
      await symlink(path.join(outside, "secret.log"), path.join(dir, "link.log"));
      await mkdir(path.join(dir, "a-directory.log"));
      expect(await readToolLog(dir, "review-logic", "link.log")).toBeUndefined();
      expect(await readToolLog(dir, "review-logic", "a-directory.log")).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("a driver-named log that is a FIFO is refused without being opened", async () => {
    execFileSync("mkfifo", [path.join(dir, "pipe.log")]);
    expect(await readToolLog(dir, "review-logic", "pipe.log")).toBeUndefined();
  });

  test("the panel summary counts reviewers without a log as unknown, and skips reviewers that did not run", () => {
    const summary = summarizeLayersUsage([
      { reviewer: "a", status: "complete", layersUsed: { graph: 2, wiki: 0, memory: 0, ctx: 1 } },
      { reviewer: "b", status: "complete", layersUsed: { graph: 0, wiki: 0, memory: 0, ctx: 0 } },
      { reviewer: "c", status: "complete", layersUsed: { graph: "unknown", wiki: "unknown", memory: "unknown", ctx: "unknown" } },
      { reviewer: "d", status: "incomplete" },
      { reviewer: "e", status: "not-run" },
    ]);
    expect(summary).toEqual({ withLog: 2, usedAny: 1, unknown: 2, total: 4, perLayer: { graph: 1, wiki: 0, memory: 0, ctx: 1 } });
  });
});
