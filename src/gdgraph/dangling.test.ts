import { describe, expect, test } from "bun:test";
import { classifyDanglingScope, explainOrphans, getDanglingEdges, namesDeletedFile } from "./dangling";
import { getAffected, getOrphans } from "./query";
import { computeAffected } from "./affected";
import type { GraphData } from "./types";

// The graph exactly as `keryx gdgraph build` produced it on a scratch project
// after `src/billing.ts` was deleted: `src/orders.ts` still imports `./billing`,
// the edge is `unresolved`, and the target node is gone.
//
//   {"id":"edge:1","from":"src/orders.ts","to":"./billing","kind":"unresolved",
//    "specifier":"./billing","importKind":"import-statement"}
const AFTER_DELETION: GraphData = {
  nodes: [{ id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" }],
  edges: [
    {
      id: "edge:1",
      from: "src/orders.ts",
      to: "./billing",
      kind: "unresolved",
      specifier: "./billing",
      importKind: "import-statement",
    },
  ],
};

describe("the graph's answer to a reference into deleted code (flow 242 lane E, AC1)", () => {
  test("the three existing answers drop the reference — this is the defect, pinned", () => {
    // Not an aspiration: this is what `keryx gdgraph affected src/orders.ts` and
    // `keryx gdgraph query orphans` printed on the scratch project, and it is
    // pinned here so a later change to `dangling.ts` cannot quietly be sold as
    // having fixed these three.
    expect(getAffected(AFTER_DELETION, "src/orders.ts").dependencies).toEqual([]);
    expect(computeAffected(AFTER_DELETION, "src/orders.ts").dependencies).toEqual([]);
    expect(getOrphans(AFTER_DELETION)).toEqual(["src/orders.ts"]);
  });

  test("the reference is reported, with the file that holds it and the specifier", () => {
    const dangling = getDanglingEdges(AFTER_DELETION);
    expect(dangling).toEqual([
      { from: "src/orders.ts", specifier: "./billing", scope: "in-project", importKind: "import-statement" },
    ]);
  });

  test("an orphan reported because its dependency was deleted is distinguished from an isolated one", () => {
    const explained = explainOrphans(AFTER_DELETION);
    expect(explained).toHaveLength(1);
    expect(explained[0]?.cause).toBe("dangling-only");

    // Control: a file with no edges at all is `isolated`, so the classification
    // is a real distinction and not a label applied to every orphan.
    const isolated: GraphData = {
      nodes: [{ id: "src/alone.ts", kind: "file", path: "src/alone.ts", language: "typescript" }],
      edges: [],
    };
    expect(explainOrphans(isolated)).toEqual([{ path: "src/alone.ts", cause: "isolated" }]);
  });

  test("explainOrphans classifies getOrphans' set and never changes it", () => {
    // If this ever fails, `explainOrphans` has started deciding what an orphan
    // is instead of explaining what `getOrphans` already decided, and two
    // surfaces will report different orphan counts for one graph.
    const graph: GraphData = {
      nodes: [
        { id: "a", kind: "file", path: "src/a.ts", language: "typescript" },
        { id: "b", kind: "file", path: "src/b.ts", language: "typescript" },
        { id: "c", kind: "file", path: "src/c.ts", language: "typescript" },
        { id: "d", kind: "file", path: "src/d.ts", language: "typescript" },
      ],
      edges: [
        { id: "e1", from: "src/a.ts", to: "src/b.ts", kind: "imports", specifier: "./b" },
        { id: "e2", from: "src/c.ts", to: "./gone", kind: "unresolved", specifier: "./gone" },
      ],
    };
    expect(explainOrphans(graph).map((entry) => entry.path)).toEqual(getOrphans(graph));
  });
});

describe("scope: only a relative specifier can dangle in this project (flow 242 lane E)", () => {
  test("package names and language builtins are external, not dangling references", () => {
    // Taken verbatim from this repository's own `edges.jsonl`, where 60 of the
    // unresolved edges look like this. Classifying them `in-project` would bury
    // the two that matter under sixty that do not — a report nobody reads is a
    // report that does not exist.
    for (const specifier of ["collections", "datetime", "os", "node:path", "bun:test", "react"]) {
      expect(classifyDanglingScope(specifier)).toBe("external");
    }
    for (const specifier of ["./billing", "../wiki/collect", "../../lib/fs"]) {
      expect(classifyDanglingScope(specifier)).toBe("in-project");
    }
  });

  test("filtering to in-project drops the external noise and keeps the real one", () => {
    const mixed: GraphData = {
      nodes: [{ id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" }],
      edges: [
        { id: "e1", from: "src/orders.ts", to: "./billing", kind: "unresolved", specifier: "./billing" },
        { id: "e2", from: "src/orders.ts", to: "zod", kind: "unresolved", specifier: "zod" },
        { id: "e3", from: "src/orders.ts", to: "node:fs", kind: "unresolved", specifier: "node:fs" },
      ],
    };
    expect(getDanglingEdges(mixed, { scope: "in-project" }).map((edge) => edge.specifier)).toEqual([
      "./billing",
    ]);
    expect(getDanglingEdges(mixed).map((edge) => edge.specifier)).toEqual(["./billing", "node:fs", "zod"]);
  });
});

describe("attribution: which unresolved imports name a deleted file (flow 242 lane E, AC1)", () => {
  const deleted = new Set(["src/billing.ts", "src/pricing/index.ts", "src/legacy"]);

  test("an import that names a deleted file matches", () => {
    expect(namesDeletedFile({ from: "src/orders.ts", specifier: "./billing" }, deleted)).toBe(true);
    // …through an extension, an index file, and an exact path.
    expect(namesDeletedFile({ from: "src/orders.ts", specifier: "./pricing" }, deleted)).toBe(true);
    expect(namesDeletedFile({ from: "src/a/b.ts", specifier: "../legacy" }, deleted)).toBe(true);
  });

  test("an import that names nothing deleted does NOT match — the discriminating case", () => {
    // Without this, `namesDeletedFile` could return `true` unconditionally and
    // every unresolved import in the repository — 51 of them here, nearly all
    // import statements inside test fixture strings — would be reported as a
    // reference into removed knowledge. That is a fabrication at scale, and it
    // is the mutation this test exists to kill.
    expect(namesDeletedFile({ from: "src/orders.ts", specifier: "./shipping" }, deleted)).toBe(false);
    expect(namesDeletedFile({ from: "src/gdgraph/build.test.ts", specifier: "./dep" }, deleted)).toBe(false);
    // A same-named file in a different directory is a different file.
    expect(namesDeletedFile({ from: "other/orders.ts", specifier: "./billing" }, deleted)).toBe(false);
    // And an empty deletion window attributes nothing at all.
    expect(namesDeletedFile({ from: "src/orders.ts", specifier: "./billing" }, new Set())).toBe(false);
  });

  test("a specifier that escapes the project root matches nothing rather than throwing", () => {
    expect(namesDeletedFile({ from: "a.ts", specifier: "../../outside" }, deleted)).toBe(false);
  });
});
