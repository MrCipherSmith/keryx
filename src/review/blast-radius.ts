/**
 * Scope B — the blast radius (flow 204, AC1–AC4; specification §1.2–§1.6).
 *
 * A PR review answers "is this change correct?" It does not answer "did this
 * change break something that was working." This module computes the second
 * question's scope: the set of files the change can reach, bounded so the
 * question stays answerable.
 *
 * ## Why it is computed and not browsed
 *
 * "Review the functionality so nothing breaks" naively means "review the whole
 * repository every round", which is unaffordable AND actively harmful: review
 * quality decays as context grows — measured F1 0.65 at round 2 falling to 0.29
 * at round 10. An unbounded scope B would make later rounds worse than earlier
 * ones, which is the opposite of what a fix loop is for.
 *
 * So the set is derived from `gdgraph affected` over the changed files, ranked
 * by edge distance, and cut at a depth and a file cap. Nothing here asks a model
 * which files to open (AC2 / AC-D2), and nothing here reads a file: the input is
 * an in-memory {@link GraphData} and a changed-file list, so the whole thing is
 * a pure function and its defaults can be measured rather than asserted.
 *
 * ## The defaults, measured on this repository
 *
 * 80 commits touching `src/**`, against a graph of 1,041 nodes and 3,147 edges.
 * The set is the union of `computeAffected` over the commit's changed files,
 * minus the changed files themselves:
 *
 *     depth   median   p75   p90   max   commits over 40 files
 *     1         7       18    30    86   3%
 *     2        19       41    65   143   25%    <- default
 *     3        27       48   106   213   39%
 *     4        27       52   146   242   41%
 *
 * Depth 1 is the direct dependents only, and it sees 41% of what depth 2 sees
 * (hop 1 contributed 487 entries against hop 2's 711 over the most recent 40
 * commits): a change to a helper would be checked at its callers and not at
 * their callers, which is where most of this repository's regressions have
 * actually surfaced. Depth 3 buys a median of eight more files and doubles the
 * p90 — the tail explodes while the typical case barely moves, and depth 4 is
 * indistinguishable from depth 3 because the graph saturates. **Depth 2.**
 *
 * The 40-file cap fires on 20 of those 80 commits (25%). What matters is not how
 * often it fires but what it cuts: on 18 of those 20 it removes only hop-2
 * entries, because only 2 commits in 80 have more than 40 *direct* dependents.
 * So in 97.5% of this repository's history the cap never costs a direct
 * dependent, and when it does, it says so — see {@link BlastRadius.dropped},
 * which carries every cut file with its hop and its path back to the change.
 *
 * Cost, for AC-D5: the depth-2 set capped at 40 is a median of 582 KB and a p90
 * of 1,057 KB of source — 9.9% of the graph's 10.7 MB. That is affordable as a
 * FILE LIST with dependency paths, which is what {@link renderBlastRadiusMarkdown}
 * produces, and is not affordable inlined. Scope B hands a reviewer the map, not
 * the territory.
 *
 * ## Related tests: the narrow version, because the wide one is noise
 *
 * The specification says to add "the tests that cover those paths, via the
 * testing module's related-test intelligence". Measured, most of that work is
 * already done: all 481 test files in this repository are graph nodes, and a
 * test importing its subject is a hop-1 reverse-dependency edge, so the covering
 * tests are in the set already.
 *
 * Running `relatedByNamingAndDirectory` over the changed files AND the whole
 * radius adds 1,154 further tests over 80 commits (~15 per round). Of those, 389
 * are unreachable from the change at ANY graph depth — they share a directory
 * and a name fragment and nothing else — and 259 are reachable only at depth 3
 * or beyond, i.e. they are exactly what the depth bound just decided to exclude.
 * Re-adding them by name defeats the bound through a side door.
 *
 * Restricted to the **changed files only**, the same heuristic adds a median of
 * 0 files, a p90 of 5 and a maximum of 8, and fires on 18 of 77 commits. That is
 * the version kept: a test named after a file the change touched is a plausible
 * regression witness even when it reaches the code by a route the graph does not
 * model (a spawned CLI, a fixture, a barrel the resolver missed). Related tests
 * are ranked BELOW every graph entry, so they are the first thing the cap drops
 * — they were not derived from the graph and must not displace something that
 * was.
 *
 * ## What the blast radius cannot see
 *
 * - **Anything that is not a code node.** Of 897 changed files across those 80
 *   commits, 428 are absent from the graph, and every one of them is a `.md`,
 *   `.json`, `.jsonl`, `.sh`, `.yml` or similar — zero TypeScript. A change to a
 *   skill, a rule or a schema therefore has an EMPTY blast radius even though it
 *   changes agent behaviour, and {@link BlastRadius.unresolved} records that as a
 *   fact rather than letting it read as "nothing depends on this".
 * - **Runtime edges.** The graph is built from import specifiers. A dependency
 *   expressed by spawning a process, reading a file another module writes, or
 *   registering through a string key is invisible.
 * - **Direction.** `affected` walks dependents. A change that breaks something it
 *   itself depends on — a narrowed contract consumed the other way — is not in
 *   the set.
 */

import { computeAffected } from "../gdgraph/affected";
import type { GraphData } from "../gdgraph/types";
import { relatedByNamingAndDirectory, TEST_FILE_RE } from "../testing/selection";
import { classifyPath, DEFAULT_REVIEW_SCOPE_CONFIG, type ReviewScopeConfig } from "./scope";
import { REVIEW_FINDING_SEVERITIES, type ReviewFindingSeverity, type StructuredReviewFinding } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Edge distance from the change that stays in scope. See the module header. */
export const DEFAULT_BLAST_RADIUS_DEPTH = 2;

/** How many files scope B may carry. See the module header. */
export const DEFAULT_BLAST_RADIUS_MAX_FILES = 40;

export type BlastRadiusConfig = {
  depth: number;
  maxFiles: number;
  /**
   * Add a changed file's naming-related tests when the graph did not already
   * reach them. Restricted to the changed files — see the module header for why
   * the wide form was measured and rejected.
   */
  includeRelatedTests: boolean;
  /** The path exclusions scope A already applies, reused verbatim. */
  scope: ReviewScopeConfig;
};

/**
 * The overrides form, with `undefined` explicitly allowed on every field.
 *
 * `Partial<BlastRadiusConfig>` would not do under `exactOptionalPropertyTypes`:
 * a caller holding `number | undefined` from a parsed CLI flag could not pass it
 * without narrowing at every call site, and the narrowing invariably becomes a
 * `?? DEFAULT` that duplicates {@link resolveConfig}'s job somewhere else.
 */
export type BlastRadiusConfigOverrides = { [K in keyof BlastRadiusConfig]?: BlastRadiusConfig[K] | undefined };

export const DEFAULT_BLAST_RADIUS_CONFIG: BlastRadiusConfig = {
  depth: DEFAULT_BLAST_RADIUS_DEPTH,
  maxFiles: DEFAULT_BLAST_RADIUS_MAX_FILES,
  includeRelatedTests: true,
  scope: DEFAULT_REVIEW_SCOPE_CONFIG,
};

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** Where an entry came from. `graph` is derived; `related-test` is a name match. */
export const BLAST_RADIUS_SOURCES = ["graph", "related-test"] as const;
export type BlastRadiusSource = (typeof BLAST_RADIUS_SOURCES)[number];

/**
 * One file in scope B.
 *
 * `path` is the dependency chain back to the change, in import order — `caller
 * -> callee -> changed file` — because §1.4 asks a regression reviewer to look
 * at the site that breaks, and the site is unreadable without the route that
 * reaches it.
 */
export type BlastRadiusEntry = {
  file: string;
  /** BFS distance from the nearest changed file. `depth + 1` for a related test. */
  hop: number;
  /** Inbound import edges — the fan-in centrality `computeAffected` reports. */
  fanIn: number;
  /** The changed file this entry is closest to. */
  via: string;
  /** `[file, …, via]`. Length `hop + 1` for a graph entry. */
  path: string[];
  source: BlastRadiusSource;
  isTest: boolean;
};

export const BLAST_RADIUS_DROP_REASONS = ["cap", "pre-filter"] as const;
export type BlastRadiusDropReason = (typeof BLAST_RADIUS_DROP_REASONS)[number];

/**
 * One file that was in the candidate set and is not in the reviewed set.
 *
 * Every one of them is recorded. A silent truncation reads downstream as "we
 * checked everything", which is the exact claim this flow exists to stop the
 * pipeline making — and this repository has been bitten by that shape before,
 * most recently when a recorded drop table was overwritten by the sentence "no
 * pre-filter scope was supplied".
 */
export type BlastRadiusDrop = {
  file: string;
  hop: number;
  fanIn: number;
  via: string;
  source: BlastRadiusSource;
  reason: BlastRadiusDropReason;
  /** The rule that cut it, in words. Rendered verbatim into the record. */
  detail: string;
};

/**
 * A changed file the graph could not answer for.
 *
 * NOT the same fact as "nothing depends on it", and kept separate for that
 * reason: 48% of the files changed in this repository's recent history are
 * absent from the code graph, all of them non-code. A round whose blast radius
 * is empty because every changed file was a Markdown skill has not checked
 * anything, and must not be readable as a round that checked and found nothing.
 */
export type BlastRadiusUnresolved = {
  file: string;
  reason: "not-a-graph-node" | "ambiguous-target" | "excluded-by-pre-filter";
  detail: string;
};

export type BlastRadiusCounts = {
  changedFilesSeen: number;
  changedFilesResolved: number;
  changedFilesUnresolved: number;
  /** Everything the graph and the test heuristic proposed, deduplicated. */
  candidates: number;
  retained: number;
  droppedByCap: number;
  droppedByPreFilter: number;
  relatedTestsAdded: number;
  /** Retained entries that are test files. */
  testsRetained: number;
  hopHistogram: Record<string, number>;
};

export type BlastRadius = {
  schemaVersion: 1;
  scope: "blast-radius";
  depth: number;
  maxFiles: number;
  /** The changed-file set this radius was computed from, sorted. */
  changedFiles: string[];
  /** The reviewed set, closest first. */
  files: BlastRadiusEntry[];
  dropped: BlastRadiusDrop[];
  unresolved: BlastRadiusUnresolved[];
  counts: BlastRadiusCounts;
  /** What the set was computed against, so a stale answer is recognisable. */
  graph: { nodes: number; edges: number };
};

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveConfig(config?: BlastRadiusConfigOverrides): BlastRadiusConfig {
  // Field by field rather than a spread: under `exactOptionalPropertyTypes` a
  // `Partial` may legally carry an explicit `undefined`, and a spread would let
  // it overwrite the default with it.
  const depth = config?.depth ?? DEFAULT_BLAST_RADIUS_CONFIG.depth;
  const maxFiles = config?.maxFiles ?? DEFAULT_BLAST_RADIUS_CONFIG.maxFiles;
  return {
    depth: Number.isFinite(depth) ? Math.max(1, Math.trunc(depth)) : DEFAULT_BLAST_RADIUS_DEPTH,
    maxFiles: Number.isFinite(maxFiles) ? Math.max(0, Math.trunc(maxFiles)) : DEFAULT_BLAST_RADIUS_MAX_FILES,
    includeRelatedTests: config?.includeRelatedTests ?? DEFAULT_BLAST_RADIUS_CONFIG.includeRelatedTests,
    scope: config?.scope ?? DEFAULT_BLAST_RADIUS_CONFIG.scope,
  };
}

/**
 * The forward import relation, `from -> [to, …]`, over non-unresolved edges.
 *
 * Built for ONE purpose: reconstructing the chain from a dependent back to the
 * change, which `AffectedResult` does not carry. It never decides membership —
 * membership is {@link computeAffected}'s answer and nothing else's, because AC2
 * says the set is computed from `gdgraph affected` rather than from a second
 * opinion about what depends on what.
 *
 * Note the direction. `computeAffected` walks the REVERSE relation (who imports
 * X); the chain back to the change needs "what does X import that is one hop
 * closer", which is this one. Walking the reverse relation here would build a
 * path leading away from the change.
 */
function closerNeighbours(graph: GraphData): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "unresolved") {
      continue;
    }
    const bucket = index.get(edge.from);
    if (bucket === undefined) {
      index.set(edge.from, [edge.to]);
    } else if (!bucket.includes(edge.to)) {
      bucket.push(edge.to);
    }
  }
  return index;
}

type Candidate = {
  file: string;
  hop: number;
  fanIn: number;
  via: string;
  path: string[];
  source: BlastRadiusSource;
};

/** hop asc -> fanIn desc -> path asc. The order `computeAffected` already uses. */
function rankOrder(a: Candidate, b: Candidate): number {
  if (a.hop !== b.hop) {
    return a.hop - b.hop;
  }
  if (a.fanIn !== b.fanIn) {
    return b.fanIn - a.fanIn;
  }
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/**
 * Scope B, computed.
 *
 * Pure: same graph and same changed-file list produce the same record, with no
 * filesystem, no network and no model. `testFiles` is the repository's test file
 * list when the caller has one; without it the related-test step contributes
 * nothing and says so in the counts.
 */
export function computeBlastRadius(input: {
  graph: GraphData;
  changedFiles: readonly string[];
  testFiles?: readonly string[] | undefined;
  config?: BlastRadiusConfigOverrides | undefined;
}): BlastRadius {
  const config = resolveConfig(input.config);
  const graph = input.graph;
  const nodePaths = new Set(graph.nodes.map((node) => node.path));

  const changedFiles = [...new Set(input.changedFiles.map(normalizeFile).filter((file) => file.length > 0))].sort();
  const changedSet = new Set(changedFiles);
  const unresolved: BlastRadiusUnresolved[] = [];
  const seeds: string[] = [];

  for (const file of changedFiles) {
    const excluded = classifyPath(file, config.scope);
    if (excluded !== null) {
      unresolved.push({
        file,
        reason: "excluded-by-pre-filter",
        detail: `${excluded.detail} — not seeded, on the same rule scope A drops it by`,
      });
      continue;
    }
    if (!nodePaths.has(file)) {
      unresolved.push({
        file,
        reason: "not-a-graph-node",
        detail:
          "the code graph has no node for this path, so it has no dependents to walk. This is NOT `nothing depends on it`: the graph indexes code, and Markdown, JSON and shell files are absent from it by construction.",
      });
      continue;
    }
    seeds.push(file);
  }

  const closer = closerNeighbours(graph);
  const best = new Map<string, Candidate>();
  let ambiguousSeeds = 0;

  for (const seed of seeds) {
    let result;
    try {
      result = computeAffected(graph, seed, { depth: config.depth, ranked: true });
    } catch (error) {
      // `resolveGraphTarget` refuses an ambiguous suffix rather than guessing.
      // A seed we cannot resolve contributes nothing and is recorded as such;
      // aborting the whole radius because one path was ambiguous would turn a
      // partial answer into no answer, and no answer reads as "nothing broke".
      ambiguousSeeds += 1;
      unresolved.push({
        file: seed,
        reason: "ambiguous-target",
        detail: error instanceof Error ? (error.message.split("\n")[0] ?? "ambiguous graph target") : "ambiguous graph target",
      });
      continue;
    }
    const hopOf = new Map<string, number>(result.ranked.map((entry) => [entry.path, entry.hop]));
    for (const dependent of result.ranked) {
      if (changedSet.has(dependent.path)) {
        // A changed file that also depends on another changed file is scope A's
        // subject, not scope B's. Carrying it here would report the diff back to
        // the reviewer as its own blast radius.
        continue;
      }
      const existing = best.get(dependent.path);
      if (existing !== undefined && existing.hop <= dependent.hop) {
        continue;
      }
      best.set(dependent.path, {
        file: dependent.path,
        hop: dependent.hop,
        fanIn: dependent.fanIn,
        via: seed,
        path: dependencyPathTowards(closer, hopOf, seed, dependent.path, dependent.hop),
        source: "graph",
      });
    }
  }

  // Related tests, of the CHANGED FILES only. Ranked one hop beyond the bound so
  // the cap reaches them before it reaches anything the graph derived.
  let relatedTestsAdded = 0;
  const testFiles = input.testFiles ?? [];
  if (config.includeRelatedTests && testFiles.length > 0) {
    const normalizedTests = testFiles.map(normalizeFile);
    for (const seed of changedFiles) {
      for (const test of relatedByNamingAndDirectory(seed, normalizedTests)) {
        if (changedSet.has(test) || best.has(test) || classifyPath(test, config.scope) !== null) {
          continue;
        }
        best.set(test, {
          file: test,
          hop: config.depth + 1,
          fanIn: 0,
          via: seed,
          path: [test, seed],
          source: "related-test",
        });
        relatedTestsAdded += 1;
      }
    }
  }

  const dropped: BlastRadiusDrop[] = [];
  const ranked: Candidate[] = [];
  for (const candidate of [...best.values()].sort(rankOrder)) {
    const excluded = classifyPath(candidate.file, config.scope);
    if (excluded === null) {
      ranked.push(candidate);
      continue;
    }
    dropped.push({
      file: candidate.file,
      hop: candidate.hop,
      fanIn: candidate.fanIn,
      via: candidate.via,
      source: candidate.source,
      reason: "pre-filter",
      detail: excluded.detail,
    });
  }

  const retained = ranked.slice(0, config.maxFiles);
  for (const cut of ranked.slice(config.maxFiles)) {
    dropped.push({
      file: cut.file,
      hop: cut.hop,
      fanIn: cut.fanIn,
      via: cut.via,
      source: cut.source,
      reason: "cap",
      detail:
        `cut by blast_radius_max_files=${config.maxFiles}: ranked ${ranked.indexOf(cut) + 1} of ${ranked.length} at ` +
        `hop ${cut.hop}, fan-in ${cut.fanIn}, reached via ${cut.via}. It was NOT reviewed.`,
    });
  }

  const files: BlastRadiusEntry[] = retained.map((candidate) => ({
    file: candidate.file,
    hop: candidate.hop,
    fanIn: candidate.fanIn,
    via: candidate.via,
    path: candidate.path,
    source: candidate.source,
    isTest: TEST_FILE_RE.test(candidate.file),
  }));

  const hopHistogram: Record<string, number> = {};
  for (const entry of files) {
    const key = String(entry.hop);
    hopHistogram[key] = (hopHistogram[key] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    scope: "blast-radius",
    depth: config.depth,
    maxFiles: config.maxFiles,
    changedFiles,
    files,
    dropped,
    unresolved,
    counts: {
      changedFilesSeen: changedFiles.length,
      changedFilesResolved: seeds.length - ambiguousSeeds,
      changedFilesUnresolved: unresolved.length,
      candidates: best.size,
      retained: files.length,
      droppedByCap: dropped.filter((drop) => drop.reason === "cap").length,
      droppedByPreFilter: dropped.filter((drop) => drop.reason === "pre-filter").length,
      relatedTestsAdded,
      testsRetained: files.filter((entry) => entry.isTest).length,
      hopHistogram,
    },
    graph: { nodes: graph.nodes.length, edges: graph.edges.length },
  };
}

/**
 * `[entry, …, target]` walking INWARD, one hop closer at each step.
 *
 * A node at hop `h` must import some node at hop `h-1`, and hop 0 is the changed
 * file itself. Ties are broken lexicographically so the rendered chain is stable
 * across runs and diffable between rounds; any chain of the right length is a
 * true one and the smallest is as true as the rest.
 *
 * The chain is reported truncated rather than invented when the walk cannot
 * continue — which only happens if the hop map and the forward edges disagree.
 * `hop` is carried separately on the entry, so the distance is never read off
 * this.
 */
function dependencyPathTowards(
  closer: ReadonlyMap<string, readonly string[]>,
  hopOf: ReadonlyMap<string, number>,
  target: string,
  entry: string,
  hop: number,
): string[] {
  const chain = [entry];
  let current = entry;
  for (let remaining = hop; remaining > 1; remaining -= 1) {
    const next = [...(closer.get(current) ?? [])].filter((candidate) => hopOf.get(candidate) === remaining - 1).sort()[0];
    if (next === undefined) {
      break;
    }
    chain.push(next);
    current = next;
  }
  if (chain.at(-1) !== target) {
    chain.push(target);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// AC4 — when the radius is recomputed
// ---------------------------------------------------------------------------

export type BlastRadiusRecomputeDecision = {
  recompute: boolean;
  /** Why, in words. Rendered verbatim into the round record. */
  reason: string;
  /** Changed files present now and not in the previous radius. */
  added: string[];
  /** Changed files present in the previous radius and not now. */
  removed: string[];
};

/**
 * Whether this round must recompute scope B (AC4 / AC-D4).
 *
 * Three triggers, and the third is not negotiable:
 *
 * 1. No previous radius — there is nothing to reuse.
 * 2. The changed-file set moved, or the depth/cap changed. Reusing a radius
 *    computed for a different set is reusing an answer to a different question.
 * 3. **The final round, always.** A fix landed in round 3 changes what the
 *    change is; without a forced recompute that fix gets no regression check at
 *    all, and the round that certifies the flow is the one that checked the
 *    least. The `isFinalRound` branch is evaluated before the equality check so
 *    an unchanged file set cannot suppress it — that suppression is the whole
 *    failure AC4 names.
 */
export function blastRadiusRecomputeDecision(input: {
  changedFiles: readonly string[];
  isFinalRound: boolean;
  previous?: { changedFiles: readonly string[]; depth: number; maxFiles: number } | undefined;
  depth?: number | undefined;
  maxFiles?: number | undefined;
}): BlastRadiusRecomputeDecision {
  const now = [...new Set(input.changedFiles.map(normalizeFile).filter((file) => file.length > 0))].sort();
  const previous = input.previous;
  const before = previous === undefined ? [] : [...new Set(previous.changedFiles.map(normalizeFile))].sort();
  const added = now.filter((file) => !before.includes(file));
  const removed = before.filter((file) => !now.includes(file));

  if (previous === undefined) {
    return { recompute: true, reason: "no previous blast radius on this flow: the first round always computes one", added, removed };
  }
  if (input.isFinalRound) {
    return {
      recompute: true,
      reason:
        "final round: the blast radius is recomputed whatever the changed-file set did. A fix introduced in a later round would otherwise get no regression check at all.",
      added,
      removed,
    };
  }
  const depth = input.depth ?? DEFAULT_BLAST_RADIUS_DEPTH;
  const maxFiles = input.maxFiles ?? DEFAULT_BLAST_RADIUS_MAX_FILES;
  if (previous.depth !== depth || previous.maxFiles !== maxFiles) {
    return {
      recompute: true,
      reason: `bounds changed: depth ${previous.depth} -> ${depth}, cap ${previous.maxFiles} -> ${maxFiles}`,
      added,
      removed,
    };
  }
  if (added.length > 0 || removed.length > 0) {
    return {
      recompute: true,
      reason: `changed-file set moved: ${added.length} added, ${removed.length} removed`,
      added,
      removed,
    };
  }
  return {
    recompute: false,
    reason: `changed-file set is identical to the previous round (${now.length} files) and the bounds are unchanged; the previous radius still answers this round's question`,
    added,
    removed,
  };
}

// ---------------------------------------------------------------------------
// AC3 — what scope B is allowed to raise
// ---------------------------------------------------------------------------

/**
 * ## Why there is no reviewer deny-list here any more
 *
 * There was one: a finding from `review-style`, `review-clean-code`,
 * `review-architecture` or a conventions reviewer was rejected on the reviewer's
 * NAME, whatever the finding said. Two things were wrong with it, and both were
 * demonstrated rather than argued.
 *
 * It could only ever fire on findings the other rules had already let through —
 * the severity floor is `major`, so by the time the dimension rule was reached
 * the finding was `major` or `blocker`, inside the computed set, and linked to
 * the change. A `review-architecture` blocker reading "blast-radius.ts now
 * imports from src/commands, so the module graph has a cycle and the CLI fails to
 * boot", evidenced by `bun src/cli.ts --help` failing, was refused as a
 * non-regression dimension. That is a regression, and refusing it is a false
 * negative in the direction that hides defects — the exact failure this screen
 * exists to prevent, appearing inside the mechanism meant to prevent it.
 *
 * And the reviewer's name is not a fact about the claim. A reviewer whose usual
 * question is "is this code good" can still notice that the change broke
 * something, and the three surviving rules judge that on its merits: the set
 * bounds where it may be raised, the floor bounds what it may claim, and the link
 * rule requires it to say what the change did. Judge the claim, not the claimant.
 */
export const BLAST_RADIUS_REJECTION_RULES = [
  "outside-set",
  "non-regression-severity",
  "no-link-to-change",
] as const;
export type BlastRadiusRejectionRule = (typeof BLAST_RADIUS_REJECTION_RULES)[number];

export type BlastRadiusRejection = {
  finding: Partial<StructuredReviewFinding>;
  rule: BlastRadiusRejectionRule;
  /** Why it was refused, in words. Rendered verbatim; never dropped silently. */
  detail: string;
};

export type BlastRadiusScreenResult<T> = {
  accepted: T[];
  rejected: BlastRadiusRejection[];
  /** The floor applied, so a record says what standard it held findings to. */
  minSeverity: ReviewFindingSeverity;
};

/** The reviewer skill scope B is dispatched as. See {@link isBlastRadiusScopedFinding}. */
export const BLAST_RADIUS_SCOPE_REVIEWER = "review-regression";

/**
 * What {@link screenBlastRadiusFindings} needs at ingest, plus who to run it over.
 *
 * The set and the changed files are the record `keryx review blast-radius`
 * produces, so the whole thing is a subset of {@link BlastRadius} and a caller
 * holding one can pass it unchanged.
 */
export type BlastRadiusScreenInput = Pick<BlastRadius, "files" | "changedFiles"> & {
  /** The scope-B floor. Defaults to `major` — see {@link screenBlastRadiusFindings}. */
  minSeverity?: ReviewFindingSeverity | undefined;
  /**
   * The reviewers this round dispatched under scope B. Defaults to
   * {@link BLAST_RADIUS_SCOPE_REVIEWER}.
   */
  reviewers?: readonly string[] | undefined;
};

/**
 * Whether a finding was raised under scope B, and is therefore the screen's
 * business.
 *
 * This is NOT the reviewer deny-list that was removed above, and the difference
 * is the whole of why it is allowed to read a name. The deny-list decided
 * REJECTION by reviewer — the same claim accepted or refused depending on who
 * signed it, which is how a `blocker` regression came to be thrown away. This
 * decides which QUESTION a finding was asked, and the question is a property of
 * the dispatch: scope A asks "is this change correct", scope B asks "does it
 * break something that was working", and a round runs both. Screening scope A's
 * findings by scope B's rules would reject every legitimate `minor` on a changed
 * file; screening nothing would leave AC3 as prose again.
 *
 * `review-finding.schema.json` carries no `scope` property and is
 * `additionalProperties: false`, so the reviewer name is the only record of the
 * dispatch that survives into the finding. When an orchestrator dispatches scope
 * B under other names it declares them in
 * {@link BlastRadiusScreenInput.reviewers} rather than editing this default.
 *
 * Matching is by containment on a normalised name, so `review-regression`,
 * `Review-Regression` and `review-regression (deep)` are one reviewer.
 */
export function isBlastRadiusScopedFinding(
  finding: Pick<Partial<StructuredReviewFinding>, "reviewer">,
  reviewers: readonly string[] = [BLAST_RADIUS_SCOPE_REVIEWER],
): boolean {
  const name = normalizeReviewerName(finding.reviewer ?? "");
  if (name === "") {
    return false;
  }
  return reviewers.some((candidate) => {
    const declared = normalizeReviewerName(candidate);
    return declared !== "" && name.includes(declared);
  });
}

function normalizeReviewerName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function severityRank(severity: ReviewFindingSeverity): number {
  return REVIEW_FINDING_SEVERITIES.indexOf(severity);
}

/**
 * Every token that could tie a finding to the change: the changed paths, their
 * basenames, and their basenames without an extension.
 *
 * Extension-less basenames are included because a finding legitimately names a
 * module rather than a file (`the new behaviour in `blast-radius``), and a
 * regression claim written that way is still linked. Two characters or fewer are
 * dropped — a file called `a.ts` would otherwise match the letter "a" in any
 * prose and the rule would never fire.
 */
function changeTokens(changedFiles: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const file of changedFiles) {
    const normalized = normalizeFile(file);
    tokens.add(normalized.toLowerCase());
    const basename = normalized.split("/").at(-1) ?? normalized;
    tokens.add(basename.toLowerCase());
    const dot = basename.indexOf(".");
    if (dot > 0) {
      tokens.add(basename.slice(0, dot).toLowerCase());
    }
  }
  return [...tokens].filter((token) => token.length > 2);
}

/**
 * Everything the finding says, INCLUDING where it says it.
 *
 * `file` was deliberately excluded once, on the reasoning that a finding should
 * have to name the change in prose. The effect was the opposite of the intent: a
 * finding anchored to a changed file by rule 1 was then rejected for not
 * repeating its own filename in a sentence. `src/commands/review.ts` reporting
 * "the caller now passes an unbounded depth, so the command allocates until the
 * process is killed" — evidenced by an OOM at 4.1 GB — is a regression claim
 * about a changed file, and the anchor is the strongest link to the change there
 * is. A rule that reads every field except the one that locates the finding is
 * measuring prose style.
 */
function findingText(finding: Partial<StructuredReviewFinding>): string {
  return [
    finding.file,
    finding.problem,
    finding.impact,
    finding.evidence,
    finding.suggested_fix,
    finding.symbol,
    ...(finding.class_scope?.sites ?? []),
    finding.class_scope?.enumeration_method,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

/**
 * Enforce AC3: what scope B may and may not raise, decided in code.
 *
 * Scope B asks one question — *does this change break an existing behaviour
 * here?* The blast-radius set is under **regression check**, not under review.
 * A finding about style, naming or architecture in code the change did not touch
 * is a different question that this round did not ask, and prose asking a
 * reviewer not to raise it has been tried: this repository's skills are full of
 * such sentences and the findings arrive anyway. So the orchestrator refuses
 * them, and the refusal is a value the caller has to handle rather than a
 * paragraph a model can reinterpret.
 *
 * Three rules, in order of how strong the fact behind them is. Every one of them
 * is a fact about the CLAIM; none is a fact about who made it. A fourth rule that
 * rejected on the reviewer's name was removed — see
 * {@link BLAST_RADIUS_REJECTION_RULES} for the two blocker-severity regressions
 * it refused.
 *
 * 1. `outside-set` — the finding is about a file that is neither in the
 *    blast-radius set nor in the changed set. The reviewer went browsing; there
 *    is no bounded scope left. A finding with no `file` survives this rule only
 *    when its `class_scope.sites` name something in the set, because a
 *    repository-wide regression claim is legitimate and a repository-wide
 *    *opinion* is exactly what the bound exists to exclude.
 * 2. `non-regression-severity` — below the floor. This is not an arbitrary
 *    threshold: under the canonical rubric `minor` means "the code behaves
 *    correctly; the cost lands on whoever reads it next" and `info` names
 *    neither a trigger nor an outcome. Both are self-contradictory as regression
 *    claims — a break in existing behaviour names a trigger and an outcome and is
 *    therefore `major` or above. The floor is configurable because the rubric is
 *    the repository's, not this function's.
 * 3. `no-link-to-change` — nothing in the finding names any changed file, module
 *    or symbol. A regression claim asserts that THE CHANGE broke this site; one
 *    that never mentions the change is a review of untouched code wearing scope
 *    B's badge.
 *
 * Rejections are returned, never discarded. A rejected finding is a fact about
 * the round — it may be a real observation raised under the wrong scope, and the
 * operator gets to see it and file it where it belongs.
 */
export function screenBlastRadiusFindings<T extends Partial<StructuredReviewFinding>>(
  findings: readonly T[],
  radius: Pick<BlastRadius, "files" | "changedFiles">,
  options?: { minSeverity?: ReviewFindingSeverity | undefined },
): BlastRadiusScreenResult<T> {
  const minSeverity = options?.minSeverity ?? "major";
  const floor = severityRank(minSeverity);
  const inScope = new Set<string>([...radius.files.map((entry) => entry.file), ...radius.changedFiles.map(normalizeFile)]);
  const tokens = changeTokens(radius.changedFiles);

  const accepted: T[] = [];
  const rejected: BlastRadiusRejection[] = [];

  for (const finding of findings) {
    const file = typeof finding.file === "string" ? normalizeFile(finding.file) : undefined;
    const sites = (finding.class_scope?.sites ?? []).map((site) => normalizeFile(site.split(":")[0] ?? site));
    const anchored = (file !== undefined && inScope.has(file)) || sites.some((site) => inScope.has(site));
    if (!anchored) {
      rejected.push({
        finding,
        rule: "outside-set",
        detail:
          `${file ?? "(no file)"} is neither in the blast-radius set nor in the changed set. ` +
          "Scope B is bounded to the computed set; a finding outside it was not in scope for this round.",
      });
      continue;
    }
    const severity = finding.severity;
    if (severity !== undefined && severityRank(severity) > floor) {
      rejected.push({
        finding,
        rule: "non-regression-severity",
        detail:
          `severity \`${severity}\` is below the scope-B floor \`${minSeverity}\`. Under the canonical rubric ` +
          "`minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; " +
          "neither can be a claim that the change broke an existing behaviour.",
      });
      continue;
    }
    const text = findingText(finding);
    if (tokens.length > 0 && !tokens.some((token) => text.includes(token))) {
      rejected.push({
        finding,
        rule: "no-link-to-change",
        detail:
          "nothing in the finding names a changed file, module or symbol. A regression claim says THE CHANGE broke this " +
          "site; one that never mentions the change is a review of code the change did not touch.",
      });
      continue;
    }
    accepted.push(finding);
  }

  return { accepted, rejected, minSeverity };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The heading `keryx review blast-radius --out` writes and readers look for. */
export const BLAST_RADIUS_HEADING = "## Blast radius";

const BLAST_RADIUS_BLOCK = /^## Blast radius[^\n]*\n[\s\S]*?(?=^## (?!#)|$(?![\s\S]))/m;

/**
 * Put `block` into `text`, REPLACING a pre-existing one rather than adding a
 * second — the same rule `upsertPreFilterScopeBlock` learned the hard way, where
 * three runs of one command left three contradictory blocks in one record with
 * no rule for which to read.
 */
export function upsertBlastRadiusBlock(text: string, block: string): string {
  const body = `${block.trimEnd()}\n`;
  if (BLAST_RADIUS_BLOCK.test(text)) {
    // A function replacement, not a string: `$&` and `$1` are live in a
    // replacement string and a drop detail is arbitrary text.
    return `${text.replace(BLAST_RADIUS_BLOCK, () => `${body}\n`).trimEnd()}\n`;
  }
  return text.trimEnd() === "" ? body : `${text.trimEnd()}\n\n${body}`;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * The record AC1 asks for: the set, the depth, and **everything dropped by the
 * cap**.
 *
 * All three halves are non-optional. A record carrying only the retained set
 * reads afterwards as "we checked everything", and the unresolved list is
 * printed even when empty because "no changed file was invisible to the graph"
 * is only worth reading if it comes from something that would have said
 * otherwise.
 */
export function renderBlastRadiusMarkdown(radius: BlastRadius): string {
  const lines: string[] = [];
  lines.push(BLAST_RADIUS_HEADING);
  lines.push("");
  lines.push("scope: blast-radius (regression check — NOT a review of this code)");
  lines.push(`depth: ${radius.depth}`);
  lines.push(`max_files: ${radius.maxFiles}`);
  lines.push(`graph: ${radius.graph.nodes} nodes, ${radius.graph.edges} edges`);
  lines.push(`changed_files: ${radius.counts.changedFilesSeen}`);
  lines.push(`changed_files_unresolved: ${radius.counts.changedFilesUnresolved}`);
  lines.push(`candidates: ${radius.counts.candidates}`);
  lines.push(`retained: ${radius.counts.retained}`);
  lines.push(`dropped_by_cap: ${radius.counts.droppedByCap}`);
  lines.push(`dropped_by_pre_filter: ${radius.counts.droppedByPreFilter}`);
  lines.push(`related_tests_added: ${radius.counts.relatedTestsAdded}`);
  lines.push(`tests_retained: ${radius.counts.testsRetained}`);
  lines.push(
    `hops: ${
      Object.keys(radius.counts.hopHistogram).length === 0
        ? "none"
        : Object.entries(radius.counts.hopHistogram)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([hop, count]) => `${hop}=${count}`)
            .join(", ")
    }`,
  );
  lines.push("");

  lines.push("### Under regression check");
  lines.push("");
  if (radius.files.length === 0) {
    lines.push(
      radius.counts.changedFilesResolved === 0
        ? "_no changed file reached the code graph, so no blast radius could be computed. This is NOT `nothing depends on the change` — see Unresolved below._"
        : "_the changed files have no dependents within the configured depth._",
    );
  } else {
    lines.push("| file | hop | fan-in | path back to the change | source |");
    lines.push("|---|---|---|---|---|");
    for (const entry of radius.files) {
      lines.push(
        `| ${escapePipes(entry.file)} | ${entry.hop} | ${entry.fanIn} | ${escapePipes(entry.path.join(" -> "))} | ${entry.source}${
          entry.isTest ? " (test)" : ""
        } |`,
      );
    }
  }
  lines.push("");

  lines.push("### Dropped — NOT reviewed");
  lines.push("");
  if (radius.dropped.length === 0) {
    lines.push("_nothing was dropped: the candidate set fitted inside the cap._");
  } else {
    lines.push("| file | hop | reason | why |");
    lines.push("|---|---|---|---|");
    for (const drop of radius.dropped) {
      lines.push(`| ${escapePipes(drop.file)} | ${drop.hop} | ${drop.reason} | ${escapePipes(drop.detail)} |`);
    }
  }
  lines.push("");

  lines.push("### Changed files the graph could not answer for");
  lines.push("");
  if (radius.unresolved.length === 0) {
    lines.push("_every changed file resolved to a graph node._");
  } else {
    lines.push("| file | reason | why |");
    lines.push("|---|---|---|");
    for (const item of radius.unresolved) {
      lines.push(`| ${escapePipes(item.file)} | ${item.reason} | ${escapePipes(item.detail)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * `## Scope B rejections` — what the orchestrator refused, and under which rule.
 *
 * Written whether or not anything was rejected. AC3 is enforced by deleting
 * findings from a round's output, and a deletion nobody can see is the failure
 * shape this whole programme exists to remove.
 */
export function renderBlastRadiusScreenMarkdown(result: BlastRadiusScreenResult<Partial<StructuredReviewFinding>>): string {
  const lines: string[] = [];
  lines.push("## Scope B rejections");
  lines.push("");
  lines.push(`severity_floor: ${result.minSeverity}`);
  lines.push(`accepted: ${result.accepted.length}`);
  lines.push(`rejected: ${result.rejected.length}`);
  lines.push("");
  if (result.rejected.length === 0) {
    lines.push("_every scope-B finding was a regression claim inside the computed set._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| finding | reviewer | rule | why |");
  lines.push("|---|---|---|---|");
  for (const rejection of result.rejected) {
    lines.push(
      `| ${escapePipes(rejection.finding.id ?? "(no id)")} | ${escapePipes(rejection.finding.reviewer ?? "(unknown)")} | ${
        rejection.rule
      } | ${escapePipes(rejection.detail)} |`,
    );
  }
  lines.push("");
  lines.push("Rejected findings are recorded, not deleted: raise them under scope A or as a separate review.");
  lines.push("");
  return lines.join("\n");
}

/**
 * The scope-B half of a reviewer dispatch, rendered from the record.
 *
 * Belt and braces, deliberately. {@link screenBlastRadiusFindings} enforces AC3
 * whatever the reviewer was told, so this brief is not the enforcement — but a
 * reviewer that has to be told after the fact has already spent the dispatch
 * producing findings that will all be refused, and the tokens are gone whether
 * or not the output survives. The brief is cheap; the round it saves is not.
 *
 * Generated rather than written into the skill so it cannot drift from the set
 * it describes: the file list, the depth and the cut are the record's, not a
 * model's summary of it.
 */
export function renderBlastRadiusDispatchBrief(radius: BlastRadius): string {
  const lines: string[] = [];
  lines.push("SCOPE: blast-radius");
  lines.push("");
  lines.push(
    "QUESTION: does the change break an existing behaviour at any of these sites? Nothing else. These files are under",
  );
  lines.push(
    "regression check, not under review — a finding about their style, naming or architecture is rejected by the",
  );
  lines.push("orchestrator in code, whatever its merit, because this round did not ask that question.");
  lines.push("");
  lines.push(`Anchor every finding to one of the ${radius.files.length} files below or to a changed file, at severity`);
  lines.push("`major` or above, and name the change it breaks. A finding that cites none of the changed files is not a");
  lines.push("regression claim.");
  lines.push("");
  lines.push(`CHANGED (${radius.changedFiles.length}): ${radius.changedFiles.join(", ") || "none"}`);
  lines.push("");
  // The header states the bound the entries actually obey. Related tests are
  // ranked one hop beyond the graph depth so the cap reaches them first, so a
  // flat `depth <= 2` printed above a hop-3 row is a line that contradicts the
  // rows under it — and this is the text a model is asked to trust.
  const hasRelatedTests = radius.files.some((entry) => entry.source === "related-test");
  lines.push(
    `UNDER REGRESSION CHECK (${radius.files.length}, closest first, graph depth <= ${radius.depth}${
      hasRelatedTests ? `; naming-related tests of the changed files are ranked last, at hop ${radius.depth + 1}` : ""
    }):`,
  );
  for (const entry of radius.files) {
    lines.push(`  - ${entry.file}  [hop ${entry.hop}]  ${entry.path.join(" -> ")}`);
  }
  if (radius.dropped.length > 0) {
    lines.push("");
    lines.push(
      `NOT CHECKED (${radius.dropped.length} dropped by the cap or the pre-filter). This round does not cover them.`,
    );
  }
  if (radius.unresolved.length > 0) {
    lines.push("");
    lines.push(
      `NOT ANSWERABLE (${radius.unresolved.length} changed files absent from the code graph). Their blast radius is unknown, not empty.`,
    );
  }
  return lines.join("\n");
}
