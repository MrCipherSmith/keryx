// What the SAC facade actually SHIPS — asked of the bundler, not of a pattern.
//
// AFC-19 (`docs/requirements/keryx-agent-first-core/specification.md` §30):
// "В core нет provider registry, выбора модели, credentials, LLM-вызовов."
// `src/sac/service.ts` is the public Shared Agent Context facade — the module a
// core-only package would export — and until this test existed it contained all
// four: six providers, `make-provider`, `single-turn`, the SSE streaming reader,
// the policy engine, and `src/commands/providers.ts`, reached through exactly
// one function (`runModelTurn`) from exactly three SAC modules
// (`workspace-resolve.ts`, `machine-wrap-up.ts`, `decision-dedup.ts`).
//
// METHOD — deliberately the same one `src/lib/production-graph.test.ts` uses and
// argues for at length: run the REAL release build (the flags in
// `package.json`'s `build` script) on this one entry with
// `--sourcemap=external`, and read the emitted sourcemap's `sources`. That
// answers "does this module ship", which a regex or an AST walk cannot: the
// bundler RESOLVES specifiers, so a concatenated specifier, a re-spelled
// extension, a barrel or a `createRequire` alias cannot slip past it. Three
// earlier text/AST guards in this repository were each defeated by a respelling;
// this one asks the artifact.
//
// The honest limit is the same one that file records: this proves what SHIPS,
// not what is merely referenced. An import that is tree-shaken out passes here.
//
// WHY THE SENTINELS BELOW — this repository has now spent three phases closing
// "a failure that reads as a clean result". A guard whose only assertion is
// `expect(violations).toEqual([])` goes green when the glob breaks, the
// directory is renamed, or the graph comes back empty. So this file also
// asserts (a) that the graph is non-trivially large, (b) that it contains the
// three SAC modules the leak ran through, and (c) a FORBIDDEN FIXTURE: a
// generated entry point that really does import the provider stack, built the
// same way, which the same detector must flag. If the detector ever stops
// firing, the fixture test fails and says so.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";

const ROOT = path.resolve(import.meta.dir, "..", "..");

/**
 * Zones that carry the model runtime AFC-19 keeps out of core: the harness
 * (provider registry, model selection, credentials, streaming, policy loop),
 * the CLI/MCP adapters, the TUI, the MCP client and the vendor-agent runtime.
 * A single module from any of these inside the facade's shipped graph is the
 * failure this test exists for.
 */
const CLIENT_ZONES = [
  "src/harness/",
  "src/tui/",
  "src/mcp-client/",
  "src/agents/",
  "src/commands/",
  "src/mcp/",
  "src/cli.ts",
];

/**
 * `src/session/` is classified as a client zone by the phase-7 inventory's zone
 * table, but these five modules are deterministic session-state storage — JSON
 * and file locks over `.metaproject`/the session dir — and contain no provider
 * registry, no model selection, no credential read and no LLM call. Three of
 * them (`store.ts`'s `findSession`, `external-slate.ts`, `slate.ts`'s Seed
 * types) are re-exported by `service.ts` ON PURPOSE, so `src/mcp/tools.ts`
 * reaches SAC through one facade instead of into `src/session/` internals
 * (`src/mcp/boundary.test.ts`'s M-3 rule); the other two arrive underneath them.
 *
 * They are allowlisted BY NAME rather than by prefix: a sixth session module
 * appearing in the facade graph fails this test. Whether these five belong in
 * `src/session/` at all is a relocation question this task is explicitly not
 * allowed to answer by moving files, and it is handed to the packaging lane.
 */
const SESSION_STATE_ALLOWLIST = [
  "src/session/external-slate.ts",
  "src/session/paths.ts",
  "src/session/slate-course.ts",
  "src/session/slate.ts",
  "src/session/store.ts",
];

/** The release build command from `package.json`, minus the entry and outdir. */
const RELEASE_FLAGS = [
  "--target",
  "bun",
  "--external",
  "@modelcontextprotocol/sdk",
  "--external",
  "web-tree-sitter",
  "--external",
  "@opentui/core",
  "--sourcemap=external",
];

/**
 * Build `entries` in isolation with the real release flags and return every
 * module the bundler put in the artifact, repo-relative.
 *
 * Sourcemap `sources` are relative to the OUTDIR ROOT (not to the map's own
 * directory) — the same resolution `production-graph.test.ts::resolveSources`
 * documents. Maps are ENUMERATED from the outdir rather than named, so a second
 * emitted graph cannot go unread.
 */
async function shippedGraph(entries: string[], outDir: string): Promise<string[]> {
  const tokens = ["bun", "build", ...entries.map((e) => path.join(ROOT, e)), "--outdir", outDir, ...RELEASE_FLAGS];
  const proc = Bun.spawn(tokens, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`release build failed (exit ${exit}): ${err.slice(0, 400)}`);
  }
  const modules = new Set<string>();
  for (const map of new Glob("**/*.js.map").scanSync(outDir)) {
    const parsed = JSON.parse(readFileSync(path.join(outDir, map), "utf8")) as { sources: string[] };
    for (const source of parsed.sources) {
      modules.add(path.relative(ROOT, path.resolve(outDir, source)));
    }
  }
  return [...modules].sort();
}

/** Every module in `graph` that a core-only artifact must not contain. */
function clientModulesIn(graph: readonly string[]): string[] {
  return graph.filter((module) => CLIENT_ZONES.some((zone) => module.startsWith(zone)));
}

let root = "";
let facadeGraph: string[] = [];
let fixtureGraph: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-sac-core-graph-"));

  facadeGraph = await shippedGraph(["src/sac/service.ts"], path.join(root, "facade"));

  // The forbidden fixture: an entry that genuinely reaches the provider stack,
  // built exactly like the facade. Generated (not committed) so it can never be
  // imported by production code by accident, and written outside `src/` so no
  // repo-wide source scan or the type-checker ever sees it.
  const fixtureDir = path.join(root, "fixture-src");
  mkdirSync(fixtureDir, { recursive: true });
  const fixtureEntry = path.join(fixtureDir, "forbidden-entry.ts");
  writeFileSync(
    fixtureEntry,
    [
      "// Generated fixture: proves the detector in core-graph.test.ts fires.",
      `import { runModelTurn } from ${JSON.stringify(path.join(ROOT, "src/harness/provider/single-turn.ts"))};`,
      "export const probe = runModelTurn;",
      "",
    ].join("\n"),
    { encoding: "utf8" },
  );
  fixtureGraph = await shippedGraph([path.relative(ROOT, fixtureEntry)], path.join(root, "fixture"));
}, 300_000);

afterAll(() => {
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the facade's shipped graph was actually read (sentinel against a silently empty measurement)", () => {
  expect(facadeGraph.length).toBeGreaterThan(40);
  // The three modules the provider stack was reached through must all still be
  // in the graph: this test measures the facade that had the leak, not a
  // tree-shaken shell of it. (The entry module itself is not listed among a
  // sourcemap's `sources` — measured, not assumed — so `service.ts` is proven
  // present by its dependencies rather than by name.)
  expect(facadeGraph).toContain("src/sac/workspace-resolve.ts");
  expect(facadeGraph).toContain("src/sac/machine-wrap-up.ts");
  expect(facadeGraph).toContain("src/sac/decision-dedup.ts");
});

test("the SAC facade ships no provider registry, model selection, credential read or LLM call (AFC-19)", () => {
  expect(clientModulesIn(facadeGraph)).toEqual([]);
});

test("no session module beyond the five allowlisted state stores reaches the facade", () => {
  const session = facadeGraph.filter((module) => module.startsWith("src/session/"));
  expect(session.filter((module) => !SESSION_STATE_ALLOWLIST.includes(module))).toEqual([]);
});

test("the detector fires on a forbidden fixture that really does import the provider stack", () => {
  const violations = clientModulesIn(fixtureGraph);
  expect(violations).toContain("src/harness/provider/single-turn.ts");
  expect(violations).toContain("src/harness/provider/make-provider.ts");
  expect(violations).toContain("src/commands/providers.ts");
  // Same detector, same build flags, same sourcemap read as the facade test
  // above — so a green facade test means the leak is gone, not that the
  // measurement stopped working.
  expect(violations.length).toBeGreaterThan(5);
});
