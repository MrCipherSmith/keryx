// THE THIRD AND FOURTH INSTANCES OF ONE SHAPE (flow 235, T15)
//
// Twice a display filter in `gdgraph find` was caught answering a question
// about the corpus: first the ballast filter chose `no-match`, then the `limit`
// slice did. Both were closed by separating matching from ranking, so the
// CLASSIFIER reads the scan.
//
// The reasons were never moved. Reproduced here, against the code as it stood
// before this file existed, on a 100-file corpus holding 40 genuine matches:
//
//   code: ok
//   reason: "20 files and 0 symbols matched."          // 40 did
//
//   fileLimit: 0   -> "0 files and 0 symbols matched." // at code: ok
//   fileLimit: -1  -> "39 files and 0 symbols matched."
//
// and — the instance the hand-off's enumeration missed — the same shape inside
// `insufficient-evidence`, whose tail asked how long the PAGE was:
//
//   fileLimit: 0   -> "Every match scored zero, so no ranking is shown."
//                     while sixty matches scored ~5.04 each
//
// The invariant these tests pin, stated once: a reason may state what MATCHED
// only from the scan, and what is SHOWN only as an explicitly-labelled separate
// clause. A reader must be able to tell "40 matched, showing 20" from "20
// matched". No page size may ever be printed as a fact about the corpus.
import { expect, test } from "bun:test";
import { findCandidates } from "./find";
import type { GraphData, GraphNode } from "./types";

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

/**
 * 100 files; `core` is in 60 of them, so it is ubiquitous (>50%) — every match
 * is non-discriminating — yet NOT universal, so `termWeight` is positive and
 * every match still scores. That combination is the only way to reach
 * `insufficient-evidence` with a non-empty ranking, and it is what the page-
 * derived tail got wrong.
 */
function ubiquitousButScoringCorpus(): GraphData {
  return {
    nodes: [
      ...Array.from({ length: 60 }, (_, i) => fileNode(`src/core/mod-${i}.ts`)),
      ...Array.from({ length: 40 }, (_, i) => fileNode(`src/other/thing-${i}.ts`)),
    ],
    edges: [],
  };
}

test("the ok reason counts what MATCHED, not what fitted on the page", () => {
  const graph = corpusWith40Matches();

  // The premise, asserted rather than assumed: the corpus really does hold 40
  // matches and the default page really does cut them.
  const all = findCandidates(graph, "refund", { fileLimit: 1000 });
  expect(all.code).toBe("ok");
  expect(all.files.length).toBe(40);

  const paged = findCandidates(graph, "refund");
  expect(paged.code).toBe("ok");
  expect(paged.files.length).toBe(20);

  // The defect, exactly: the reason said twenty.
  expect(paged.reason).not.toContain("20 files and 0 symbols matched");
  expect(paged.reason).toContain("40 files and 0 symbols matched");
  // And the truncation is stated, not left for the reader to infer from a
  // count they have no other way to check.
  expect(paged.reason).toContain("Showing 20 of 40 files");
});

test("a nonsensical page size cannot make the reason understate the corpus", () => {
  const graph = corpusWith40Matches();

  // `slice(0, 0)` and `slice(0, -1)`. Both used to be printed as the number of
  // things that matched, at `code: ok`.
  for (const fileLimit of [0, -1, 1]) {
    const out = findCandidates(graph, "refund", { fileLimit });
    expect(out.code).toBe("ok");
    expect(out.reason).toContain("40 files and 0 symbols matched");
    expect(out.reason).toContain(`Showing ${out.files.length} of 40 files`);
  }

  // Stated structurally as well as by example: across every page size, the
  // count the reason asserts about the corpus never moves.
  const claims = new Set(
    [0, -1, 1, 5, 20, 40, 1000].map(
      (fileLimit) =>
        findCandidates(graph, "refund", { fileLimit }).reason.match(
          /^(\d+) files and (\d+) symbols matched/,
        )?.[0] ?? "unparsed",
    ),
  );
  expect([...claims]).toEqual(["40 files and 0 symbols matched"]);
});

test("no display note is added when the page shows everything that matched", () => {
  const graph = corpusWith40Matches();
  const whole = findCandidates(graph, "refund", { fileLimit: 40 });
  expect(whole.files.length).toBe(40);
  expect(whole.reason).toBe("40 files and 0 symbols matched.");
});

test("insufficient-evidence cannot claim every match scored zero when they scored", () => {
  const graph = ubiquitousButScoringCorpus();

  // Premise: this really is the insufficient-evidence branch, and the matches
  // really do score.
  const full = findCandidates(graph, "core", { fileLimit: 1000 });
  expect(full.code).toBe("insufficient-evidence");
  expect(full.files.length).toBe(60);
  expect(full.files.every((file) => file.score > 0)).toBe(true);
  expect(full.files.every((file) => file.discriminating.length === 0)).toBe(true);

  // The defect: an empty PAGE was read as "nothing scored".
  const starved = findCandidates(graph, "core", { fileLimit: 0 });
  expect(starved.code).toBe("insufficient-evidence");
  expect(starved.files.length).toBe(0);
  expect(starved.reason).not.toContain("Every match scored zero");
  expect(starved.reason).toContain("60 candidates matched");
  expect(starved.reason).toContain("Showing 0 of 60 files");
});

test("insufficient-evidence still says every match scored zero when every match did", () => {
  // The genuine version of that sentence: `alpha` is in ALL 14 paths, so its
  // weight is log(15/15) = 0 and the whole scan scores zero. This is the guard
  // that keeps the fix above from being a blanket deletion of the sentence.
  const graph: GraphData = {
    nodes: Array.from({ length: 14 }, (_, i) => fileNode(`alpha/mod-${i}.ts`)),
    edges: [],
  };
  const out = findCandidates(graph, "alpha");
  expect(out.code).toBe("insufficient-evidence");
  expect(out.files.length).toBe(0);
  expect(out.files.every((file) => file.score === 0)).toBe(true);
  expect(out.reason).toContain("Every match scored zero");
  // And the note still carries the fact the very first instance of this defect
  // denied outright: fourteen files DO contain `alpha`, you are just being
  // shown none of them.
  expect(out.reason).toContain("Showing 0 of 14 files");
});

test("the reason's corpus counts are stable under any page size, for every code", () => {
  // The shape, not the instance. If a fifth reason is ever built from
  // `foundFiles`/`foundSymbols`, this fails without anyone having to notice
  // which branch it was.
  const graphs: Array<[string, GraphData, string]> = [
    ["ok", corpusWith40Matches(), "refund"],
    ["insufficient-evidence", ubiquitousButScoringCorpus(), "core"],
    [
      "no-match",
      corpusWith40Matches(),
      "kubernetes",
    ],
  ];

  for (const [label, graph, query] of graphs) {
    const baseline = findCandidates(graph, query, { fileLimit: 1000, symbolLimit: 1000 });
    const stripNote = (reason: string): string => reason.split(" Showing ")[0] ?? reason;
    for (const limit of [0, -1, 1, 3, 20]) {
      const out = findCandidates(graph, query, { fileLimit: limit, symbolLimit: limit });
      expect(out.code).toBe(baseline.code);
      // Everything except the labelled page clause is identical: the page
      // cannot reach the part of the sentence that talks about the corpus.
      expect(stripNote(out.reason)).toBe(stripNote(baseline.reason));
      expect(label).toBe(baseline.code);
    }
  }
});
