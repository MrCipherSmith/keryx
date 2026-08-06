// `search_code` through the chain it actually runs in production.
//
// Every other test of this tool injects a `KeryxRunner` that spawns `rg`
// directly. That is the right level for the confinement argv — it is what makes
// "end to end against real ripgrep" true — but it means the production chain
//
//     search_code → makeKeryxRunner → `keryx` (from PATH) → keryx ctx rg → rg
//
// was exercised nowhere, and one link in it is not the code under test: `keryx`
// is resolved from PATH, so it may be a DIFFERENT VERSION from the checkout that
// built the tool.
//
// It was. `--no-follow` has only been forwarded by `keryx ctx rg` since
// `377fc325`; against an older install the CLI refuses it and every search fails,
// benign in-root searches included. Measured in this repository: global keryx
// 0.2.9 → `keryx ctx rg: unsupported ripgrep option --no-follow`; the 0.2.16
// checkout → 9 matches for the same call. Fourteen of the fifteen tools an
// unattended run registers were fine; this was the only one that was dead.
//
// So these tests put a real `keryx` on PATH — the checkout's own, and a stand-in
// for an older one — and call the tool with no injected runner at all.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { builtinMetaprojectTools, searchCliSkewMessage } from "./builtin/metaproject-tools";
import { SEARCH_TOOL_FORCED_OPTIONS } from "../../lib/rg-options";

/** `src/cli.ts` of this checkout — the CLI the shim below actually runs. */
const CLI = path.join(import.meta.dir, "..", "..", "cli.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

/**
 * A throwaway project plus a `bin/` holding an executable `keryx`, prepended to
 * PATH for the duration of the test. `body` is the shim's shell source.
 */
function withKeryxOnPath(body: string): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-real-chain-"));
  const root = path.join(base, "proj");
  const outside = path.join(base, "outside");
  const bin = path.join(base, "bin");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(bin, { recursive: true });

  writeFileSync(path.join(root, "src", "app.ts"), "export const CHAIN_MARKER = 1;\n", "utf8");
  writeFileSync(path.join(outside, "secret.txt"), "CHAIN-OUTSIDE-MARKER\n", "utf8");
  symlinkSync(outside, path.join(root, "vendor"));

  const shim = path.join(bin, "keryx");
  writeFileSync(shim, body, "utf8");
  chmodSync(shim, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  cleanups.push(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    rmSync(base, { recursive: true, force: true });
  });
  return { root, outside };
}

/** The production `search_code`: no injected runner, so `makeKeryxRunner` is used. */
function searchTool(root: string) {
  const tool = builtinMetaprojectTools(root).find((t) => t.definition.name === "search_code");
  if (tool === undefined) {
    throw new Error("search_code is not registered");
  }
  return tool;
}

test("REAL CHAIN: a benign in-root search works through the checkout's own keryx", async () => {
  const { root } = withKeryxOnPath(`#!/bin/sh\nexec bun ${JSON.stringify(CLI)} "$@"\n`);
  const search = searchTool(root);

  const hit = await search.invoke({ pattern: "CHAIN_MARKER" });
  expect(hit.isError, `benign search failed: ${hit.output}`).toBe(false);
  expect(hit.output).toContain("app.ts");

  // …and the confinement still holds across the same real chain.
  const escape = await search.invoke({ pattern: "CHAIN-OUTSIDE", path: "vendor" });
  expect(escape.output).not.toContain("CHAIN-OUTSIDE-MARKER");
}, 180_000);

test("REAL CHAIN: an older keryx on PATH is diagnosed as version skew, not as a bad flag", async () => {
  // Byte-for-byte what keryx 0.2.9 prints for this call, on exit 1. It is the CLI
  // refusing an option THIS TOOL forced — nothing the model did.
  const [forced] = SEARCH_TOOL_FORCED_OPTIONS;
  expect(forced).toBeDefined();
  const { root } = withKeryxOnPath(
    `#!/bin/sh\n` +
      `echo "keryx ctx rg: unsupported ripgrep option ${forced}. Only a reviewed set of options ` +
      `is forwarded, because ripgrep has options that execute external programs." >&2\n` +
      `exit 1\n`,
  );

  const result = await searchTool(root).invoke({ pattern: "CHAIN_MARKER" });
  expect(result.isError).toBe(true);
  expect(result.output).toBe(searchCliSkewMessage(forced ?? ""));
  // The diagnosis says what broke, what to do, and what to use meanwhile.
  expect(result.output).toContain("older than the one this project expects");
  expect(result.output).toContain("read_file and list_dir");
}, 180_000);

test("REAL CHAIN: a refusal of a CALLER-supplied option is left as the CLI wrote it", async () => {
  // The narrow half of the rule. Only an option the TOOL forced reads as skew; a
  // refusal naming something the caller passed is a real input error, and
  // rewriting it into an environment story would hide that.
  const { root } = withKeryxOnPath(
    `#!/bin/sh\n` +
      `echo "keryx ctx rg: unsupported ripgrep option --wat. Only a reviewed set of options ` +
      `is forwarded, because ripgrep has options that execute external programs." >&2\n` +
      `exit 1\n`,
  );

  const result = await searchTool(root).invoke({ pattern: "CHAIN_MARKER" });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("--wat");
  expect(result.output).not.toContain("older than the one this project expects");
}, 180_000);
