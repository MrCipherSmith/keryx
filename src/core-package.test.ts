// What the PACKAGE offers, and what it drags in when someone imports it.
//
// AFC-19 (`docs/requirements/keryx-agent-first-core/specification.md` §30,
// `prd.md` line 42): "В core нет provider registry, выбора модели, credentials,
// LLM-вызовов… его отсутствие не препятствует core-only install/build/smoke."
// AFC-20 (line 43) adds the constraint on the answer: "весь repo на пакеты не
// дробится без пользы" — this repository stays ONE package, and the boundary is
// declared rather than carved out of the file tree.
//
// This file asks four questions the manifest cannot answer by being read:
//
//   1. does the published entry point exist and build client-free?
//   2. does the `exports` map actually close the deep-import surface?
//   3. what does `npm pack` really put in the tarball?
//   4. do the core gate and the client matrix between them run every test?
//
// METHOD, AND WHY IT IS NOT A TEXT SCAN
//
// The shipped-module question goes to the BUNDLER, the same way
// `src/lib/production-graph.test.ts` and `src/sac/core-graph.test.ts` do, and
// for the reason `production-graph.test.ts` records at length: three earlier
// regex/AST guards in this repository were each defeated by a respelling, while
// a bundler RESOLVES specifiers, so a concatenated specifier, a barrel, a
// re-spelled extension or a `createRequire` alias cannot slip past it.
//
// The build flags are DERIVED from `package.json`'s `build` script, not copied
// into a constant here. `core-graph.test.ts` copies them, which is fine for one
// facade; for the package entry it is not, because the whole claim is "the
// artifact the release publishes is client-free" — a copy could drift and this
// file would then be answering about a build nobody ships. The derivation also
// proves, as a side effect, that `src/core.ts` really is an entry point of the
// release build: if it is not, `releaseBuildFor` throws instead of measuring a
// build invented here.
//
// The honest limit is the one those files state for themselves: this proves
// what SHIPS, not what is merely referenced. An import that is tree-shaken out
// passes here. And a module read at runtime by PATH rather than by a resolvable
// specifier is outside static analysis, bundler included — which is exactly how
// `src/gdgraph/*.ts` and `src/gdskills/bundled/**` are used by `init`/`update`,
// and why `exports` can close them to importers without breaking them.
//
// SENTINELS, BECAUSE A BROKEN MEASUREMENT READS AS A CLEAN RESULT
//
// A guard whose only assertion is `expect(violations).toEqual([])` goes green
// when the glob breaks, a directory is renamed, or the graph comes back empty.
// So this file also carries (a) size and content sentinels on every graph and
// file list it reads, and (b) a FORBIDDEN FIXTURE — a generated entry that
// genuinely imports the provider stack, built through the same function with
// the same flags — which the same detector must flag. If the detector ever
// stops firing, that test fails and says so.
//
// WHY THE ZONE TABLE IS IMPORTED RATHER THAN RESTATED
//
// `src/lib/import-zones.ts` is the shared data constant for "what is this
// top-level directory". Restating it here would create the second copy that
// file was written to prevent. The five `src/session/` state modules are the
// one documented exception, and they are listed BY NAME below with the reason.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { zoneOf } from "./lib/import-zones";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "src");

/** The module `exports["."]` publishes — the one door into core. */
const CORE_ENTRY = "src/core.ts";

/** The ten declared public facades the core entry re-exports. */
const FACADES = [
  "flow",
  "gdgraph",
  "health",
  "job",
  "memory",
  "sac",
  "security",
  "standard",
  "testing",
  "wiki",
] as const;

/**
 * Five `src/session/` modules that are in the core graph ON PURPOSE.
 *
 * `src/lib/import-zones.ts` classifies the whole `src/session/` directory as
 * "client", and at directory granularity that is right: session streaming and
 * compaction are client concerns. These five are not that. They are
 * deterministic session-state storage — JSON and file locks over the session
 * directory — with no provider registry, no model selection, no credential read
 * and no LLM call, and three of them are re-exported by `src/sac/service.ts` so
 * another surface reaches SAC through one door instead of into `src/session/`
 * internals (`src/mcp/boundary.test.ts`'s M-3 rule); the other two arrive
 * underneath them. `src/sac/core-graph.test.ts` allowlists the same five for
 * the same reason.
 *
 * They are named individually rather than by prefix, so a SIXTH session module
 * appearing in the core entry's graph fails this file. Reclassifying them in
 * the zone table proper, or relocating them below both consumers, needs a lane
 * that owns `src/lib/import-zones.ts` and `src/session/` — neither is this one,
 * so the exception is recorded here where it is enforced.
 */
const SESSION_STATE_ALLOWLIST = [
  "src/session/external-slate.ts",
  "src/session/paths.ts",
  "src/session/slate-course.ts",
  "src/session/slate.ts",
  "src/session/store.ts",
];

interface Manifest {
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, string>;
  readonly bin?: Record<string, string>;
  readonly files?: string[];
  readonly scripts: Record<string, string>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;
}

interface ReleaseBuild {
  /** The full `bun build` argv, with `--outdir` redirected and a map requested. */
  readonly tokens: string[];
  /**
   * That step's flags with the runner, the entry positionals and the `--outdir`
   * pair removed — what is left is the part that decides what the artifact IS
   * (target, externals, sourcemap), so two steps can be compared and a second
   * build can be given the same treatment.
   */
  readonly flags: string[];
}

/**
 * The release build step that builds `entry`, with its outdir redirected.
 *
 * Deliberately smaller than `production-graph.test.ts`'s parser: that one has to
 * classify EVERY step of the script (and refuses steps it cannot classify, for
 * reasons its header records). This one is looking for one known entry, so an
 * unrecognised step is simply not the step it wants, and the failure mode is a
 * loud "no release build step builds …" rather than a silent skip.
 */
function releaseBuildFor(entry: string, outDir: string): ReleaseBuild {
  const script = manifest().scripts.build;
  if (script === undefined) {
    throw new Error("package.json has no build script; this guard has nothing to ask about");
  }
  for (const command of script.split("&&")) {
    let tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] as string)) {
      tokens = tokens.slice(1);
    }
    let i = 1;
    while (i < tokens.length && (tokens[i] as string).startsWith("-")) {
      i += 1;
    }
    if (path.basename(tokens[0] ?? "") !== "bun" || tokens[i] !== "build") {
      continue;
    }
    const argv = [tokens[0] as string, "build", ...tokens.slice(i + 1)];
    const positionals = argv.filter((t, at) => at > 1 && t.endsWith(".ts"));
    if (!positionals.some((p) => path.resolve(ROOT, p) === path.join(ROOT, entry))) {
      continue;
    }
    const outAt = argv.findIndex((t) => t === "--outdir" || t.startsWith("--outdir="));
    if (outAt === -1) {
      throw new Error(`the build step for ${entry} has no --outdir to redirect: ${command.trim()}`);
    }
    const rewritten = [...argv];
    if ((argv[outAt] as string).startsWith("--outdir=")) {
      rewritten[outAt] = `--outdir=${outDir}`;
    } else {
      rewritten[outAt + 1] = outDir;
    }
    rewritten.push("--sourcemap=external");
    const outdirIsJoined = (argv[outAt] as string).startsWith("--outdir=");
    const dropped = new Set(outdirIsJoined ? [outAt] : [outAt, outAt + 1]);
    const flags = rewritten.filter(
      (token, at) => at > 1 && !dropped.has(at) && !token.endsWith(".ts"),
    );
    return { tokens: rewritten, flags };
  }
  throw new Error(
    `no \`bun build\` step in package.json's build script builds ${entry}; ` +
      "the package entry point is therefore not part of the release build",
  );
}

/**
 * Run one build and return every module the bundler put in the artifact,
 * repo-relative.
 *
 * Maps are ENUMERATED from the outdir rather than named, so a second emitted
 * graph cannot go unread, and `sources` resolve against the OUTDIR ROOT rather
 * than the map's own directory — the resolution `production-graph.test.ts`
 * documents and pins with its own test.
 */
async function shippedGraph(tokens: readonly string[], outDir: string): Promise<string[]> {
  const proc = Bun.spawn([...tokens], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`build failed (exit ${exit}): ${err.slice(0, 400)}`);
  }
  const modules = new Set<string>();
  let maps = 0;
  for (const map of new Glob("**/*.js.map").scanSync(outDir)) {
    maps += 1;
    const parsed = JSON.parse(readFileSync(path.join(outDir, map), "utf8")) as { sources: string[] };
    for (const source of parsed.sources) {
      modules.add(path.relative(ROOT, path.resolve(outDir, source)));
    }
  }
  if (maps === 0) {
    throw new Error(`build of ${tokens.join(" ")} emitted no sourcemap in ${outDir}`);
  }
  return [...modules].sort();
}

/**
 * Every module in `graph` a core-only artifact must not contain: anything the
 * shared zone table calls client or adapter, plus the CLI entry itself (which
 * sits at `src/` root and so has no zone), minus the five session-state modules
 * documented above.
 */
function forbiddenIn(graph: readonly string[]): string[] {
  return graph.filter((module) => {
    if (SESSION_STATE_ALLOWLIST.includes(module)) {
      return false;
    }
    if (module === "src/cli.ts") {
      return true;
    }
    const zone = zoneOf(SRC, path.join(ROOT, module));
    return zone === "client" || zone === "adapter";
  });
}

/** `bun test <filter>` matches a test file whose path CONTAINS the filter. */
function filtersOf(script: string): string[] {
  return script
    .trim()
    .split(/\s+/)
    .filter((token) => token.startsWith("src/"));
}

let root = "";
let coreGraph: string[] = [];
let coreFlags: string[] = [];
let cliFlags: string[] = [];
let fixtureGraph: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-core-package-"));

  const coreBuild = releaseBuildFor(CORE_ENTRY, path.join(root, "core"));
  coreFlags = coreBuild.flags;
  cliFlags = releaseBuildFor("src/cli.ts", path.join(root, "core")).flags;
  coreGraph = await shippedGraph(coreBuild.tokens, path.join(root, "core"));

  // The forbidden fixture: an entry that genuinely reaches the provider stack,
  // built by the same function with the same release flags. Generated rather
  // than committed so production code can never import it by accident, and
  // written outside `src/` so no repo-wide source scan and no typecheck sees it.
  const fixtureDir = path.join(root, "fixture-src");
  mkdirSync(fixtureDir, { recursive: true });
  const fixtureEntry = path.join(fixtureDir, "forbidden-entry.ts");
  writeFileSync(
    fixtureEntry,
    [
      "// Generated fixture: proves the detector in core-package.test.ts fires.",
      `import { runModelTurn } from ${JSON.stringify(path.join(ROOT, "src/harness/provider/single-turn.ts"))};`,
      "export const probe = runModelTurn;",
      "",
    ].join("\n"),
    { encoding: "utf8" },
  );
  const fixtureOut = path.join(root, "fixture");
  fixtureGraph = await shippedGraph(
    ["bun", "build", fixtureEntry, "--outdir", fixtureOut, ...coreFlags],
    fixtureOut,
  );
}, 300_000);

afterAll(() => {
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the core entry is built by the release, with the same flags the CLI ships with", () => {
  // Derived from `package.json`, never copied into this file: if the core entry
  // stops being part of the release build, `releaseBuildFor` throws in
  // `beforeAll` rather than letting this file measure a build nobody publishes.
  // Comparing the two steps' flags is what keeps `dist/core.js` and
  // `dist/cli.js` the same KIND of artifact — same target, same externals — so
  // "the CLI runs with no optional dependencies installed" and "the library
  // imports with no optional dependencies installed" are one property.
  expect(coreFlags.length).toBeGreaterThan(4);
  expect(coreFlags).toEqual(cliFlags);
});

test("the core entry's shipped graph was really read (sentinel against an empty measurement)", () => {
  expect(coreGraph.length).toBeGreaterThan(100);
  // Proven by its DEPENDENCIES, not by its own name: whether an entry module
  // appears among its own sourcemap's `sources` depends on the shape of the
  // entry (measured: a named-re-export facade like `src/sac/service.ts` does
  // not appear; an `export * as` entry does), so asserting the entry's own name
  // would be asserting a bundler detail. All ten declared facades appearing is
  // the property that says the right thing was built.
  for (const facade of FACADES) {
    expect({ facade, shipped: coreGraph.includes(`src/${facade}/service.ts`) }).toEqual({
      facade,
      shipped: true,
    });
  }
});

test("the core entry ships no provider registry, model selection, credential read or LLM call (AFC-19)", () => {
  expect(forbiddenIn(coreGraph)).toEqual([]);
});

test("no session module beyond the five allowlisted state stores reaches the core entry", () => {
  const session = coreGraph.filter((module) => module.startsWith("src/session/"));
  expect(session.filter((module) => !SESSION_STATE_ALLOWLIST.includes(module))).toEqual([]);
  // And the allowlist names files that exist, so a rename cannot quietly widen it.
  for (const module of SESSION_STATE_ALLOWLIST) {
    expect({ module, exists: Bun.file(path.join(ROOT, module)).size > 0 }).toEqual({
      module,
      exists: true,
    });
  }
});

test("the detector fires on a forbidden fixture that really does import the provider stack", () => {
  const violations = forbiddenIn(fixtureGraph);
  expect(violations).toContain("src/harness/provider/single-turn.ts");
  expect(violations).toContain("src/harness/provider/make-provider.ts");
  expect(violations).toContain("src/commands/providers.ts");
  // Same function, same release flags, same sourcemap read as the core-entry
  // test above — so a green core-entry test means the boundary holds, not that
  // the measurement stopped working.
  expect(violations.length).toBeGreaterThan(5);
});

test("the package declares one door, and the door is a built artifact", () => {
  const pkg = manifest();
  expect(pkg.main).toBe("./dist/core.js");
  expect(pkg.exports?.["."]).toBe("./dist/core.js");
  // `bin` is untouched: the CLI is reached by running it, not by importing it.
  expect(pkg.bin?.keryx).toBe("./dist/cli.js");
});

test("the exports map closes the accidental deep-import surface", () => {
  const pkg = manifest();
  const targets = Object.values(pkg.exports ?? {});
  expect(targets.length).toBeGreaterThan(0);
  // Nothing under `src/` is importable any more. Those trees still SHIP —
  // `init`/`update` copy `src/gdgraph/*.ts` and `src/gdskills/bundled/**` by
  // path at runtime — but a consumer can no longer reach private core internals
  // through `@mrciphersmith/keryx/src/...`, which is what `files` had made
  // public by accident in the absence of an `exports` map.
  expect(targets.filter((target) => target.includes("/src/"))).toEqual([]);
  // The CLI bundle is deliberately NOT exported: importing it would run the CLI.
  expect(targets.filter((target) => target.endsWith("/cli.js"))).toEqual([]);
  // Every target is a real path in the package's own file list.
  const files = pkg.files ?? [];
  expect(
    targets.filter((target) => {
      const relative = target.replace(/^\.\//, "");
      return !files.some((f) => relative === f || relative.startsWith(`${f}/`));
    }),
  ).toEqual([]);
});

test("npm pack ships no test file — asked of npm, not of the manifest", () => {
  // The repository's own method for "what is in the tarball" is `npm pack`
  // (`.github/workflows/release.yml`), so this asks npm rather than
  // re-implementing its `files`/ignore semantics — which is precisely the
  // reading that missed 22 shipped test files in the first place.
  // `--ignore-scripts` skips the `prepare` build: the question is which files
  // npm SELECTS, and rebuilding `dist/` to ask it would make a guard that
  // takes a minute out of one that takes a second.
  const proc = Bun.spawnSync(["npm", "pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `\`npm pack --dry-run\` failed (exit ${proc.exitCode}). npm is required for this guard, ` +
        `because it is the tool the release uses to build the tarball: ${proc.stderr.toString().slice(0, 400)}`,
    );
  }
  const packed = JSON.parse(proc.stdout.toString()) as Array<{ files: Array<{ path: string }> }>;
  const files = (packed[0]?.files ?? []).map((f) => f.path);

  // Numerator first: an empty or unreadable file list must not read as clean.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain("package.json");
  expect(files.some((f) => f.startsWith("src/gdgraph/"))).toBe(true);

  expect(files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))).toEqual([]);
});

test("the gates package.json declares are the gates CI actually runs", () => {
  // Defect class this repository keeps recording: a capability that lives in a
  // helper nothing calls. A `test:client:*` script no CI leg names, or a
  // `check:core` no job runs, would look exactly like a working gate — and the
  // coverage assertion below would happily count its filters as covered while
  // nothing executed them. So the two enumerations are compared rather than
  // maintained in parallel and hoped about.
  const pkg = manifest();
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  ) as { jobs: Record<string, { strategy?: { matrix?: { leg?: string[] } }; steps?: Array<{ run?: string }> }> };

  const declared = Object.keys(pkg.scripts)
    .filter((name) => name.startsWith("test:client:"))
    .map((name) => name.slice("test:client:".length))
    .sort();
  const inMatrix = [...(workflow.jobs["client-matrix"]?.strategy?.matrix?.leg ?? [])].sort();
  expect(inMatrix.length).toBeGreaterThan(2);
  expect(inMatrix).toEqual(declared);

  // `test:client` runs every leg, so one command reproduces the whole matrix
  // locally and cannot silently fall behind it.
  const chained = pkg.scripts["test:client"] ?? "";
  expect(declared.filter((leg) => !chained.includes(`test:client:${leg}`))).toEqual([]);

  // And the core gate is wired: some job runs it.
  const runs = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).map((step) => step.run ?? ""),
  );
  expect(runs.some((run) => run.includes("bun run check:core"))).toBe(true);
  expect(runs.some((run) => run.includes("bun run test:client:"))).toBe(true);
});

test("a consumer reaches the ten doors and nothing else — the exports map, resolved", () => {
  // The end-to-end half of AFC-19's "core-only … smoke без клиента/ключей".
  // The manifest tests above read the map; this one makes a real resolver obey
  // it, offline and with no install: a synthetic `node_modules` entry carrying
  // the REAL `name`/`main`/`exports`/`type` fields (copied from `package.json`,
  // not restated) plus the core bundle this file already built.
  //
  // The private module the deep-import probe names is WRITTEN INTO the package
  // first, on purpose. Without it, "the deep import failed" would be satisfied
  // by a missing file and would prove nothing about encapsulation. With it, the
  // only thing that can refuse the import is the exports map.
  //
  // `bun`, not `node`: `dist/*.js` are `--target bun` bundles that import `bun:`
  // builtins, so Node's ESM loader rejects them (measured:
  // ERR_UNSUPPORTED_ESM_URL_SCHEME). That is a real limit of this package — the
  // library entry is importable from Bun, which is what `engines` requires and
  // what `bin/keryx` has always needed — and it is stated here rather than left
  // to be discovered by a Node consumer.
  const pkg = manifest() as Manifest & { name: string; version: string; type: string };
  const home = path.join(root, "consumer");
  const installed = path.join(home, "node_modules", pkg.name);
  mkdirSync(path.join(installed, "dist"), { recursive: true });
  mkdirSync(path.join(installed, "src", "gdgraph"), { recursive: true });
  writeFileSync(
    path.join(installed, "package.json"),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, type: pkg.type, main: pkg.main, exports: pkg.exports },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(installed, "dist", "core.js"),
    readFileSync(path.join(root, "core", "core.js")),
  );
  writeFileSync(path.join(installed, "src", "gdgraph", "query.ts"), "export const present = true;\n");

  // "без ключей" is part of the criterion, so the probe runs with every
  // provider credential REMOVED from its environment rather than merely unused.
  const keyless = { ...process.env };
  for (const name of Object.keys(keyless)) {
    if (name.endsWith("_API_KEY") || name.endsWith("_API_TOKEN")) {
      delete keyless[name];
    }
  }
  const probe = (source: string): { exitCode: number; out: string } => {
    const proc = Bun.spawnSync(["bun", "-e", source], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: keyless,
    });
    return { exitCode: proc.exitCode, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  };

  const door = probe(
    `const core = await import(${JSON.stringify(pkg.name)});\n` +
      "console.log(Object.keys(core).sort().join(','));",
  );
  expect({ exitCode: door.exitCode, out: door.out.trim() }).toEqual({
    exitCode: 0,
    out: [...FACADES].sort().join(","),
  });

  const deep = probe(
    `await import(${JSON.stringify(`${pkg.name}/src/gdgraph/query.ts`)});\n` +
      "console.log('RESOLVED');",
  );
  expect({ exitCode: deep.exitCode !== 0, resolved: deep.out.includes("RESOLVED") }).toEqual({
    exitCode: true,
    resolved: false,
  });
});

test("the core gate and the client matrix between them run every test in src/", () => {
  const pkg = manifest();
  const core = filtersOf(pkg.scripts["test:core"] ?? "");
  const legs = Object.entries(pkg.scripts)
    .filter(([name]) => name.startsWith("test:client:"))
    .map(([name, script]) => [name, filtersOf(script)] as const);

  expect(core.length).toBeGreaterThan(10);
  expect(legs.length).toBeGreaterThan(2);

  const tests = [...new Glob("src/**/*.test.ts").scanSync(ROOT)].map((f) => f.split(path.sep).join("/"));
  expect(tests.length).toBeGreaterThan(400);

  // No gap. A test file matched by neither gate would run in NEITHER CI job —
  // the silent-coverage-loss this split could otherwise introduce.
  const all = [...core, ...legs.flatMap(([, filters]) => filters)];
  expect(tests.filter((file) => !all.some((filter) => file.includes(filter)))).toEqual([]);

  // EVERY filter, not every script, really selects something. `bun test` exits
  // non-zero when any one filter matches nothing ("The following filters did not
  // match any test files"), so a directory that loses its last test, or is
  // renamed, breaks CI — this states which filter and which script, where the
  // reason is legible, instead of leaving it as a bare CI failure. Asserting at
  // script level instead would let a dead filter hide behind its live siblings.
  for (const [script, filters] of [["test:core", core] as const, ...legs]) {
    for (const filter of filters) {
      expect({ script, filter, matches: tests.some((file) => file.includes(filter)) }).toEqual({
        script,
        filter,
        matches: true,
      });
    }
  }

  // The core gate stays model-free by construction: it selects nothing from a
  // zone the table calls client. (`src/commands/` is an ADAPTER, not a client
  // zone, and stays in the core gate; the client legs re-select the handful of
  // client-facing command files on purpose, so those behaviours report
  // independently. That overlap is deliberate and costs CI time, not honesty.)
  const clientZoned = tests.filter((file) => zoneOf(SRC, path.join(ROOT, file)) === "client");
  expect(clientZoned.length).toBeGreaterThan(100);
  expect(clientZoned.filter((file) => core.some((filter) => file.includes(filter)))).toEqual([]);
});
