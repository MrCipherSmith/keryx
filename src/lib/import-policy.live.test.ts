// The import-policy check, ADOPTED — pointed at the real `src/` tree (flow
// 239, T8).
//
// WHY THIS FILE EXISTS
//
// `checkImportBoundary` shipped with zero non-test callers and one fixture, and
// a review established it could not have had a real caller: the reachability
// set it filtered made the "allowed" direction structurally unreachable, so
// pointing it at real source produced 141 violations for `src/mcp/server.ts`
// and 49 for `src/commands/agent.ts` — a check nobody could adopt without
// either fixing several hundred call sites or deleting the check. A guard with
// no caller enforces nothing, and this repository's inventory calls that a
// class-1 defect by name. This is the caller.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO RULES, ENFORCED DIFFERENTLY, ON PURPOSE
// ─────────────────────────────────────────────────────────────────────────────
//
// The encoded policy was one rule with two directions. Measurement shows they
// are not one rule: they have different justifications, different evidence, and
// only one of them is satisfiable inside this repository today.
//
// RULE 1 — a core owner never imports a client or adapter module. Enforced at
// zero tolerance against a NAMED allowlist below. 22 edges today, across 6
// files, in two groups with very different standing.
//
// RULE 2 — a client or adapter imports core only through `service.ts`. MEASURED
// and CAPPED, not enforced at zero. 210 edges today. The reasoning is in
// `import-policy.ts`'s `INTRA_REPO_FACADE_RULE_IS_ADVISORY` and summarised at
// the cap below. The short version: it is the PUBLISHED-PACKAGE rule, it is
// already enforced more strictly than this by `package.json`'s exports map plus
// `src/core-package.test.ts`, and five of the fifteen core directories have no
// `service.ts` for anyone to go through — so intra-repository code cannot obey
// it even in principle.
//
// A cap is not a weakened rule. It fails when the number goes UP, which is the
// property that matters for a boundary nobody is allowed to erode further, and
// it fails when the number goes DOWN too — a cap that silently absorbs progress
// stops being evidence of anything.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { checkImportPolicy, listSourceFiles, resolutionGaps } from "./import-policy";
import { staleSegments, unclassifiedSegments } from "./import-zones";

const SRC = path.resolve(import.meta.dir, "..");

/** `from -> to`, repo-relative to `src/`, the shape every assertion compares on. */
function pairsOf(report: Awaited<ReturnType<typeof checkImportPolicy>>, kind: string): string[] {
  return [
    ...new Set(
      report.findings
        .filter((f) => f.kind === kind && f.to !== undefined)
        .map((f) => `${path.relative(SRC, f.from)} -> ${path.relative(SRC, f.to as string)}`),
    ),
  ].sort();
}

/**
 * RULE 1's allowlist, in two groups, each entry a `from -> to` pair.
 *
 * GROUP A — `src/sac/` importing five `src/session/` modules.
 *
 * Not a defect, and not this guard's call to make: the SAME five modules are
 * already allowlisted BY NAME, with the same reasoning, in two other guards —
 * `src/core-package.test.ts::SESSION_STATE_ALLOWLIST` and
 * `src/sac/core-graph.test.ts::SESSION_STATE_ALLOWLIST`. Both record that these
 * are deterministic session-state storage (JSON and file locks over the session
 * directory) with no provider registry, no model selection, no credential read
 * and no LLM call, sitting inside a directory the zone table classifies as
 * client at directory granularity — correctly, since session streaming and
 * compaction ARE client concerns. Three of them are re-exported by
 * `src/sac/service.ts` on purpose. Whether they belong in `src/session/` at all
 * is a relocation question handed to the packaging lane by both of those files,
 * and inventing a third, differently-reasoned answer here would be worse than
 * recording the one that already exists.
 *
 * GROUP B — `src/wiki/` importing `src/harness/` and `src/commands/`.
 *
 * A genuine dependency inversion, and the one place the spec's unconditional
 * rule is actually broken: `src/wiki/deep-enrich.ts` reaches into the model
 * runtime (provider construction, single-turn execution, child orchestration,
 * policy profiles) and into an ADAPTER, `src/commands/agent.ts`. That is
 * "Владельцы не импортируют CLI/MCP/Shell" violated literally, including the
 * CLI. It is listed rather than fixed because `src/wiki/**` belongs to another
 * lane in this programme; listing it is what makes it a tracked debt with a
 * failing test behind it instead of a sentence in a report.
 *
 * The list is exact in BOTH directions. A new edge fails, and so does a listed
 * edge that no longer exists — so the allowlist shrinks as the wiki lane lands
 * its work and can never quietly outlive the problem it records.
 */
const OWNER_IMPORTS_CLIENT_ALLOWLIST = [
  // Group A — sac -> the five documented session-state modules.
  "sac/catch-up.ts -> session/external-slate.ts",
  "sac/catch-up.ts -> session/paths.ts",
  "sac/catch-up.ts -> session/slate.ts",
  "sac/catch-up.ts -> session/store.ts",
  "sac/machine-wrap-up.ts -> session/slate-course.ts",
  "sac/machine-wrap-up.ts -> session/slate.ts",
  "sac/service.ts -> session/external-slate.ts",
  "sac/service.ts -> session/slate.ts",
  "sac/service.ts -> session/store.ts",
  "sac/session-wrap-up.ts -> session/slate-course.ts",
  "sac/session-wrap-up.ts -> session/store.ts",
  "sac/wrap-up-evidence.ts -> session/slate.ts",

  // Group B — wiki -> the model runtime and the CLI adapter. Tracked debt.
  "wiki/deep-enrich.ts -> commands/agent.ts",
  "wiki/deep-enrich.ts -> harness/child/ledger.ts",
  "wiki/deep-enrich.ts -> harness/child/orchestrate.ts",
  "wiki/deep-enrich.ts -> harness/policy/profiles.ts",
  "wiki/deep-enrich.ts -> harness/provider/make-provider.ts",
  "wiki/deep-enrich.ts -> harness/provider/single-turn.ts",
  "wiki/deep-enrich.ts -> harness/tool/metaproject-adapter.ts",
  "wiki/deep-enrich.ts -> harness/tool/metaproject-operations.ts",
  "wiki/enrich.ts -> harness/provider/single-turn.ts",
].sort();

/**
 * Group A's five targets, named so that a SIXTH `src/session/` module arriving
 * in the core graph fails here as well as in the two guards that already say so.
 */
const SESSION_STATE_MODULES = [
  "session/external-slate.ts",
  "session/paths.ts",
  "session/slate-course.ts",
  "session/slate.ts",
  "session/store.ts",
];

/**
 * RULE 2, SPLIT ON THE LINE THAT ACTUALLY MATTERS.
 *
 * Not every one of these 210 edges has the same standing, and treating them as
 * one number was the mistake that made the original check unadoptable. The line
 * is whether the core owner being imported HAS a `service.ts` at all:
 *
 *   AVOIDABLE (144)   the owner has a facade and the importer went around it.
 *                     A real bypass, fixable today by routing through the door
 *                     that exists. Ratcheted below.
 *
 *   UNAVOIDABLE (66)  the owner has NO facade, so there is no compliant way to
 *                     import from it. `src/ctx`, `src/gdskills`, `src/review`,
 *                     `src/capability`, `src/metrics`, `src/sync`,
 *                     `src/retention`. Counting these as violations measures a
 *                     missing facade, not undisciplined code, and no call-site
 *                     change can reduce them.
 *
 * The split is DERIVED from the tree — the facade-less set is computed by
 * looking for `service.ts`, never hardcoded — so adding a facade moves an
 * owner across the line automatically instead of leaving a stale list behind.
 *
 * WHY A RATCHET AND NOT AN EXACT PIN
 *
 * An exact pin was written first and is wrong here. Other lanes are landing
 * files in this tree continuously — `src/retention/auto-sweep.ts` appeared
 * between two runs while this guard was being written, moving the total from
 * 208 to 210 — so an exact pin fails for reasons that have nothing to do with
 * the boundary, and a guard that cries wolf gets deleted. It is also incoherent
 * to declare the rule advisory and then fail the build on obeying it.
 *
 * The ratchet keeps both properties that matter. It fails if the count GROWS by
 * even one (no further erosion of a boundary that is already too soft), and it
 * fails if the count falls more than `AVOIDABLE_SLACK` below the ceiling —
 * because a ceiling allowed to drift far above reality stops being evidence of
 * anything, which is the standing objection to ceilings and is answered here
 * rather than ignored.
 */
const AVOIDABLE_BYPASS_CEILING = 144;

/**
 * How far below the ceiling the real count may sit before this test demands the
 * ceiling be lowered. Wide enough that a couple of files landing from another
 * lane do not force an edit; narrow enough that a deliberate cleanup does.
 */
const AVOIDABLE_SLACK = 15;

/** Source zones that bypass a facade, exact — a NEW zone joining is a real change. */
const BYPASSING_ZONES = ["cli.ts", "commands", "harness", "mcp", "session", "tui"];

let cached: Awaited<ReturnType<typeof checkImportPolicy>> | undefined;
async function report() {
  cached ??= await checkImportPolicy({ root: SRC });
  return cached;
}

// ── The scan itself is real ──────────────────────────────────────────────────

test("the live scan reads the whole tree, not a subset", async () => {
  // Anti-vacuous: every assertion below is about findings, and a scan of zero
  // or a handful of files would satisfy most of them by reporting nothing.
  const r = await report();
  expect(r.scanned).toBe(listSourceFiles(SRC).length);
  expect(r.scanned).toBeGreaterThan(500);
  expect(r.edges.length).toBeGreaterThan(1000);
  // The two top-level modules the directory-only zone table could not see.
  expect(r.edges.some((e) => e.from === path.join(SRC, "cli.ts"))).toBe(true);
});

test("a live scan pointed at an empty directory fails instead of passing", async () => {
  // The same check, same code path, aimed at nothing — it must refuse. Without
  // this, every "expect no findings" assertion in this file would also pass on
  // a scan that had silently stopped reading files.
  const empty = await mkdtemp(path.join(tmpdir(), "keryx-live-empty-"));
  try {
    await expect(checkImportPolicy({ root: empty })).rejects.toThrow(/nothing to scan/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

// ── Zone-table coverage ──────────────────────────────────────────────────────

test("every top-level segment under src/ is classified, and nothing classified is gone", () => {
  // Derived from the tree. The old `ZONE_TABLE.length > 10` could not have
  // caught `src/eval`, `src/retention` or `src/sync`, and did not.
  expect({ unclassified: unclassifiedSegments(SRC), stale: staleSegments(SRC) }).toEqual({
    unclassified: [],
    stale: [],
  });
});

test("no live file or import target lands in an unclassified zone", async () => {
  const r = await report();
  expect(r.findings.filter((f) => f.kind === "unclassified-zone")).toEqual([]);
});

test("every relative specifier in the tree resolves", async () => {
  // The direct scan's own integrity: an unresolved specifier is an edge missing
  // from the graph, which is a hole in every assertion below it.
  const r = await report();
  expect(r.findings.filter((f) => f.kind === "unresolved-relative-specifier")).toEqual([]);
});

// ── RULE 1: enforced at zero tolerance against an exact allowlist ────────────

test("core owners import client/adapter modules in exactly the allowlisted places", async () => {
  const r = await report();
  expect(pairsOf(r, "owner-imports-client")).toEqual(OWNER_IMPORTS_CLIENT_ALLOWLIST);
});

test("the sac group reaches only the five documented session-state modules", async () => {
  const r = await report();
  const targets = [
    ...new Set(
      r.findings
        .filter((f) => f.kind === "owner-imports-client" && f.from.includes(`${path.sep}sac${path.sep}`))
        .map((f) => path.relative(SRC, f.to as string)),
    ),
  ].sort();
  expect(targets).toEqual(SESSION_STATE_MODULES);
});

test("the wiki group is the only core->client debt outside the session-state exception", async () => {
  const r = await report();
  const other = pairsOf(r, "owner-imports-client").filter((p) => !p.startsWith("sac/"));
  expect(other.every((p) => p.startsWith("wiki/"))).toBe(true);
  expect(other.length).toBe(9);
});

// ── RULE 2: measured and pinned, not enforced at zero ────────────────────────

/** Does this core owner publish a `service.ts` facade? Read from the tree. */
function hasFacade(owner: string): boolean {
  return existsSync(path.join(SRC, owner, "service.ts"));
}

/** The `client-imports-core-internal` findings, split on facade availability. */
async function bypassSplit(): Promise<{ avoidable: number; unavoidable: number; facadeless: string[] }> {
  const r = await report();
  const findings = r.findings.filter((f) => f.kind === "client-imports-core-internal");
  const facadeless = new Set<string>();
  let avoidable = 0;
  let unavoidable = 0;
  for (const f of findings) {
    const owner = path.relative(SRC, f.to as string).split(path.sep)[0] as string;
    if (hasFacade(owner)) {
      avoidable += 1;
    } else {
      unavoidable += 1;
      facadeless.add(owner);
    }
  }
  return { avoidable, unavoidable, facadeless: [...facadeless].sort() };
}

test("facade bypasses that COULD be fixed today are ratcheted, not allowed to grow", async () => {
  const { avoidable } = await bypassSplit();

  // Growth fails: the boundary is already soft and must not soften further.
  expect(avoidable).toBeLessThanOrEqual(AVOIDABLE_BYPASS_CEILING);
  // Drift fails too: a ceiling far above reality is not evidence of anything.
  // If this trips, someone did the work — lower `AVOIDABLE_BYPASS_CEILING`.
  expect(avoidable).toBeGreaterThan(AVOIDABLE_BYPASS_CEILING - AVOIDABLE_SLACK);
});

test("exactly the known zones bypass a facade — a new one joining is a real change", async () => {
  const r = await report();
  const zones = [
    ...new Set(
      r.findings
        .filter((f) => f.kind === "client-imports-core-internal")
        .map((f) => path.relative(SRC, f.from).split(path.sep)[0] as string),
    ),
  ].sort();
  expect(zones).toEqual(BYPASSING_ZONES);
});

/**
 * The evidence behind not enforcing rule 2 at zero, asserted rather than
 * asserted-in-a-comment.
 *
 * Some core directories have no `service.ts` at all, so an importer has no
 * compliant alternative and a zero-tolerance rule would be demanding something
 * impossible. The set is DERIVED, so if someone adds the missing facades this
 * test fails and the decision recorded above gets revisited on evidence —
 * which is the only way a recorded rationale stays honest instead of outliving
 * its reason.
 */
test("some core zones have no service.ts, so the facade rule is unsatisfiable for them", async () => {
  const { unavoidable, facadeless } = await bypassSplit();

  expect(facadeless).toEqual(["capability", "ctx", "gdskills", "metrics", "retention", "review", "sync"]);
  // Load-bearing rather than theoretical: code really does import from them.
  expect(unavoidable).toBeGreaterThan(0);
});

test("the ten owners src/core.ts publishes really do each have a facade", async () => {
  // The other half of the split, so "avoidable" is not an empty category and
  // the ratchet above is measuring something real.
  const owners = ["flow", "gdgraph", "health", "job", "memory", "sac", "security", "standard", "testing", "wiki"];
  expect(owners.filter(hasFacade)).toEqual(owners);
});

// ── The bundler as a coverage cross-check on the direct scan ─────────────────

test("the bundler reaches no module under src/ that the direct scan failed to name", async () => {
  // A real second opinion on this module's own resolver, on the largest entry
  // point that builds standalone. A gap here means a specifier the direct scan
  // could not follow — which would be a silent hole in every assertion above.
  const r = await report();
  const gaps = await resolutionGaps({ entry: path.join(SRC, "core.ts"), root: SRC, edges: r.edges });
  expect(gaps).toEqual([]);
}, 120_000);
