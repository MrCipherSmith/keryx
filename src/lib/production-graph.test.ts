// What the shipped build actually contains — asked of the bundler, not of a pattern.
//
// WHY THIS EXISTS
//
// Two modules in `src/lib/` are test scaffolding: `config-dir.scan.ts` (a source
// scanner) and `config-dir.ast.ts` (TypeScript-AST predicates, which imports
// `typescript` — a **devDependency**). Neither may reach production. A guard for
// that has existed for several rounds and has been defeated in every one:
//
//   round 1-3  a regex over source text. Defeated by `require()`, then by
//              dynamic `import()`, then by a FILE EXTENSION.
//   round 3    rewritten to match the TypeScript AST. Sold as "closed by
//              construction". Defeated in round 4 by a specifier built with
//              `+`, by `createRequire` bound to another name, and by a template
//              literal with a substitution — because `moduleSpecifiers` only
//              sees a specifier that is a string literal in a load position, and
//              "a string literal" is one node kind among several that can sit
//              there.
//
// Both versions were asking a proxy question — "does this file contain text or
// nodes that look like an import?" — when the real question is "does the shipped
// artifact contain this module?". That question has an authoritative answer, and
// it is not a heuristic: **ask the bundler**.
//
// WHAT THIS PROVES, EXACTLY
//
// It answers "does this module SHIP", and that is a different and narrower
// question than "does a production file reference it". The difference is
// tree-shaking, and it is the whole of the honest limit here:
//
//   reached and used from an entry point  ->  in the bundle  ->  this fails
//   imported but never reached            ->  shaken out     ->  this passes
//
// Measured while writing this, because the first version of this header claimed
// more: adding `export { code } from "./config-dir.scan"` to `config-dir.ts`,
// and then a `probeStrip()` that genuinely calls it, left the graph at 289
// sources with the scanner absent both times. Nothing in the CLI calls
// `probeStrip`, so the bundler correctly drops it.
//
// So this is a closure for the property that matters most — a devDependency
// (`typescript`, via `config-dir.ast.ts`) or a source scanner cannot reach an
// installed user's machine — and it is spelling-proof for that property, because
// the bundler resolves specifiers rather than matching them. A concatenated
// specifier, `createRequire` under another name, an extension, a barrel: if it
// resolves and is reached, it is in the graph.
//
// It is NOT a replacement for the AST importer guard in
// `config-dir.readers.test.ts`. That one answers the weaker question — does any
// production FILE name this module — and catches the import that is currently
// tree-shaken but would ship the moment someone calls it. Two guards, two
// questions, and neither subsumes the other. Saying so here because the previous
// version of this work replaced a guard with a "better" one and quietly lost
// what the old one covered.
//
// The remaining gap, stated rather than left to be found: a module read at
// runtime by PATH rather than imported — `readFileSync` plus `eval`, or a
// specifier assembled from configuration — is outside any static analysis,
// bundler included.
//
// COST
//
// One real build per entry point, run once in `beforeAll` and shared by every
// test in the file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");

/**
 * Modules that must never reach a shipped artifact, and why.
 *
 * Keyed by the basename a source path ends with, so a rename that keeps the
 * name is still caught and a rename that changes it fails the existence check
 * below rather than passing silently.
 */
const TEST_ONLY_MODULES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "src/lib/config-dir.scan.ts",
    reason: "a source scanner used only by guards; its own header argues it must not be a .test. file",
  },
  {
    file: "src/lib/config-dir.ast.ts",
    reason: "AST guard predicates; imports `typescript`, which is a devDependency",
  },
];

/**
 * The build commands the RELEASE runs, read verbatim from `package.json`.
 *
 * Derived rather than duplicated, and run as a SUBPROCESS rather than through
 * `Bun.build`. Two reasons, one of them learned the hard way:
 *
 *   - it is the same command the release runs, argument for argument, so this
 *     guard cannot answer a question about a build nobody ships;
 *   - the in-process `Bun.build` failed to resolve ordinary relative imports on
 *     its FIRST call inside a `bun test` process and succeeded on every call
 *     after, so whichever test ran first threw and the rest passed. A guard
 *     whose result depends on test ordering is not a guard.
 *
 * Only `--outdir` is rewritten, to a temp directory, so running the tests never
 * touches `./dist`.
 */
function releaseCommands(outDir: string): string[][] {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.build;
  if (script === undefined) {
    throw new Error("package.json has no build script; this guard has nothing to ask about");
  }
  return script.split("&&").map((command) => {
    const tokens = command.trim().split(/\s+/);
    const outIndex = tokens.indexOf("--outdir");
    if (outIndex === -1 || tokens[outIndex + 1] === undefined) {
      throw new Error(`build command has no --outdir to redirect: ${command.trim()}`);
    }
    const entry = tokens[2];
    if (entry === undefined || !entry.endsWith(".ts")) {
      throw new Error(`could not read an entry point out of: ${command.trim()}`);
    }
    const rewritten = [...tokens];
    rewritten[outIndex + 1] = path.join(outDir, path.basename(entry, ".ts"));
    rewritten.push("--sourcemap=external");
    return rewritten;
  });
}

/** The entry point a release command builds, absolute. */
function entryOf(tokens: string[]): string {
  return path.join(ROOT, tokens[2] as string);
}

/**
 * Every project source the release build pulled into one entry point's graph.
 *
 * Read out of the emitted sourcemap, which lists exactly the modules the
 * bundler resolved and inlined.
 */
async function graphOf(tokens: string[]): Promise<string[]> {
  const proc = Bun.spawn(tokens, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`release build failed (exit ${exit}): ${err.slice(0, 400)}`);
  }
  const outDir = tokens[tokens.indexOf("--outdir") + 1] as string;
  const entry = path.basename(entryOf(tokens), ".ts");
  const mapFile = path.join(outDir, `${entry}.js.map`);
  const parsed = JSON.parse(readFileSync(mapFile, "utf8")) as { sources: string[] };
  // Resolved against the OUTPUT directory, because that is what a sourcemap's
  // paths are relative to. `path.resolve` normalises the `../..` chain back to
  // an absolute project path.
  return parsed.sources.map((source) => path.resolve(outDir, source));
}

describe("the shipped build contains no test scaffolding", () => {
  let outDir = "";
  /** entry -> its module graph, built once for the whole file. */
  const graphs = new Map<string, string[]>();

  beforeAll(async () => {
    outDir = mkdtempSync(path.join(tmpdir(), "keryx-graph-"));
    for (const tokens of releaseCommands(outDir)) {
      graphs.set(entryOf(tokens), await graphOf(tokens));
    }
  }, 300_000);

  afterAll(() => {
    if (outDir !== "") {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("every entry point in the release script is asked, and each graph is real", () => {
    // The numerator. An empty graph, or a build script this cannot parse, makes
    // every assertion below vacuous — which is exactly how a guard dies quietly.
    expect(graphs.size).toBeGreaterThan(0);
    for (const [entry, graph] of graphs) {
      const relative = path.relative(ROOT, entry);
      // Non-empty, and it really is THIS entry's graph. Asserted per entry as
      // "contains its own entry file" rather than "contains `config-dir.ts`":
      // the sandbox proxy worker is a second, much smaller entry point that does
      // not import it, so the first version failed for a reason that had nothing
      // to do with the property.
      expect({ relative, modules: graph.length > 1 }).toEqual({ relative, modules: true });
      expect({ relative, containsItself: graph.includes(entry) }).toEqual({
        relative,
        containsItself: true,
      });
    }
  });

  test("no test-only module is in any shipped graph", () => {
    const shipped = new Set<string>();
    for (const graph of graphs.values()) {
      for (const source of graph) {
        shipped.add(source);
      }
    }
    const offenders = TEST_ONLY_MODULES.filter(({ file }) =>
      shipped.has(path.join(ROOT, file)),
    ).map(({ file, reason }) => `${file} — ${reason}`);
    expect(offenders).toEqual([]);
  });

  test("every module named in the list exists, so the guard cannot excuse a moved file", async () => {
    // An entry pointing at a path that no longer exists forbids nothing, and
    // reads exactly like one that forbids something.
    for (const { file } of TEST_ONLY_MODULES) {
      expect({ file, exists: await Bun.file(path.join(ROOT, file)).exists() }).toEqual({
        file,
        exists: true,
      });
    }
  });

  test("the graph reader SEES real production modules — the numerator", () => {
    // Without this, "no test-only module is in the graph" passes just as well
    // for a reader that returns nothing useful. It already caught one such bug:
    // resolving sourcemap paths against the wrong base produced `src/src/lib/…`
    // and a guard that matched nothing at all.
    //
    // The numerator is real production modules rather than a planted offender,
    // and that is forced rather than lazy: a planted import is tree-shaken
    // unless something the CLI actually calls reaches it, so planting one and
    // watching this stay green would prove nothing about the guard. What CAN be
    // asserted is that the reader sees modules that genuinely ship, and does not
    // see the two under test.
    const cli = [...graphs.entries()].find(([entry]) => entry.endsWith("src/cli.ts"));
    expect(cli).toBeDefined();
    const graph = new Set(cli?.[1] ?? []);
    expect(graph.has(path.join(ROOT, "src/lib/config-dir.ts"))).toBe(true);
    expect(graph.has(path.join(ROOT, "src/lib/serve-turn-store.ts"))).toBe(true);
    // ...and the two under test are absent, which is the whole claim.
    expect(graph.has(path.join(ROOT, "src/lib/config-dir.scan.ts"))).toBe(false);
    expect(graph.has(path.join(ROOT, "src/lib/config-dir.ast.ts"))).toBe(false);
  });
});
