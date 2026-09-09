import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isMeasuredRate } from "./benchmark";
import {
  checkOperatorMemory,
  collectGraphInventory,
  compareGraphInventories,
  summarizeWikiInventory,
  type WikiPageRecord,
} from "./inventory";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-inventory-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const PROBE = { nodePath: "src/alpha.ts" } as const;

/** A graph directory that a run may legitimately be measured against. */
async function writeGoodGraph(dir: string): Promise<void> {
  const storage = path.join(dir, "storage");
  await mkdir(storage, { recursive: true });
  await writeFile(
    path.join(storage, "nodes.jsonl"),
    [
      JSON.stringify({ id: "src/alpha.ts", kind: "file", path: "src/alpha.ts", language: "ts" }),
      JSON.stringify({ id: "src/beta.ts", kind: "file", path: "src/beta.ts", language: "ts" }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(storage, "edges.jsonl"),
    JSON.stringify({ from: "src/alpha.ts", to: "src/beta.ts", kind: "imports" }) + "\n",
    "utf8",
  );
  await writeFile(path.join(storage, "build-manifest.json"), JSON.stringify({ version: 1, files: [] }), "utf8");
  await writeFile(
    path.join(dir, ".provenance.json"),
    JSON.stringify({ commit: "c0ffee", branch: "main", builtAt: "2026-09-07T00:00:00.000Z" }),
    "utf8",
  );
}

describe("collectGraphInventory", () => {
  test("a fully built graph is ready and answers the control query", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);

    const inventory = collectGraphInventory(dir, PROBE);

    expect(inventory.status).toBe("ready");
    expect(inventory.problems).toEqual([]);
    expect(inventory.nodeCount).toBe(2);
    expect(inventory.edgeCount).toBe(1);
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.buildCommit).toBe("c0ffee");
    expect(inventory.builtAt).toBe("2026-09-07T00:00:00.000Z");
    expect(inventory.controlQuery).toEqual({ probe: "src/alpha.ts", found: true, shapeOk: true, problem: null });
  });

  // The norm names this case literally: "пустая директория `data/gdgraph` не проходит".
  test("a missing graph directory is empty, not ready", () => {
    const inventory = collectGraphInventory(path.join(root, "data", "gdgraph"), PROBE);
    expect(inventory.status).toBe("empty");
    expect(inventory.nodeCount).toBeNull();
  });

  test("an existing but empty graph directory is empty, not ready", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await mkdir(dir, { recursive: true });
    const inventory = collectGraphInventory(dir, PROBE);
    expect(inventory.status).toBe("empty");
  });

  test("a node store with no records is empty, not a graph of size zero", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    await writeFile(path.join(dir, "storage", "nodes.jsonl"), "\n  \n", "utf8");
    const inventory = collectGraphInventory(dir, PROBE);
    expect(inventory.status).toBe("empty");
  });

  test("unparseable node records make the graph corrupt", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    await writeFile(path.join(dir, "storage", "nodes.jsonl"), '{"id":"a","kind":"file","path":"a"}\n{not json\n', "utf8");
    const inventory = collectGraphInventory(dir, PROBE);
    expect(inventory.status).toBe("corrupt");
    expect(inventory.problems.join(" ")).toContain("line 2");
  });

  test("node records missing required fields make the graph corrupt", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    await writeFile(path.join(dir, "storage", "nodes.jsonl"), '{"id":"src/alpha.ts"}\n', "utf8");
    const inventory = collectGraphInventory(dir, PROBE);
    expect(inventory.status).toBe("corrupt");
    expect(inventory.problems.join(" ")).toContain("kind");
  });

  test("a missing edge store is a partial build, not a graph with no edges", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    await rm(path.join(dir, "storage", "edges.jsonl"));
    const inventory = collectGraphInventory(dir, PROBE);
    expect(inventory.status).toBe("corrupt");
    expect(inventory.edgeCount).toBeNull();
    expect(inventory.problems.join(" ")).toContain("partial");
  });

  test("a graph that cannot be dated is corrupt: build freshness is required", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    await rm(path.join(dir, ".provenance.json"));
    const inventory = collectGraphInventory(dir, PROBE);
    expect(inventory.status).toBe("corrupt");
    expect(inventory.buildCommit).toBeNull();
    expect(inventory.builtAt).toBeNull();
  });

  test("a populated graph that cannot answer the control query reports it", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    const inventory = collectGraphInventory(dir, { nodePath: "src/never-built.ts" });
    expect(inventory.status).toBe("ready");
    expect(inventory.controlQuery?.found).toBe(false);
    expect(inventory.controlQuery?.shapeOk).toBe(false);
  });

  test("a path that is not a directory is unreadable, never empty", async () => {
    const file = path.join(root, "gdgraph-file");
    await writeFile(file, "x", "utf8");
    expect(collectGraphInventory(file, PROBE).status).toBe("unreadable");
  });
});

describe("summarizeWikiInventory", () => {
  const page = (over: Partial<WikiPageRecord> & { id: string }): WikiPageRecord => ({
    pageClass: "substantive",
    accepted: true,
    sections: ["a", "b"],
    retrievableSections: ["a", "b"],
    ...over,
  });

  test("distinguishes the four page classes and counts accepted substantive pages only", () => {
    const inventory = summarizeWikiInventory([
      page({ id: "w1" }),
      page({ id: "w2", accepted: false }),
      page({ id: "w3", pageClass: "scaffold" }),
      page({ id: "w4", pageClass: "reference" }),
      page({ id: "w5", pageClass: "draft" }),
    ]);
    expect(inventory.byClass).toEqual({ substantive: 2, scaffold: 1, reference: 1, draft: 1 });
    expect(inventory.acceptedSubstantive).toBe(1);
  });

  test("section coverage is a measured rate when sections exist", () => {
    const inventory = summarizeWikiInventory([page({ id: "w1", sections: ["a", "b"], retrievableSections: ["a"] })]);
    expect(isMeasuredRate(inventory.sectionCoverage)).toBe(true);
    expect(inventory.sectionCoverage.rate).toBeCloseTo(0.5, 10);
  });

  // The INCOMPLETE-not-zero clause, at the type level.
  test("a wiki with no sections is unmeasurable, not 0% coverage", () => {
    const inventory = summarizeWikiInventory([]);
    expect(isMeasuredRate(inventory.sectionCoverage)).toBe(false);
    expect(inventory.sectionCoverage.rate).toBeNull();
    expect(inventory.sectionCoverage.ci95).toBeNull();
  });

  test("a page claiming retrievable sections it does not have is a problem, not coverage", () => {
    const inventory = summarizeWikiInventory([
      page({ id: "w1", sections: ["a"], retrievableSections: ["a", "ghost"] }),
    ]);
    expect(inventory.problems.join(" ")).toContain("ghost");
    expect(inventory.sectionCoverage.rate).toBe(1);
    expect(inventory.sectionCoverage.n).toBe(1);
  });
});

describe("checkOperatorMemory", () => {
  test("reports present when an operator note is reachable", async () => {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "notes.md"), "the answer is beta", "utf8");
    const report = checkOperatorMemory(root, [".metaproject/notes.md", ".claude/CLAUDE.md"]);
    expect(report.status).toBe("present");
    expect(report.paths).toEqual([".metaproject/notes.md"]);
  });

  test("reports absent when the candidates are genuinely not there", () => {
    expect(checkOperatorMemory(root, [".metaproject/notes.md"]).status).toBe("absent");
  });

  // A guard that cannot fail is not a guard: with nothing to look for, every root
  // would be "clean". That has to be unverified.
  test("with no candidate paths the check is unverified, never absent", () => {
    expect(checkOperatorMemory(root, []).status).toBe("unverified");
  });

  test("a root that does not exist is unverified, never absent", () => {
    expect(checkOperatorMemory(path.join(root, "gone"), [".metaproject/notes.md"]).status).toBe("unverified");
  });
});

describe("compareGraphInventories", () => {
  test("an identical before/after is stable", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    const before = collectGraphInventory(dir, PROBE);
    const after = collectGraphInventory(dir, PROBE);
    expect(compareGraphInventories(before, after)).toEqual({ stable: true, changes: [] });
  });

  test("a graph rebuilt mid-run is drift, not noise", async () => {
    const dir = path.join(root, "data", "gdgraph");
    await writeGoodGraph(dir);
    const before = collectGraphInventory(dir, PROBE);
    await writeFile(
      path.join(dir, ".provenance.json"),
      JSON.stringify({ commit: "deadbee", branch: "main", builtAt: "2026-09-07T02:00:00.000Z" }),
      "utf8",
    );
    const after = collectGraphInventory(dir, PROBE);
    const drift = compareGraphInventories(before, after);
    expect(drift.stable).toBe(false);
    expect(drift.changes.join(" ")).toContain("buildCommit");
  });
});
