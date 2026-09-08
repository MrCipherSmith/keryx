// THE FIFTH INSTANCE, AND THE RENDERERS NOBODY HAD AUDITED (flow 235, T18)
//
// One defect shape has now been found five times in this programme: a DISPLAY
// decision — a ballast filter, a `limit` slice, a page length, a token budget —
// used to make a statement about the CORPUS. Four of those were closed inside
// the payload (`src/gdgraph/find.ts`, `src/mcp/tools.ts`, pinned by
// `src/gdgraph/find-display-truth.test.ts`). The renderers that print prose
// BESIDE the payload had never been looked at in any of the four rounds.
//
// The method that found the fourth instance is the method used here: for every
// string a renderer produces, list every value it interpolates OR BRANCHES ON,
// and trace each to the scan or to the page. Not "does a count appear in the
// text" — `insufficient-evidence` was missed by that question because it
// branched on a page length without printing one.
//
// MEASURED BEFORE THIS FILE EXISTED, on 2026-09-08:
//
//   formatFind, 100-file corpus with 40 genuine matches, fileLimit 0:
//     code: ok
//     reason: 40 files and 0 symbols matched. Showing 0 of 40 files — …
//     No candidates. The code above says whether that is an answer or a failure.
//
//   formatRepomap, 5-file graph at budget 15 (entries 0, omitted 5,
//   partial true, all five paths named in omittedOptional):
//     Repomap is empty (no ranked files).
//
//   formatAffected, a result carrying `truncated: true`:
//     No dependents found for src/a.ts.
//
// Three renderers, one shape: an empty or cut PAGE spoken as a fact about the
// graph.
import { expect, test } from "bun:test";
import path from "node:path";
import { findCandidates } from "../../gdgraph/find";
import type { GraphData, GraphNode } from "../../gdgraph/types";
import { RETRIEVAL_CODES } from "../../lib/retrieval-codes";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import {
  FIND_PAGE_BOUNDARY,
  METAPROJECT_OPERATIONS,
  formatAffected,
  formatFind,
  formatRepomap,
} from "./metaproject-operations";

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");

/** Deterministic: never shells out to git, so `staleness` spawns nothing. */
const FROZEN_STALENESS = { checkGraphStaleness: async () => ({ status: "fresh" as const, reasons: [] }) };

function operation(name: string) {
  const found = METAPROJECT_OPERATIONS.find((op) => op.name === name);
  if (found === undefined) {
    throw new Error(`operation "${name}" is not registered`);
  }
  return found;
}

function fileNode(p: string): GraphNode {
  return { id: p, kind: "file", path: p, language: "typescript" };
}

/** 100 files; `refund` narrows the corpus and sits in exactly 40 of the paths. */
function corpusWith40Matches(): GraphData {
  return {
    nodes: [
      ...Array.from({ length: 40 }, (_, i) => fileNode(`src/payments/refund-${i}.ts`)),
      ...Array.from({ length: 60 }, (_, i) => fileNode(`src/other/thing-${i}.ts`)),
    ],
    edges: [],
  };
}

/** `core` is in 60 of 100 paths: ubiquitous (so no candidate discriminates) yet still scoring. */
function ubiquitousButScoringCorpus(): GraphData {
  return {
    nodes: [
      ...Array.from({ length: 60 }, (_, i) => fileNode(`src/core/mod-${i}.ts`)),
      ...Array.from({ length: 40 }, (_, i) => fileNode(`src/other/thing-${i}.ts`)),
    ],
    edges: [],
  };
}

/** Every path contains `alpha`, so every match scores zero and the page is always empty. */
function everythingScoresZeroCorpus(): GraphData {
  return { nodes: Array.from({ length: 14 }, (_, i) => fileNode(`alpha/mod-${i}.ts`)), edges: [] };
}

/** Drive the REAL `graph_find` descriptor through the REAL adapter over a fixture graph. */
async function findThroughBoundary(
  graph: GraphData,
  query: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const port = createMetaprojectAdapter(REPO_ROOT, {
    ...FROZEN_STALENESS,
    graphFind: async (_cwd, q, options) => findCandidates(graph, q, options ?? {}),
  });
  const result = await operation("graph_find").invoke(port, { query, ...input });
  return result.output;
}

/** Everything ABOVE the page boundary — the only part allowed to talk about the corpus. */
function aboveThePage(output: string): string {
  const parts = output.split(FIND_PAGE_BOUNDARY);
  if (parts.length !== 2) {
    throw new Error(`expected exactly one page boundary, found ${parts.length - 1}:\n${output}`);
  }
  return parts[0]!;
}

/**
 * Remove the ONE clause above the boundary that is allowed to vary with the
 * page: `displayNote`'s " Showing N of M …", which `find.ts` appends to
 * `reason` and which `find-display-truth.test.ts` already pins in its own
 * right. Everything else above the boundary must be page-independent — that is
 * the whole assertion.
 */
function stripLabelledPageClause(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split(" Showing ")[0]!)
    .join("\n");
}

// --- formatFind: the shape, not the instance ---------------------------------

test("graph_find — the text above the page boundary is byte-identical across every page size, for every code reachable here", async () => {
  // THE STRUCTURAL GUARD. `find-display-truth.test.ts` asserts this of the
  // payload's `reason`; this asserts it of the whole rendered prose. If a
  // future line above the boundary is ever built from `files`/`symbols` — the
  // way `insufficient-evidence`'s tail once was — the prefix stops matching
  // across page sizes and this fails, without anyone having to guess which
  // branch it is in.
  const cases: Array<[string, GraphData, string]> = [
    ["ok", corpusWith40Matches(), "refund"],
    ["insufficient-evidence", ubiquitousButScoringCorpus(), "core"],
    ["insufficient-evidence (nothing scores)", everythingScoresZeroCorpus(), "alpha"],
    ["no-match", corpusWith40Matches(), "kubernetes"],
  ];

  for (const [label, graph, query] of cases) {
    const baseline = stripLabelledPageClause(
      aboveThePage(await findThroughBoundary(graph, query, { fileLimit: 1000, symbolLimit: 1000 })),
    );
    for (const limit of [1, 2, 3, 5, 20, 40, 1000]) {
      const output = await findThroughBoundary(graph, query, {
        fileLimit: limit,
        symbolLimit: limit,
      });
      const claim = stripLabelledPageClause(aboveThePage(output));
      expect(`${label} @ ${limit}: ${claim}`).toBe(`${label} @ ${limit}: ${baseline}`);
    }
  }
});

test("graph_find — every count below the boundary is labelled as a page count", async () => {
  const output = await findThroughBoundary(corpusWith40Matches(), "refund", { fileLimit: 3 });
  const page = output.split(FIND_PAGE_BOUNDARY)[1] ?? "";
  expect(page).toContain("Files shown (3):");
  // The corpus count is stated once, above the boundary, from the scan.
  expect(aboveThePage(output)).toContain("40 files and 0 symbols matched");
  expect(aboveThePage(output)).toContain("Showing 3 of 40 files");
});

test("graph_find — an empty page never asserts that nothing matched", () => {
  // The defect verbatim. `fileLimit: 0` cannot travel through the descriptor
  // (its schema requires >= 1), so the renderer is called on the real
  // classifier's real output at that limit — the exact payload the fixed
  // `findCandidates` produces, and the exact prose that used to contradict it.
  const outcome = findCandidates(corpusWith40Matches(), "refund", { fileLimit: 0 });
  const rendered = formatFind({ query: "refund", ...outcome, nextActions: [...outcome.nextActions] });

  expect(outcome.code).toBe("ok");
  expect(outcome.files.length).toBe(0);
  expect(rendered.output).toContain("40 files and 0 symbols matched");
  // What it used to say, one line under a reason saying forty matched.
  expect(rendered.output).not.toContain("No candidates.");
  expect(rendered.output).toContain("Nothing is shown on this page");
});

test("graph_find — the same empty page under insufficient-evidence is a page statement too", () => {
  const outcome = findCandidates(everythingScoresZeroCorpus(), "alpha");
  const rendered = formatFind({ query: "alpha", ...outcome, nextActions: [...outcome.nextActions] });

  expect(outcome.code).toBe("insufficient-evidence");
  expect(outcome.files.length).toBe(0);
  expect(rendered.output).toContain("14 candidates matched");
  expect(rendered.output).not.toContain("No candidates.");
});

// --- formatRepomap: a budget is not a claim about the graph -------------------

test("repomap — an empty map that omitted entries for budget does not claim there are no ranked files", () => {
  const rendered = formatRepomap({
    budget: 15,
    files: [],
    tokens: 0,
    omitted: 5,
    omittedOptional: ["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"],
    partial: true,
  });

  // The defect: five files WERE ranked, and this said there were none — and
  // returned before the `omittedOptional` list the adapter carries could name
  // a single one of them.
  expect(rendered.output).not.toContain("Repomap is empty (no ranked files).");
  expect(rendered.output).toContain("5 ranked entries did not fit the 15-token budget");
  expect(rendered.output).toContain("src/f3.ts");
});

test("repomap — a genuinely empty map still says so", () => {
  // The guard that keeps the fix above from being a blanket deletion of the
  // sentence: nothing ranked, nothing omitted, so "no ranked files" is true.
  const rendered = formatRepomap({ budget: 4000, files: [], tokens: 0, omitted: 0 });
  expect(rendered.output).toBe("Repomap is empty (no ranked files).");
});

// --- formatAffected: a declared truncation marker that was dropped ------------

test("graph_affected — a truncated result never reads as a complete one", () => {
  const empty = formatAffected({ target: "src/a.ts", depth: 1, affected: [], truncated: true });
  expect(empty.output).not.toContain("No dependents found for src/a.ts.");
  expect(empty.output).toContain("capped by an output bound");

  const partial = formatAffected({
    target: "src/a.ts",
    depth: 1,
    affected: [{ id: "src/b.ts", path: "src/b.ts", hop: 1 }],
    truncated: true,
  });
  expect(partial.output).toContain("TRUNCATED");
  expect(partial.output).toContain("showing 1 dependent(s)");
});

test("graph_affected — an untruncated result is unchanged", () => {
  const empty = formatAffected({ target: "src/a.ts", depth: 1, affected: [] });
  expect(empty.output).toBe("No dependents found for src/a.ts.");

  const full = formatAffected({
    target: "src/a.ts",
    depth: 1,
    affected: [{ id: "src/b.ts", path: "src/b.ts", hop: 1 }],
  });
  expect(full.output).toContain("Blast radius of src/a.ts (depth 1, 1 dependent(s)):");
  expect(full.output).not.toContain("TRUNCATED");
});

// --- the boundary is present on every code, so the guard above cannot be voided

test("graph_find — the page boundary is emitted exactly once for every code in the vocabulary", () => {
  for (const code of RETRIEVAL_CODES) {
    const rendered = formatFind({
      query: "alpha",
      code,
      reason: "a reason",
      nextActions: [],
      files: [],
      symbols: [],
      queryTerms: ["alpha"],
      ubiquitousTerms: [],
    });
    expect(rendered.output.split(FIND_PAGE_BOUNDARY).length - 1).toBe(1);
  }
});
