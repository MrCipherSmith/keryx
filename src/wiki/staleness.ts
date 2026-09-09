// Per-page staleness primitives for `wiki enrich` RLM mode (TRD §3.3, flow
// 169 T5). Extends `enrich.ts`'s `ResumeState.completedNodeHashes`: hash each
// page's key files' content, and let a caller skip re-enriching a page whose
// hash is unchanged since its last successful enrich — regardless of
// classification tier (PRD FR-7). This module builds the primitives only;
// it is NOT wired into `wikiEnrich`'s per-page worker loop yet (that is a
// later task, T6/T7) and `wikiEnrich`'s existing per-page behavior is
// unchanged.
//
// Grounding correction (flow 169 T5, mirrors T2's `computeGraphFanIn` note in
// `journal.md`): `GraphNode` (`gdgraph/types.ts`) stores NO content hash or
// mtime for a file — only `{id, kind, path, language}` — and
// `gdgraph/build.ts` never persists one either (grep for hash/mtime across
// `src/gdgraph` turns up nothing file-content-related). So "hash ... of its
// key-files' graph node content" cannot mean "read a hash field off
// GraphNode" — there is none to read. This module instead hashes each key
// file's CURRENT on-disk content (sha256), scoped to only the page's key
// files (typically <= 6, via `collect.ts`'s `computeModuleKeyFiles`) — not a
// repo-wide re-hash pass.
//
// CORRECTION (flow 169 T10, review finding #1): an earlier version of this
// comment claimed the repo-level staleness signal could be used to skip the
// per-page hash computation entirely whenever the repo "has not moved" since
// the last graph build. That is WRONG, and it stays wrong under the current
// implementation: repo-level staleness is about the file SET and the commit,
// not about a key file's bytes. `wikiEnrich`'s RLM pipeline (`enrich.ts`)
// therefore ALWAYS computes and compares each page's hash — that is the
// correctness-critical check, and it is cheap enough on its own (a handful of
// file hashes per page) to never need a fast-skip.
//
// CORRECTION (flow 236 T8): this module used to end in `checkPageStalenessGate`
// / `PageStalenessGate`, a per-run advisory wrapper around the BOOLEAN
// `graphMaybeStale`. A phase-4 inventory measured it as the eighth capability
// in this programme with zero non-test callers — and it was the only wiki-side
// carrier of graph staleness, so nothing in `wiki refresh`, `wiki verify` or
// `wiki collect` ever asked how old the graph was. Its own doc comments still
// described the `.git/HEAD`-mtime implementation that flow 234 replaced. It is
// gone. What replaced it is `resolveWikiSourceGate` below, which consumes the
// TRI-STATE `checkGraphStaleness` directly (so a git failure stays `unknown`
// instead of collapsing into a boolean) and is called by every wiki path that
// writes a freshness claim.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkGraphStaleness, type StalenessCheck, type StalenessStatus } from "../gdgraph/staleness";
import type { GitHeadResolution } from "../sync/provenance";
import type { GraphData } from "../gdgraph/types";
import type { ResumeState } from "./resume-state";

/**
 * Deterministic hash over a page's key files' current on-disk content.
 * Sorted `{path, content-sha256}` pairs (sorted by path) are hashed together
 * so file ORDER in `keyFiles` never affects the result, only content and
 * membership. A key file that is no longer a known graph node, or fails to
 * read from disk, hashes as a stable `"<missing>"` sentinel rather than being
 * skipped — so a deleted/renamed key file changes the page hash instead of
 * silently preserving an "unchanged" verdict.
 */
export async function computePageNodeHash(
  cwd: string,
  keyFiles: readonly string[],
  graph: GraphData,
): Promise<string> {
  const knownPaths = new Set(
    graph.nodes.filter((node) => node.kind === "file").map((node) => node.path),
  );

  const entries: Array<{ path: string; digest: string }> = [];
  for (const file of keyFiles) {
    let digest = "<missing>";
    if (knownPaths.has(file)) {
      try {
        const content = await readFile(path.join(cwd, file), "utf8");
        digest = createHash("sha256").update(content).digest("hex");
      } catch {
        digest = "<missing>";
      }
    }
    entries.push({ path: file, digest });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const combined = entries.map((entry) => `${entry.path}:${entry.digest}`).join("\n");
  return createHash("sha256").update(combined).digest("hex");
}

/**
 * True when `currentHash` matches the page's last recorded successful-enrich
 * hash (PRD FR-7: "unchanged since last successful enrich", regardless of
 * classification tier). No prior entry (never enriched successfully, or an
 * old resume-state file predating `completedNodeHashes`) ⇒ not unchanged.
 */
export function isPageUnchangedSinceLastEnrich(
  pagePath: string,
  currentHash: string,
  completedNodeHashes: ResumeState["completedNodeHashes"],
): boolean {
  const previous = completedNodeHashes?.[pagePath];
  return previous !== undefined && previous === currentHash;
}

// --- AFC-08 (flow 236 T8): the source gate -------------------------------
//
// Frozen AC1's last clause: "запуск генератора не делает устаревшие входы
// fresh" — running the generator does not make a stale input fresh. Before
// this, `refreshPages` and `verifyPages` took whatever `git rev-parse HEAD`
// answered and stamped it as `VerifiedAt`, regardless of which commit the
// graph they read was built from. Measured live on this checkout: the graph's
// recorded provenance was `60848c77` while HEAD was `886400e8`, so a corpus
// refresh would have rewritten two dozen pages from a source that predated
// HEAD and stamped every one of them as verified AT HEAD. The freshness
// report then reads those pages as current, and the staleness becomes
// invisible — a stale input rendered indistinguishable from a verified one.
//
// The gate is deliberately NOT a blanket refusal. `wiki-specification.md` §7
// draws two different lines, and this follows both:
//
//   - a source ERROR ("Ошибка source сохраняет старый block и видимый
//     stale/unknown result") ⇒ preserve the existing generated block and
//     report `unknown`. Rewriting from a source we could not interrogate
//     would be authoring content on an unverified basis.
//   - a source that is merely OLD ⇒ the generated content is still genuinely
//     what that graph says, so the block is repaired; what must not happen is
//     the STAMP. `stampableHead` is null, so `VerifiedAt` neither advances nor
//     appears, and any stamp already on the page (an older, honest one) is
//     left exactly where it was.

export type { StalenessStatus } from "../gdgraph/staleness";

/** Injection seam for tests; defaults to the real tri-state check. */
export type StalenessProbe = (cwd: string) => Promise<StalenessCheck>;

/**
 * What a wiki generator knows about the revision it might stamp.
 *
 * AFC-22 (flow 236 T13, F236-02): this used to be `string | undefined`, and
 * `undefined` carried two opposite meanings — "this project has no git" and
 * "git is here and could not answer" — plus a third, "this caller never
 * stamps a revision at all". The gate below and `verifyPages` both branch on
 * it, so collapsing those three switched the stale-graph refusal OFF whenever
 * git broke: measured, `keryx wiki verify --baseline` on a repository with a
 * dangling `.git/HEAD` printed "baselined 1 page(s) (no git; scope hash
 * only)" where the same, equally stale graph with healthy git refused to
 * stamp at all. `not-requested` is the explicit form of "I do not care":
 * `wiki/service.ts` and `commands/sync.ts` consult the gate for the graph's
 * age only and never write `VerifiedAt`, and they now say so.
 */
export type WikiHeadInput = GitHeadResolution | { kind: "not-requested" };

/** For a caller that consults the gate but never stamps a revision. */
export const HEAD_NOT_REQUESTED: WikiHeadInput = { kind: "not-requested" };

/**
 * Whether git is present and functioning enough that "unknown" is evidence of
 * a PROBLEM rather than of an absence. `no-repository` (a supported git-free
 * project) and `unborn` (a real repository with no commits) both have no
 * revision to over-claim, so an `unknown` gate there is expected and benign —
 * exactly the case the old `head !== undefined` condition was protecting, and
 * the only part of it that was right.
 */
function headImpliesWorkingGit(head: WikiHeadInput): boolean {
  return head.kind === "resolved" || head.kind === "failed";
}

/** One line naming what the caller's git could tell us about HEAD. */
export function describeHead(head: WikiHeadInput): string {
  switch (head.kind) {
    case "resolved":
      return `at ${head.commit.slice(0, 8)}`;
    case "unborn":
      return "(the git repository has no commits yet; scope hash only)";
    case "no-repository":
      return "(no git; scope hash only)";
    case "failed":
      return `(git is present but could not answer: ${head.detail})`;
    default:
      return "(no revision requested; scope hash only)";
  }
}

export interface WikiSourceGate {
  status: StalenessStatus;
  /** Why the source is not fresh. Empty only when `status === "fresh"`. */
  reasons: readonly string[];
  /**
   * The revision a generator may stamp as `VerifiedAt` — the caller's head
   * when the source demonstrably saw it, and `null` otherwise. Never a
   * revision the source did not see.
   */
  stampableHead: string | null;
  /**
   * True when the source is in ERROR and an existing generated block must be
   * preserved rather than regenerated.
   *
   * Conditioned on git being PRESENT on purpose. A project with no git at
   * all is a supported configuration (`src/commands/init.no-git.test.ts` pins
   * it, and `wiki/provenance.ts` is built around it): there, every git call
   * fails and `checkGraphStaleness` can only ever answer `unknown`, but there
   * is also no revision to over-claim, so nothing is stamped either way and
   * refresh behaves exactly as it did before this gate existed.
   *
   * AFC-22 (flow 236 T13): the condition used to be `head !== undefined`,
   * which is not the same question. A repository whose git BROKE also
   * produces no head — so the genuinely broken case, the one this flag exists
   * for, was the case that switched it off. `headImpliesWorkingGit` asks the
   * question that was meant: is there a repository here whose failure to
   * answer is a fault rather than an absence?
   */
  preserveGenerated: boolean;
}

/**
 * Resolve what a wiki generator is allowed to claim about its source.
 *
 * Consumes the tri-state `checkGraphStaleness` directly rather than the
 * boolean `graphMaybeStale`: the whole point of the tri-state is that a git
 * failure is `unknown` and not "fresh", and a boolean throws that distinction
 * away one call before the decision that needs it.
 */
export async function resolveWikiSourceGate(
  cwd: string,
  head: WikiHeadInput,
  probe: StalenessProbe = checkGraphStaleness,
): Promise<WikiSourceGate> {
  const check = await probe(cwd);
  if (check.status === "fresh") {
    return {
      status: "fresh",
      reasons: [],
      stampableHead: head.kind === "resolved" ? head.commit : null,
      preserveGenerated: false,
    };
  }
  return {
    status: check.status,
    reasons: check.reasons,
    stampableHead: null,
    preserveGenerated: check.status === "unknown" && headImpliesWorkingGit(head),
  };
}

/** One line naming the source's state, for a page changelog or a command. */
export function describeSourceGate(gate: WikiSourceGate): string {
  if (gate.status === "fresh") {
    return "the code graph is current";
  }
  const reasons = gate.reasons.length > 0 ? `: ${gate.reasons.join("; ")}` : "";
  return gate.status === "stale"
    ? `the code graph is stale${reasons}`
    : `the code graph's freshness could not be determined${reasons}`;
}
