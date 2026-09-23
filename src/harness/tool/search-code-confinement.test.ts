// `search_code` confinement by REAL path (flow 292 T13, security review item 1).
//
// The probe that found it: `search_code {pattern:"TOPSECRET", path:"lnkdir"}`,
// with `lnkdir` an in-root symlink to a directory OUTSIDE the project, returned
// the outside file's content. The path check was lexical, and ripgrep follows a
// symlink it is named explicitly even without `--follow`. This `search_code`
// backs `keryx serve-mcp --read-only` (what a foreign ACP agent is handed) and
// the keryx shell / ACP sessions, so every test here runs the REAL ripgrep.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinMetaprojectTools } from "./builtin/metaproject-tools";
import { createMetaprojectAdapter } from "./metaproject-adapter";

const SECRET = "TOPSECRET-outside-the-project";

let base = "";
let root = "";
let outside = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-search-confine-")));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "src", "inside.ts"), "export const marker = 'TOPSECRET-inside';\n");
  writeFileSync(path.join(outside, "secret.txt"), `${SECRET}\n`);
  symlinkSync(outside, path.join(root, "lnkdir"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "lnkfile.txt"));
  symlinkSync(path.join(root, "src"), path.join(root, "alias"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("search_code (the adapter behind serve-mcp and the sessions)", () => {
  test("a symlinked directory pointing outside is refused, and the outside content never appears", async () => {
    const result = await createMetaprojectAdapter(root).searchCode({ pattern: "TOPSECRET", path: "lnkdir" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("escapes the project root");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a symlinked file pointing outside is refused", async () => {
    const result = await createMetaprojectAdapter(root).searchCode({ pattern: "TOPSECRET", path: "lnkfile.txt" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a path THROUGH an outward symlink is refused", async () => {
    const result = await createMetaprojectAdapter(root).searchCode({ pattern: "TOPSECRET", path: "lnkdir/secret.txt" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("an in-root symlink to an in-root directory still searches — its real target", async () => {
    const result = await createMetaprojectAdapter(root).searchCode({ pattern: "TOPSECRET", path: "alias" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("TOPSECRET-inside");
    // Handed the RESOLVED path, not the link name.
    expect(result.output).toContain("src/inside.ts");
  });

  test("a whole-root search does not walk into an outward symlink", async () => {
    const result = await createMetaprojectAdapter(root).searchCode({ pattern: "TOPSECRET" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("TOPSECRET-inside");
    expect(result.output).not.toContain(SECRET);
  });
});

describe("the ctx-rg fallback of search_code", () => {
  test("a model pattern that looks like a flag stays a pattern (`--` precedes it)", async () => {
    const calls: string[][] = [];
    const tools = builtinMetaprojectTools(root, async (args) => {
      calls.push(args);
      return { output: "", isError: false };
    });
    const searchCode = tools.find((tool) => tool.definition.name === "search_code");
    await searchCode?.invoke({ pattern: "--follow", path: "src" }, {});
    expect(calls[0]?.slice(0, 4)).toEqual(["ctx", "rg", "--", "--follow"]);
  });

  test("the fallback also refuses an outward symlinked directory", async () => {
    const calls: string[][] = [];
    const tools = builtinMetaprojectTools(root, async (args) => {
      calls.push(args);
      return { output: "", isError: false };
    });
    const searchCode = tools.find((tool) => tool.definition.name === "search_code");
    const result = await searchCode?.invoke({ pattern: "TOPSECRET", path: "lnkdir" }, {});
    expect(result?.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
