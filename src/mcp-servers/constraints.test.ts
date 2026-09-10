// AC10 and AC11: the things this package promised NOT to do.
//
// Every assertion here is about an absence, and an absence is the hardest
// kind of claim to keep true — nothing fails when someone adds the thing.
// So each one is checked against the real artifact (the registry array, the
// source text, the module graph), never against a restatement of it.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_REGISTRY } from "../capability/registry";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => path.join(dir, e.name));
}

/**
 * The file with comments removed.
 *
 * Required, not tidiness. These tests forbid NAMING certain paths, and the
 * clearest possible documentation of "this module never writes
 * `.metaproject/core/mcp/mcp.config.json`" is a comment saying exactly that.
 * Scanning raw text would fail the file for explaining the rule it obeys, and
 * the cheapest way to pass would be to delete the explanation.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("AC10 — no new capability flag", () => {
  test("CAPABILITY_REGISTRY gains no entry for MCP servers", () => {
    // Pinned so a later phase cannot add one without the decision being
    // visible in a diff to this test (D-10: no new `src/capability/`
    // ceiling).
    const ids = CAPABILITY_REGISTRY.map((descriptor) => descriptor.id);
    expect(ids.filter((id) => id.toLowerCase().includes("mcp"))).toEqual([]);
  });

  test("the registry is non-empty, so the assertion above is not vacuous", () => {
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
  });

  test("no file in src/mcp-servers/ reads the capability registry at all", () => {
    for (const file of productionFiles(HERE)) {
      expect({ file: path.basename(file), imports: code(file).includes("capability/") }).toEqual({
        file: path.basename(file),
        imports: false,
      });
    }
  });
});

describe("AC11 — no static SDK import on a path `keryx --help` loads", () => {
  test("nothing in src/mcp-servers/ statically imports the MCP SDK", () => {
    // The SDK is an optional dependency. A static import anywhere reachable
    // from the CLI entry makes `keryx --help` fail on a machine that never
    // installed it — which is why `client.ts` loads it through `loadCoreSdk`
    // at call time.
    for (const file of productionFiles(HERE)) {
      const statics = code(file)
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) && line.includes("@modelcontextprotocol/sdk"));
      expect({ file: path.basename(file), statics }).toEqual({ file: path.basename(file), statics: [] });
    }
  });

  test("the CLI still starts and prints help, with the MCP subcommands listed", async () => {
    // The end-to-end version of the assertion above: not "no import line"
    // but "the binary runs". Driven from SOURCE — the installed keryx
    // predates this work by construction.
    const result = Bun.spawnSync({
      cmd: ["bun", path.join(SRC, "cli.ts"), "mcp", "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(out).toContain("keryx mcp");
  });
});

describe("AC11 — this package writes no config it does not own", () => {
  test("no file in src/mcp-servers/ names a foreign config path", () => {
    // The compat sources are READ-ONLY by specification, and the inbound
    // `serve-mcp` config belongs to another surface entirely. None of them
    // should appear here at all: this package has no reader for them yet
    // (P3) and must never gain a writer.
    const foreign = [
      "mcp.config.json", // inbound serve-mcp
      ".cursor/mcp.json",
      ".claude.json",
      ".mcp.json",
    ];
    for (const file of productionFiles(HERE)) {
      const text = code(file);
      expect({ file: path.basename(file), hits: foreign.filter((name) => text.includes(name)) }).toEqual({
        file: path.basename(file),
        hits: [],
      });
    }
  });

  test("the only files the store writes are the two native ones plus the overlay", () => {
    const text = code(path.join(HERE, "store.ts"));
    // Every write goes through one of these three path builders; a fourth
    // destination would have to add a fourth.
    expect(text).toContain("export function userConfigFile");
    expect(text).toContain("export function projectConfigFile");
    expect(text).toContain("export function overlayFile");
    // And nothing constructs a path from a raw string join to elsewhere.
    expect(text).not.toContain(".cursor");
    expect(text).not.toContain(".metaproject");
  });
});

describe("AC11 — the Codex specialist is untouched", () => {
  test("nothing here imports or names the Codex MCP path (D-12)", () => {
    // D-12: `codex mcp-server` stays the elicitation supervisor's child and
    // is never a `use_tool` target. Sharing `src/mcp-client/` is the point;
    // reaching into the Codex-specific half is not.
    for (const file of productionFiles(HERE)) {
      const text = code(file);
      const hits = ["connectCodexMcpClient", "gatedSuperviseCodexMcpRun"].filter((name) =>
        new RegExp(`^\\s*import[^\n]*${name}`, "m").test(text),
      );
      expect({ file: path.basename(file), hits }).toEqual({ file: path.basename(file), hits: [] });
    }
  });
});
