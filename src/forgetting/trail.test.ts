// Flow 242 T9/F3 + F9 — the deletion trail's read side.
//
// Every test below was written by first making the assertion pass, then
// REVERTING the line of `./trail.ts` it is meant to protect and confirming it
// goes red. The revert is named in each comment, because a guard whose failure
// mode nobody has seen is a guard nobody knows can fail.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDeletionRecord, deletionJournalPath, type DeletionRecord } from "./journal";
import {
  TRAIL_SCOPE_CAVEAT,
  describeAttribution,
  describeRemovalLookup,
  explainAbsentGraphTarget,
  explainAbsentWikiPage,
  loadDeletionTrail,
  lookupRemoval,
  searchRemovals,
  trailCoverage,
} from "./trail";
import type { GraphData } from "../gdgraph/types";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-forget-trail-"));
}

const WIKI_REMOVAL: Omit<DeletionRecord, "v"> = {
  at: "2026-09-08T12:00:00.000Z",
  observedBy: "keryx sync --apply",
  outcome: "propagated",
  removed: [
    {
      layer: "wiki-identity",
      ref: "keryx:page/billing",
      page: "architecture/billing.md",
      title: "Billing charges once",
    },
  ],
  // Journal v2 (T7): `removed` is what the RECORDING RUN removed, and this
  // field carries what it saw removed and could not record. Empty here.
  observedUnrecorded: [],
  untouched: [
    { layer: "memory", cause: "authored memory entries are never deleted by a wiki removal" },
    { layer: "graph", cause: "the code graph is rebuilt from the tree, not from this reconcile" },
  ],
  requestedBy: { value: "someone@example.invalid", basis: "derived", detail: "git config user.email in this checkout" },
  grounds: { value: "the page is no longer present", basis: "derived", detail: "generated from what was observed on disk" },
  danglingAfter: 0,
  refusals: [],
};

describe("the three disk states are three answers, never one", () => {
  test("an absent trail is `trail-absent`, not `no-removal-recorded`", async () => {
    const root = await scratch();
    try {
      const trail = await loadDeletionTrail(root);
      expect(trail.state).toBe("absent");
      const lookup = lookupRemoval(trail, { candidates: ["keryx:page/billing"] });
      // REVERT CHECK: folding the absent branch of `nonMatchLookup` into the
      // `no-removal-recorded` return — the obvious simplification, since both
      // mean "not found" — makes this red. "Nothing has ever been recorded here"
      // and "records exist and none names this" are different facts.
      expect(lookup.verdict).toBe("trail-absent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unparseable trail is `trail-unreadable` — never an empty history", async () => {
    const root = await scratch();
    try {
      const file = deletionJournalPath(root);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{"at":"2026-01-01T00:00:00.000Z","observedBy":"x"}\nnot json at all\n', "utf8");

      const trail = await loadDeletionTrail(root);
      expect(trail.state).toBe("unreadable");
      // The readable remainder must NOT be reported as the whole history.
      expect(trail.records).toEqual([]);

      const lookup = lookupRemoval(trail, { candidates: ["anything"] });
      // REVERT CHECK: dropping the `state === "unreadable"` branch from
      // `nonMatchLookup` makes this `no-removal-recorded` and turns a read
      // failure into a confident negative answer — the precise defect this
      // module exists to remove.
      expect(lookup.verdict).toBe("trail-unreadable");
      expect(lookup.reason).toContain("cannot be told apart");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a present trail that names nothing is `no-removal-recorded`", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const trail = await loadDeletionTrail(root);
      expect(trail.state).toBe("present");
      expect(lookupRemoval(trail, { candidates: ["keryx:page/never-written"] }).verdict).toBe(
        "no-removal-recorded",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('"no record" is never rendered as "never existed"', () => {
  test("every negative verdict carries the scope caveat verbatim", async () => {
    const root = await scratch();
    try {
      const absent = lookupRemoval(await loadDeletionTrail(root), { candidates: ["x"] });
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const present = lookupRemoval(await loadDeletionTrail(root), { candidates: ["x"] });

      // REVERT CHECK: removing `${TRAIL_SCOPE_CAVEAT}` from either return in
      // `nonMatchLookup` makes this red. Without it a surface that renders only
      // `reason` prints a bare negative and the reader supplies "never existed"
      // themselves, which is exactly what every surface did before this module.
      for (const lookup of [absent, present]) {
        expect(lookup.verdict === "trail-absent" || lookup.verdict === "no-removal-recorded").toBe(true);
        if (lookup.verdict === "trail-absent" || lookup.verdict === "no-removal-recorded") {
          expect(lookup.reason).toContain(TRAIL_SCOPE_CAVEAT);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no verdict in the union can ever be `never-existed`", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const trail = await loadDeletionTrail(root);
      const verdicts = [
        lookupRemoval(trail, { candidates: ["keryx:page/billing"] }).verdict,
        lookupRemoval(trail, { candidates: ["nothing-like-this"] }).verdict,
        searchRemovals(trail, "quantum flux capacitor").verdict,
      ];
      // A structural assertion, not a spelling one: the moment someone adds a
      // `never-existed` member to satisfy a caller that wants a confident
      // answer, this fails and the argument happens here rather than silently.
      expect(verdicts.some((verdict) => String(verdict).includes("never"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a negative answer states which layers this trail has never recorded", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const trail = await loadDeletionTrail(root);
      const lookup = lookupRemoval(trail, { candidates: ["decisions/charge-once.md"], layer: "memory" });
      expect(lookup.verdict).toBe("no-removal-recorded");
      if (lookup.verdict !== "no-removal-recorded") return;

      // REVERT CHECK: dropping the layer branch of `describeCoverageAgainst`
      // (returning `scope` for every layer) makes these red. Without them the
      // reader is told "the trail names no removal of this" and has no way to
      // learn that the trail has never recorded ANY removal for that layer —
      // which is the difference between a meaningful silence and an empty one.
      expect(lookup.reason).toContain("has ever named the `memory` layer as removed");
      expect(lookup.reason).toContain("UNTOUCHED");
      expect(lookup.reason).toContain("cannot tell a removal from something that never existed");
      expect(lookup.coverage.layersWithRemovals).toEqual(["wiki-identity"]);
      expect(lookup.coverage.layersRecordedUntouched).toEqual(["graph", "memory"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("coverage is measured from the file, so a layer gaining records strengthens the answer", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const before = lookupRemoval(await loadDeletionTrail(root), {
        candidates: ["some/other/entry.md"],
        layer: "memory",
      });
      expect(before.verdict === "no-removal-recorded" && before.reason).toContain(
        "has ever named the `memory` layer as removed",
      );

      await appendDeletionRecord(root, {
        ...WIKI_REMOVAL,
        at: "2026-09-09T12:00:00.000Z",
        removed: [{ layer: "memory", ref: "decisions/charge-once.md", page: null, title: "Charge once" }],
      });
      const after = lookupRemoval(await loadDeletionTrail(root), {
        candidates: ["some/other/entry.md"],
        layer: "memory",
      });
      // Derived, not hardcoded: the same query now reports the trail DOES record
      // this layer, with no edit to trail.ts. Hardcoding the layer list — the
      // shortcut — makes this red.
      expect(after.verdict === "no-removal-recorded" && after.reason).toContain(
        "This trail HAS recorded removals in the `memory` layer",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a recorded removal answers with when, at whose request, and on what basis", () => {
  test("`recorded-removed` carries the four facts AC6 records", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const lookup = lookupRemoval(await loadDeletionTrail(root), {
        candidates: ["keryx:page/billing"],
      });
      expect(lookup.verdict).toBe("recorded-removed");
      if (lookup.verdict !== "recorded-removed") return;

      const [first] = lookup.occurrences;
      expect(first?.at).toBe("2026-09-08T12:00:00.000Z");
      expect(first?.observedBy).toBe("keryx sync --apply");
      expect(first?.layer).toBe("wiki-identity");
      expect(first?.matchedOn).toBe("ref");
      expect(lookup.reason).toContain('This is not "never existed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a DERIVED requester is never rendered as a stated one", () => {
    const line = describeAttribution("requested by", {
      value: "someone@example.invalid",
      basis: "derived",
      detail: "git config user.email in this checkout",
    });
    // REVERT CHECK: simplifying `describeAttribution` to
    // `${label}: ${attribution.value}` — which reads fine and loses nothing
    // visible — makes this red. It is the same fabrication `journal.ts` refuses
    // to commit at the write end: "who ran the command" printed where "who asked
    // for it" belongs.
    expect(line).toContain("[derived]");
    expect(describeAttribution("grounds", { value: null, basis: "unknown", detail: "none given" })).toContain(
      "unknown",
    );
  });

  test("an exact lookup does NOT substitute a near miss", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const trail = await loadDeletionTrail(root);
      // REVERT CHECK: changing `wanted.has(...)` to a substring/`includes`
      // match in `lookupRemoval` makes this red. `resolveSectionIdentity`'s rule
      // applies here for the same reason: an answer about something adjacent is
      // worse than no answer, because the caller cannot tell which they got.
      expect(lookupRemoval(trail, { candidates: ["keryx:page/bill"] }).verdict).toBe("no-removal-recorded");
      expect(lookupRemoval(trail, { candidates: ["keryx:page/billing-v2"] }).verdict).toBe(
        "no-removal-recorded",
      );
      // …and the phrase surface, which IS fuzzy, is a separate call that says so.
      expect(searchRemovals(trail, "charge once").verdict).toBe("recorded-removed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a phrase hit reports its layer, so a wiki identity never reads as a memory entry", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const lookup = searchRemovals(await loadDeletionTrail(root), "charge once");
      expect(lookup.verdict).toBe("recorded-removed");
      if (lookup.verdict !== "recorded-removed") return;
      expect(lookup.occurrences[0]?.layer).toBe("wiki-identity");
      expect(lookup.occurrences[0]?.matchedOn).toBe("title");
      expect(describeRemovalLookup(lookup).join("\n")).toContain("[wiki-identity]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a one- or two-letter query does not match every record by accident", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      const trail = await loadDeletionTrail(root);
      // REVERT CHECK: dropping the `term.length > 2` filter in `searchRemovals`
      // makes this red — "a" appears in almost every ref, so every query would
      // report every removal as a match and the surface would be noise.
      expect(searchRemovals(trail, "a").verdict).toBe("no-removal-recorded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("trailCoverage", () => {
  test("counts records, removals and the window they cover", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, WIKI_REMOVAL);
      await appendDeletionRecord(root, { ...WIKI_REMOVAL, at: "2026-09-09T12:00:00.000Z" });
      const coverage = trailCoverage(await loadDeletionTrail(root));
      expect(coverage.records).toBe(2);
      expect(coverage.removalsRecorded).toBe(2);
      expect(coverage.earliest).toBe("2026-09-08T12:00:00.000Z");
      expect(coverage.latest).toBe("2026-09-09T12:00:00.000Z");
      expect(coverage.observedBy).toEqual(["keryx sync --apply"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("explainAbsentWikiPage — the evidence `check-links` was not reading", () => {
  async function withRegistry(root: string, body: unknown): Promise<void> {
    await mkdir(path.join(root, ".metaproject", "wiki"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki", ".sections.json"),
      typeof body === "string" ? body : JSON.stringify(body),
      "utf8",
    );
  }

  const TOMBSTONED = {
    version: 2,
    entries: [],
    tombstones: [
      {
        kind: "page",
        ref: "keryx:page/billing",
        page: "architecture/billing.md",
        title: "Billing",
        digest: null,
        registeredAt: "2026-01-01T00:00:00.000Z",
        removedAt: "2026-09-08T12:00:00.000Z",
        reason: "the page is no longer present in the wiki",
      },
    ],
    lifted: [],
  };

  test("a tombstoned page and one that never existed are two answers", async () => {
    const root = await scratch();
    try {
      await withRegistry(root, TOMBSTONED);
      const removed = await explainAbsentWikiPage(root, "architecture/billing.md");
      const never = await explainAbsentWikiPage(root, "architecture/never-written.md");
      expect(removed.verdict).toBe("tombstoned");
      expect(removed.reason).toContain("2026-09-08T12:00:00.000Z");
      expect(removed.reason).toContain("no redirect");
      // The paired case: before this the two produced the same "(target not
      // found)" and nothing else.
      expect(never.verdict).toBe("trail-absent");
      expect(never.reason).toContain(TRAIL_SCOPE_CAVEAT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a registered page with no tombstone yet is `pending-tombstone`, not silence", async () => {
    const root = await scratch();
    try {
      await withRegistry(root, {
        version: 2,
        entries: [
          {
            kind: "page",
            ref: "keryx:page/billing",
            page: "architecture/billing.md",
            title: "Billing",
            digest: null,
            registeredAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        tombstones: [],
        lifted: [],
      });
      const answer = await explainAbsentWikiPage(root, "architecture/billing.md");
      expect(answer.verdict).toBe("pending-tombstone");
      expect(answer.reason).toContain('This is not "never existed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreadable registry REFUSES to answer rather than guessing", async () => {
    const root = await scratch();
    try {
      await withRegistry(root, "{ this is not json");
      const answer = await explainAbsentWikiPage(root, "architecture/billing.md");
      // REVERT CHECK: dropping the `state === "unreadable"` branch of
      // `explainAbsentWikiPage` makes this `trail-absent` — a confident "no
      // record" produced while the removal history could not be read at all.
      expect(answer.verdict).toBe("registry-unreadable");
      expect(answer.reason).toContain("cannot be separated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('explainAbsentGraphTarget — "deleted" and "never existed" for a code path', () => {
  const graph: GraphData = {
    nodes: [
      { id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" },
      // Root-level, deliberately: `namesDeletedFile` joins the importer's
      // DIRECTORY with the specifier, so from `src/orders.ts` a bare `lodash`
      // becomes `src/lodash` and misses a `lodash` query for an unrelated
      // reason. The first version of the scope test used only that importer and
      // stayed green with the scope filter deleted — a guard that could not
      // fail. From a root-level importer the join is `lodash` exactly, so the
      // scope filter is the only thing keeping the package out.
      { id: "index.ts", kind: "file", path: "index.ts", language: "typescript" },
    ],
    edges: [
      { from: "index.ts", to: "lodash", kind: "unresolved", specifier: "lodash" },
      // `src/orders.ts` still imports `./billing`; `src/billing.ts` is gone, so
      // the build recorded the edge as unresolved.
      { from: "src/orders.ts", to: "./billing", kind: "unresolved", specifier: "./billing" },
      // A bare package specifier: unresolved, and NOT a statement about this repo.
      { from: "src/orders.ts", to: "lodash", kind: "unresolved", specifier: "lodash" },
    ],
  } as unknown as GraphData;

  test("a path something still imports is `referenced-but-unindexed`, not silence", async () => {
    const root = await scratch();
    try {
      const answer = explainAbsentGraphTarget(graph, "src/billing.ts", await loadDeletionTrail(root));
      // REVERT CHECK: deleting the `referencedBy.length > 0` branch of
      // `explainAbsentGraphTarget` collapses this back to the trail's verdict,
      // and `src/billing.ts` becomes byte-identical to `src/nonexistent.ts`
      // again — the blocker verbatim.
      expect(answer.verdict).toBe("referenced-but-unindexed");
      expect(answer.referencedBy).toEqual([{ from: "src/orders.ts", specifier: "./billing" }]);
      // Evidence, labelled as evidence. It must not be sold as proof.
      expect(answer.reason).toContain("not proof of a removal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a path nothing imports keeps the honest negative", async () => {
    const root = await scratch();
    try {
      const answer = explainAbsentGraphTarget(graph, "src/nonexistent.ts", await loadDeletionTrail(root));
      expect(answer.verdict).toBe("trail-absent");
      expect(answer.referencedBy).toEqual([]);
      expect(answer.reason).toContain(TRAIL_SCOPE_CAVEAT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a recorded removal outranks circumstantial evidence", async () => {
    const root = await scratch();
    try {
      await appendDeletionRecord(root, {
        ...WIKI_REMOVAL,
        removed: [{ layer: "graph", ref: "src/billing.ts", page: null, title: null }],
      });
      const answer = explainAbsentGraphTarget(graph, "src/billing.ts", await loadDeletionTrail(root));
      expect(answer.verdict).toBe("recorded-removed");
      // The weaker evidence is still carried, not discarded.
      expect(answer.referencedBy.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unresolved PACKAGE specifier is not evidence about this repository", async () => {
    const root = await scratch();
    try {
      const answer = explainAbsentGraphTarget(graph, "lodash", await loadDeletionTrail(root));
      // REVERT CHECK: dropping `{ scope: "in-project" }` from the
      // `getDanglingEdges` call makes this red — every unresolved npm import in
      // the tree would become "evidence" that a file was deleted.
      expect(answer.referencedBy).toEqual([]);
      expect(answer.verdict).toBe("trail-absent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
