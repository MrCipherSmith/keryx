// LWG-10 freshness report (flow 226, phase 1).
//
// Assembles the read-only backlog: what changed, which pages it puts in
// doubt, why, and what this report could not see. Never mutates a wiki page
// and never exits non-zero — it is a report, not a gate. A blocking freshness
// check invites updating a page so CI passes, which manufactures filler
// faster than drift manufactures staleness.
//
// Two rules inherited from phase 0 and its review, both already paid for
// once, both easy to lose here:
//
//   The module set has exactly one source — `validModuleNames`. This is its
//   fourth consumer, and re-deriving grouping is what that function was
//   extracted to prevent.
//
//   An absent graph means "nothing to say", never "everything is stale".
//   `validModuleNames` returns `undefined` rather than an empty set for
//   precisely this reason, and `orphan`/`undocumented` — the two categories
//   derived from a node's ABSENCE — must be suppressed entirely when the
//   graph itself is absent. A report that marked the whole corpus stale
//   because nobody had run `gdgraph build` would be worse than no report.

import { readFile } from "node:fs/promises";
import type { GraphData } from "../../gdgraph/types";
import { computeModuleKeyFiles, collectPages } from "../collect";
import { resolveDescribeSet } from "../describes";
import { moduleNameFromProjectPath, validModuleNames } from "../service";
import type { ChangeClass, ClassifiedChange } from "./classify-change";
import { evaluatePageFreshness, type GitRunner } from "./page-freshness";
import { propagate, type Confidence, type Reason } from "./propagate";

export type Category =
  | "stale-reference"
  | "stale-prose"
  | "undocumented"
  | "orphan"
  | "unknown";

export type LimitationCode =
  | "symbol-layer-unavailable"
  | "graph-stale"
  | "unresolved-edges-present"
  | "queue-truncated"
  | "page-without-describes"
  | "not-a-git-repository";

export interface ReportEntry {
  path: string;
  subjectPath?: string;
  category: Category;
  confidence: Confidence;
  verifiedAt: string | null;
  commitsBehind: number;
  reasons: Reason[];
}

export interface Limitation {
  code: LimitationCode;
  detail: string;
  affectedCount?: number;
}

export interface FreshnessReport {
  schemaVersion: 1;
  generatedAt: string;
  range: { fromRev?: string; toRev: string; queueEntriesConsumed?: number };
  totals: {
    pagesTotal: number;
    pagesFresh: number;
    pagesAffected: number;
    pagesUndecidable: number;
    /** Pages that declared `Describes: none` — a decision, not a gap. */
    pagesNotCodeScoped?: number;
    filesChanged: number;
    filesCosmetic: number;
  };
  pages: ReportEntry[];
  limitations: Limitation[];
}

export interface BuildReportInput {
  cwd: string;
  graph: GraphData;
  changes: readonly ClassifiedChange[];
  symbolLayerAvailable: boolean;
  git: GitRunner;
  fromRev?: string | undefined;
  toRev: string;
  queueEntriesConsumed?: number | undefined;
  queueTruncated?: boolean | undefined;
  now?: () => Date;
}

export async function buildFreshnessReport(input: BuildReportInput): Promise<FreshnessReport> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const limitations: Limitation[] = [];

  const modules = await validModuleNames(input.cwd);
  const filesChanged = input.changes.length;
  const filesCosmetic = input.changes.filter((c) => c.changeClass === "cosmetic").length;

  const emptyTotals = {
    pagesTotal: 0,
    pagesFresh: 0,
    pagesAffected: 0,
    pagesUndecidable: 0,
    filesChanged,
    filesCosmetic,
  };

  if (modules === undefined) {
    // AC8. Not a degraded report — no report. Emitting `orphan` rows here
    // would accuse every page of describing deleted code on the evidence that
    // nobody has built the graph.
    limitations.push({
      code: "graph-stale",
      detail:
        "The code graph has not been built, so no page could be evaluated. Run `keryx gdgraph build`. An absent graph is not evidence that anything is stale.",
    });
    return {
      schemaVersion: 1,
      generatedAt: now,
      range: { toRev: input.toRev, ...(input.fromRev ? { fromRev: input.fromRev } : {}) },
      totals: emptyTotals,
      pages: [],
      limitations,
    };
  }

  if (!input.symbolLayerAvailable) {
    limitations.push({
      code: "symbol-layer-unavailable",
      detail:
        "Signature-level classification was unavailable, so every substantive change was reported as `body`. Pages that a signature change would have marked `stale-reference` may be missing.",
    });
  }
  if (input.queueTruncated) {
    limitations.push({
      code: "queue-truncated",
      detail: "At least one queue entry exceeded its path limit; its revision was re-read from git.",
    });
  }

  const pages = await collectPages(input.cwd);
  const keyFilesIndex = computeModuleKeyFiles(input.graph);
  const knownPaths = new Set(
    input.graph.nodes.filter((node) => node.kind === "file").map((node) => node.path),
  );

  const propagation = propagate({ graph: input.graph, changes: input.changes });
  if (propagation.unresolvedEdgesPresent) {
    // Carry the MAGNITUDE, not just the fact. "Coverage is partial" with no
    // scale invites two wrong reactions — ignoring it forever, or treating a
    // rounding error as a blocker. On this repository it is 50 edges of 3406
    // (1.5%), nearly all test fixtures and Python stdlib imports inside them.
    const unresolved = input.graph.edges.filter((edge) => edge.kind === "unresolved").length;
    const total = input.graph.edges.length;
    const share = total > 0 ? ((unresolved / total) * 100).toFixed(1) : "0.0";
    limitations.push({
      code: "unresolved-edges-present",
      detail:
        `${unresolved} of ${total} graph edges (${share}%) are unresolved imports, so propagation could not follow every dependency. ` +
        "Judge whether that share matters before acting on it.",
      affectedCount: unresolved,
    });
  }
  const affectedByPage = new Map(propagation.pages.map((page) => [page.pageId, page]));

  const entries: ReportEntry[] = [];
  let undecidable = 0;
  let notCodeScoped = 0;
  let fresh = 0;

  for (const page of pages) {
    const content = await readFile(page.absolutePath, "utf8").catch(() => "");
    const describeSet = resolveDescribeSet({
      page: { relativePath: page.relativePath },
      content,
      knownPaths,
      keyFilesIndex,
    });

    if (describeSet.paths.length === 0) {
      // §4.4.1: out of scoring entirely — not fresh, not orphaned.
      //
      // Two different states share this branch and must not share a report
      // line. A page that DECLARED `Describes: none` is a recorded decision:
      // it describes generated state or an ADR, not a region of code, and no
      // one should keep trying to give it a scope. A page that simply has no
      // describe-set is work nobody has done. Counting them together makes the
      // second invisible behind the first.
      if (describeSet.notCodeScoped) {
        notCodeScoped += 1;
      } else {
        undecidable += 1;
      }
      continue;
    }

    // `orphan` is NOT re-detected here. `wikiPruneOrphans` already owns that
    // question and already refuses to delete accepted pages; this projects the
    // same module-set signal and adds the reason chain it lacks.
    const orphanModules = describeSet.paths
      .map((filePath) => moduleNameFromProjectPath(filePath))
      .filter((module) => !modules.has(module));
    if (orphanModules.length === describeSet.paths.length && describeSet.paths.length > 0) {
      entries.push({
        path: page.relativePath,
        category: "orphan",
        confidence: "review-suggested",
        verifiedAt: page.verifiedAt ?? null,
        commitsBehind: 0,
        reasons: [
          {
            sourcePath: describeSet.paths[0] as string,
            changeClass: "removed",
            edgePath: ["describes"],
            symbols: [],
          },
        ],
      });
      continue;
    }

    const freshness = await evaluatePageFreshness({
      cwd: input.cwd,
      page: {
        path: page.relativePath,
        verifiedAt: page.verifiedAt ?? null,
        verifiedScope: page.verifiedScope ?? null,
      },
      describePaths: describeSet.paths,
      graph: input.graph,
      git: input.git,
    });

    const affected = affectedByPage.get(`wiki:${page.relativePath}`);

    if (freshness.basis === "undecidable") {
      // A page nobody ever verified. `unknown` is the honest category — it is
      // not fresh, and it is not stale either; nobody knows.
      entries.push({
        path: page.relativePath,
        category: "unknown",
        confidence: affected?.confidence ?? "fyi",
        // Report the pointer the page actually carries, even though it could
        // not be used. Blanking it hides a stale `VerifiedAt` from the one
        // reader able to repair it.
        verifiedAt: page.verifiedAt ?? null,
        commitsBehind: 0,
        reasons: affected?.reasons ?? [],
      });
      continue;
    }

    // PROVENANCE OUTRANKS PROPAGATION when it is the stronger measurement.
    //
    // Propagation is computed from the range's changed files and knows nothing
    // about when a page was confirmed. So a page verified AFTER those changes
    // was still being reported `must-refresh` — the report asserting work that
    // had already been done. Found by running `refresh` and watching the same
    // ten pages come back stale with `commitsBehind: 0`.
    //
    // `commitsBehind === 0` on the git basis means: nothing in this page's
    // describe-set moved since it was verified. The Reference block is derived
    // from exactly that set, so `stale-reference` is then not merely
    // unhelpful, it is false.
    const scopeConfirmed = freshness.basis === "git-log" && !freshness.changed;
    const reasons = affected?.reasons ?? [];
    const fromOwnScope = reasons.filter((reason) => reason.edgePath.length === 1);
    const fromDependencies = reasons.filter((reason) => reason.edgePath.length > 1);

    if (scopeConfirmed && fromDependencies.length === 0) {
      // Everything that reached it came through its own describes edge, and
      // its own scope is confirmed. Nothing to say.
      fresh += 1;
      continue;
    }
    if (!affected && !freshness.changed) {
      fresh += 1;
      continue;
    }

    if (scopeConfirmed) {
      // A dependency moved, but this page's own code did not. That is worth
      // knowing and is never a refresh instruction: capped at `fyi`, and it
      // cannot be `stale-reference`, because the block it would refresh is
      // already current.
      entries.push({
        path: page.relativePath,
        category: "stale-prose",
        confidence: "fyi",
        verifiedAt: page.verifiedAt ?? null,
        commitsBehind: freshness.commitsBehind,
        reasons: fromDependencies,
      });
      continue;
    }

    entries.push({
      path: page.relativePath,
      category: categorise(reasons.length > 0 ? reasons : fromOwnScope, content),
      confidence: cap(affected?.confidence ?? "review-suggested", freshness.confidenceCap),
      verifiedAt: page.verifiedAt ?? null,
      commitsBehind: freshness.commitsBehind,
      reasons,
    });
  }

  if (undecidable > 0) {
    limitations.push({
      code: "page-without-describes",
      detail:
        "Pages whose describe-set resolved empty were excluded from scoring. Give them an explicit `Describes:` frontmatter list to bring them in, or `Describes: none` if the page is not about code.",
      affectedCount: undecidable,
    });
  }
  // Deliberately NOT a limitation: these pages declared themselves out of
  // scope, so nothing about the report is incomplete because of them.
  // Reporting them as a gap would keep inviting work that should not happen.

  // AC13: order by how far behind, because the distribution is heavily
  // skewed — measured median 6, max 228 on this repository — and an
  // alphabetical report buries the entire debt in its tail.
  entries.sort((a, b) => {
    if (b.commitsBehind !== a.commitsBehind) return b.commitsBehind - a.commitsBehind;
    return a.path.localeCompare(b.path);
  });

  return {
    schemaVersion: 1,
    generatedAt: now,
    range: {
      toRev: input.toRev,
      ...(input.fromRev ? { fromRev: input.fromRev } : {}),
      ...(input.queueEntriesConsumed === undefined
        ? {}
        : { queueEntriesConsumed: input.queueEntriesConsumed }),
    },
    totals: {
      pagesTotal: pages.length,
      pagesFresh: fresh,
      pagesAffected: entries.length,
      pagesUndecidable: undecidable,
      pagesNotCodeScoped: notCodeScoped,
      filesChanged,
      filesCosmetic,
    },
    pages: entries,
    limitations,
  };
}

/**
 * One category per page, chosen by the most work it implies.
 *
 * `stale-prose` outranks `stale-reference`: a changed symbol NAMED in the
 * prose means someone has to read and rewrite sentences, where a Reference
 * block can be regenerated mechanically. Reporting the cheaper category when
 * the expensive one applies would understate the work.
 */
function categorise(reasons: readonly Reason[], pageContent: string): Category {
  const prose = proseOf(pageContent);
  for (const reason of reasons) {
    if (reason.symbols.some((symbol) => mentions(prose, symbol))) {
      return "stale-prose";
    }
  }
  const shapeChanged = reasons.some((reason) => isShapeChange(reason.changeClass));
  return shapeChanged ? "stale-reference" : "stale-prose";
}

function isShapeChange(changeClass: ChangeClass): boolean {
  return (
    changeClass === "signature" ||
    changeClass === "added" ||
    changeClass === "removed" ||
    changeClass === "moved"
  );
}

/** Page text minus the machine-owned Reference section. */
function proseOf(content: string): string {
  const marker = content.search(/^##\s+Reference\b/im);
  return marker >= 0 ? content.slice(0, marker) : content;
}

function mentions(prose: string, symbol: string): boolean {
  if (symbol.length < 3) {
    // Two-character identifiers match far too much ordinary prose to be
    // evidence of anything.
    return false;
  }
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(prose);
}

const ORDER: Confidence[] = ["must-refresh", "review-suggested", "fyi"];

function cap(confidence: Confidence, ceiling: Confidence): Confidence {
  return ORDER.indexOf(confidence) < ORDER.indexOf(ceiling) ? ceiling : confidence;
}
