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
import { Glob } from "bun";

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
 * ENTRY POINTS ARE PLURAL. The first version took `tokens[2]` as *the* entry
 * point, and `bun build` accepts any number of positionals. A reviewer added a
 * second one to the same command, shipped `dist/tools/report.js` with the source
 * scanner inside it, and the suite stayed green — including the test named
 * "every entry point in the release script is asked". Every positional ending in
 * `.ts` is an entry point now, and the count is asserted.
 *
 * Steps that are not `bun build` are SKIPPED rather than fatal. The first
 * version threw on them, so adding a `cp README.md dist/` to the release script
 * broke the guard rather than the property — and a guard that breaks on ordinary
 * maintenance is a guard someone deletes.
 *
 * Only `--outdir` is rewritten, to a temp directory, so running the tests never
 * touches `./dist`.
 */
interface ReleaseBuild {
  tokens: string[];
  entries: string[];
  outDir: string;
}

function releaseBuilds(root: string): ReleaseBuild[] {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.build;
  if (script === undefined) {
    throw new Error("package.json has no build script; this guard has nothing to ask about");
  }
  return releaseBuildsFrom(script, root);
}

/** The parsing half, separated so a test can drive shapes the real script lacks. */
function releaseBuildsFrom(script: string, root: string): ReleaseBuild[] {
  const builds: ReleaseBuild[] = [];
  script.split("&&").forEach((command, index) => {
    const tokens = command.trim().split(/\s+/);
    if (tokens[0] !== "bun" || tokens[1] !== "build") {
      return; // not a build step — a copy, a chmod, a sub-script
    }
    // BOTH spellings of every flag. `--outdir ./dist` and `--outdir=./dist` are
    // the same instruction, and the first version knew only the first — so
    // switching the release script to the equals form did not weaken the guard,
    // it CRASHED it. Fail-closed, but a guard that breaks on ordinary
    // maintenance is a guard someone deletes, and this round made the equals
    // form idiomatic across this CLI by teaching `optionValue` to accept it.
    const outIndex = tokens.findIndex((t) => t === "--outdir" || t.startsWith("--outdir="));
    if (outIndex === -1) {
      throw new Error(`build command has no --outdir to redirect: ${command.trim()}`);
    }
    const outdirIsJoined = (tokens[outIndex] ?? "").startsWith("--outdir=");
    if (!outdirIsJoined && tokens[outIndex + 1] === undefined) {
      throw new Error(`--outdir has no value: ${command.trim()}`);
    }
    // Every positional that is a `.ts` file and is not the value of a flag.
    // A `--flag=value` token carries its own value, so the token AFTER it is a
    // positional — which the space-form-only check would have misread.
    const isFlagValue = (i: number): boolean => {
      const previous = tokens[i - 1] ?? "";
      return previous.startsWith("--") && !previous.includes("=");
    };
    const entries = tokens.filter(
      (token, i) => i > 1 && token.endsWith(".ts") && !isFlagValue(i),
    );
    if (entries.length === 0) {
      throw new Error(`could not read an entry point out of: ${command.trim()}`);
    }
    const outDir = path.join(root, `step-${index}`);
    const rewritten = [...tokens];
    if (outdirIsJoined) {
      rewritten[outIndex] = `--outdir=${outDir}`;
    } else {
      rewritten[outIndex + 1] = outDir;
    }
    rewritten.push("--sourcemap=external");
    builds.push({ tokens: rewritten, entries: entries.map((e) => path.join(ROOT, e)), outDir });
  });
  return builds;
}

/**
 * Run one release build and return every module graph it emitted.
 *
 * The maps are ENUMERATED from the output directory rather than constructed
 * from an entry name. Constructing the filename is what let a second entry
 * point go unread: the file was emitted, and nothing looked at it.
 */
async function graphsOf(build: ReleaseBuild): Promise<Map<string, string[]>> {
  const proc = Bun.spawn(build.tokens, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`release build failed (exit ${exit}): ${err.slice(0, 400)}`);
  }
  const graphs = new Map<string, string[]>();
  for (const map of new Glob("**/*.js.map").scanSync(build.outDir)) {
    const file = path.join(build.outDir, map);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { sources: string[] };
    // Relative to the OUTDIR ROOT, not to the map's own directory. A nested
    // artifact (`tools/report.js.map`) still carries paths written from the
    // outdir, so resolving from the map's directory silently produced
    // `<outdir>/tools/../fixbox/...` and every lookup missed. The numerator
    // assertion below is what caught it.
    graphs.set(file, parsed.sources.map((source) => path.resolve(build.outDir, source)));
  }
  return graphs;
}

describe("the shipped build contains no test scaffolding", () => {
  let root = "";
  /** every emitted map -> its module graph, built once for the whole file. */
  const graphs = new Map<string, string[]>();
  /** every entry point the release script names. */
  const entries: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "keryx-graph-"));
    for (const build of releaseBuilds(root)) {
      entries.push(...build.entries);
      for (const [file, graph] of await graphsOf(build)) {
        graphs.set(file, graph);
      }
    }
  }, 300_000);

  afterAll(() => {
    if (root !== "") {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every entry point in the release script is asked, and each graph is real", () => {
    // The numerator, and the assertion the first version got wrong. It checked
    // that SOME graphs existed; it never compared how many artifacts were read
    // against how many the build command actually produces. A second entry point
    // in the same `bun build` was silently dropped, and a reviewer used exactly
    // that to ship the scanner with this file green.
    expect(entries.length).toBeGreaterThan(0);
    expect(graphs.size).toBeGreaterThanOrEqual(entries.length);

    for (const [file, graph] of graphs) {
      expect({ file: path.basename(file), modules: graph.length > 1 }).toEqual({
        file: path.basename(file),
        modules: true,
      });
    }
    // And each named entry really is the root of one of them.
    for (const entry of entries) {
      const covered = [...graphs.values()].some((graph) => graph.includes(entry));
      expect({ entry: path.relative(ROOT, entry), covered }).toEqual({
        entry: path.relative(ROOT, entry),
        covered: true,
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

  test("no devDependency is in any shipped graph — the property, not two filenames", () => {
    // The header claimed "a devDependency cannot reach an installed user's
    // machine" while the list below it named two FILES. A production module
    // importing `typescript` directly bundles the compiler and satisfies the
    // filename check: measured, the artifact goes from 1.7 MB to 10.5 MB.
    // This asserts the property the header names.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    expect(devDeps.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const graph of graphs.values()) {
      for (const source of graph) {
        const marker = `${path.sep}node_modules${path.sep}`;
        const at = source.lastIndexOf(marker);
        if (at === -1) {
          continue;
        }
        const rest = source.slice(at + marker.length);
        const name = rest.startsWith("@") ? rest.split(path.sep).slice(0, 2).join("/") : rest.split(path.sep)[0];
        if (name !== undefined && devDeps.includes(name)) {
          offenders.push(name);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  test("every module named in the list exists, so the guard cannot excuse a moved file", async () => {
    for (const { file } of TEST_ONLY_MODULES) {
      expect({ file, exists: await Bun.file(path.join(ROOT, file)).exists() }).toEqual({
        file,
        exists: true,
      });
    }
  });

  test("the raw-source trees the package also ships carry no scaffolding", async () => {
    // `package.json` `files` ships `src/gdgraph` and parts of `src/gdskills` as
    // RAW `.ts`, which the bundler never sees — so they are outside this file's
    // question entirely unless it asks separately.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    const rawTrees = (pkg.files ?? []).filter((f) => f.startsWith("src/"));
    expect(rawTrees.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const tree of rawTrees) {
      for (const relative of new Glob("**/*.ts").scanSync(path.join(ROOT, tree))) {
        const source = readFileSync(path.join(ROOT, tree, relative), "utf8");
        for (const { file } of TEST_ONLY_MODULES) {
          const basename = path.basename(file, ".ts");
          if (source.includes(basename)) {
            offenders.push(`${tree}/${relative} names ${basename}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the build-script parser reads both flag spellings, and all positionals", () => {
    // The parser is the guard's single point of failure: everything below reads
    // what it produced. Two defects lived here, both found by planting rather
    // than by reading.
    //
    //   `tokens[2]` as THE entry     -> a second entry point in the same command
    //                                   shipped the scanner with the suite green
    //   `--outdir` space form only   -> the equals form CRASHED the guard, which
    //                                   is fail-closed but breaks on ordinary
    //                                   maintenance — and this round made the
    //                                   equals form idiomatic across this CLI
    //
    // Driven through `releaseBuilds` itself rather than by re-testing a regex
    // against a string, so replacing the function body with a constant fails.
    const parse = (script: string): ReleaseBuild[] =>
      releaseBuildsFrom(script, path.join(tmpdir(), "keryx-parse-probe"));

    const BASE = "--target bun --external some-pkg";
    const shapes: Array<[string, string, number]> = [
      ["space form", `bun build ./src/cli.ts --outdir ./dist ${BASE}`, 1],
      ["equals form", `bun build ./src/cli.ts --outdir=./dist ${BASE}`, 1],
      ["two entries, space", `bun build ./src/a.ts ./src/b.ts --outdir ./dist ${BASE}`, 2],
      ["two entries, equals", `bun build ./src/a.ts ./src/b.ts --outdir=./dist ${BASE}`, 2],
      ["entry after an equals flag", `bun build --outdir=./dist ./src/a.ts ${BASE}`, 1],
    ];
    for (const [label, script, expected] of shapes) {
      const [build] = parse(script);
      expect({ label, entries: build?.entries.length ?? 0 }).toEqual({ label, entries: expected });
      // And the outdir really was redirected, in whichever spelling it used.
      const redirected = (build?.tokens ?? []).some(
        (t) => t === build?.outDir || t === `--outdir=${build?.outDir}`,
      );
      expect({ label, redirected }).toEqual({ label, redirected: true });
    }

    // A non-build step is skipped, not fatal — the guard used to throw on a
    // `cp`, so adding one to the release script broke the guard rather than the
    // property.
    expect(parse(`cp README.md dist/ && bun build ./src/cli.ts --outdir ./dist ${BASE}`)).toHaveLength(1);
    // A build step with no --outdir is still loud: it cannot be redirected, so
    // running it would write into the real ./dist.
    expect(() => parse(`bun build ./src/cli.ts ${BASE}`)).toThrow(/--outdir/);
  });

  test("the graph reader SEES real production modules — the numerator", () => {
    // Without this, "no test-only module is in the graph" passes just as well
    // for a reader that returns nothing useful. It already caught one such bug:
    // resolving sourcemap paths against the wrong base produced `src/src/lib/…`.
    const shipped = new Set<string>();
    for (const graph of graphs.values()) {
      for (const source of graph) {
        shipped.add(source);
      }
    }
    expect(shipped.has(path.join(ROOT, "src/lib/config-dir.ts"))).toBe(true);
    expect(shipped.has(path.join(ROOT, "src/lib/serve-turn-store.ts"))).toBe(true);
    expect(shipped.has(path.join(ROOT, "src/lib/config-dir.scan.ts"))).toBe(false);
    expect(shipped.has(path.join(ROOT, "src/lib/config-dir.ast.ts"))).toBe(false);
  });
});
