import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordChunk } from "../review/chunks";
import { formatReviewDepthLines, layersDepthLines, layersLine, loadReviewDepth, renderReviewDepthText, renderReviewLayersText, REVIEW_DEPTH_EMPTY, type ReviewDepthRow } from "./review-panel";
import { presentReviews, renderReviewsText } from "./reviews-inspector";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-depth-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  }
  return root;
}

const PKG = ".metaproject/reviews/pr-7";
const manifest = { reviewId: "pr-7", createdAt: "2026-10-12T10:00:00Z", target: { kind: "pr", ref: "acme/app#7" } };

describe("loadReviewDepth", () => {
  test("a package without a dispatch record reads as unrecorded, not as an empty set", async () => {
    const root = await project({ [`${PKG}/manifest.json`]: manifest });
    const [row] = await loadReviewDepth(root);
    expect(row?.pull).toBe("acme/app#7");
    expect(row?.mode).toBe("unrecorded");
    expect(row?.required).toEqual([]);
    expect(formatReviewDepthLines(row ? [row] : []).join("\n")).toContain("no dispatch record");
  });

  test("states the mode, names the missing reviewers and the excluded one with its reason", async () => {
    const root = await project({
      [`${PKG}/manifest.json`]: manifest,
      [`${PKG}/research.json`]: { dispatch: { version: 1, mode: "all", selected: ["review-logic"] } },
    });
    const [row] = await loadReviewDepth(root);
    expect(row?.mode).toBe("all");
    expect(row?.selected).toEqual(["review-logic"]);
    expect(row?.required.length).toBeGreaterThan(1);
    expect(row?.missing).not.toContain("review-logic");
    expect(row?.excluded.find((e) => e.reviewer === "review-regression")?.reason).toContain("no blast radius");
    const text = formatReviewDepthLines(row ? [row] : []).join("\n");
    expect(text).toContain("mode all");
    expect(text).toContain(`1 of ${row?.required.length} required were dispatched`);
    expect(text).toContain("excluded review-regression: no blast radius");
    expect(text).toContain("missing: ");
  });

  test("a blast-radius record turns the regression reviewer from excluded to required", async () => {
    const root = await project({
      [`${PKG}/manifest.json`]: manifest,
      [`${PKG}/research.json`]: { dispatch: { version: 1, mode: "all", selected: [] } },
      [`${PKG}/blast-radius.json`]: { files: [], changedFiles: [] },
    });
    const [row] = await loadReviewDepth(root);
    expect(row?.required).toContain("review-regression");
    expect(row?.excluded.some((e) => e.reviewer === "review-regression")).toBe(false);
  });

  test("sums recorded mutation passes and counts the proposed mutants still pending", async () => {
    const record = (killed: number, survived: number) => ({
      schemaVersion: 1,
      worktree: "w",
      command: "bun test",
      baseline: { exitCode: 0, ms: 1 },
      mutants: [{ id: "m1", file: "a.ts", anchor: "a", replacement: "b", status: "killed", ms: 1 }],
      totals: { killed, survived, invalid: 0, timeout: 0 },
    });
    const root = await project({
      [`${PKG}/manifest.json`]: manifest,
      [`${PKG}/research.json`]: { dispatch: { version: 1, mode: "all", selected: [] } },
      [`${PKG}/research-evidence/mutation-1.json`]: record(2, 1),
      [`${PKG}/research-evidence/mutation-2.json`]: record(1, 0),
      [`${PKG}/research-evidence/mutants.json`]: {
        mutants: [
          { id: "m1", file: "a.ts", anchor: "a", replacement: "b" },
          { id: "m2", file: "a.ts", anchor: "c", replacement: "d" },
        ],
      },
    });
    const [row] = await loadReviewDepth(root);
    expect(row?.mutation).toEqual({ passes: 2, totals: { killed: 3, survived: 1, invalid: 0, timeout: 0 }, pending: 1 });
    expect(formatReviewDepthLines(row ? [row] : []).join("\n")).toContain("mutation: 3 killed, 1 survived, 0 invalid, 0 timed out, 1 pending");
  });

  test("a package with proposed mutants and no pass says the pass was not run; a recorded waiver is shown", async () => {
    const root = await project({
      [`${PKG}/manifest.json`]: manifest,
      [`${PKG}/research.json`]: { dispatch: { version: 1, mode: "all", selected: [], mutationWaiver: { operatorQuote: "skip it", reason: "no test runner" } } },
      [`${PKG}/research-evidence/mutants.json`]: { mutants: [{ id: "m1", file: "a.ts", anchor: "a", replacement: "b" }] },
    });
    const [row] = await loadReviewDepth(root);
    expect(row?.mutationWaived).toBe(true);
    expect(formatReviewDepthLines(row ? [row] : []).join("\n")).toContain("mutation: not run, 1 proposed mutant(s) pending (waived by the operator)");
  });
});

describe("surfaces share one projection", () => {
  const rows: ReviewDepthRow[] = [
    {
      reviewId: "pr-7",
      pull: "acme/app#7",
      mode: "all",
      selected: ["review-logic"],
      required: ["review-logic", "review-style"],
      excluded: [{ reviewer: "review-regression", reason: "no blast radius computed for the package: there is no scope B to review" }],
      missing: ["review-style"],
      filesKnown: true,
      mutation: { passes: 1, totals: { killed: 1, survived: 1, invalid: 0, timeout: 0 }, pending: 0 },
      mutationWaived: false,
    },
  ];

  test("an empty list says so", () => {
    expect(formatReviewDepthLines([])).toEqual([REVIEW_DEPTH_EMPTY]);
  });

  test("the readline text carries the same lines as the panel", () => {
    expect(renderReviewDepthText(rows)).toBe(`Review depth\n${formatReviewDepthLines(rows).join("\n")}\n`);
    const text = renderReviewsText(
      {
        reviews: 0,
        pulls: 0,
        raised: 0,
        actedOn: 0,
        dismissed: { incorrect: 0, wontFix: 0, outOfScope: 0, deprioritised: 0 },
        answeredDisagree: 0,
        unknown: 0,
        open: 0,
        precision: null,
        resolvedBeforeMerge: { resolved: 0, total: 0, ratio: null },
        rows: [],
      },
      rows,
    );
    expect(text).toContain("Review depth");
    expect(text).toContain("missing: review-style");
  });

  test("the /reviews modal gets a Review depth tab, and scrolls the tab that is open", () => {
    const painted: Record<string, string> = {};
    let tabs: readonly { id: string; label: string }[] = [];
    let current = "reviews";
    let key: ((k: { name: string; sequence: string }) => void) | undefined;
    const nodes: Record<string, { content: string }> = {};
    const handle = presentReviews(
      (_o, _c, input) => {
        tabs = input.tabs;
        for (const tab of input.tabs) {
          current = tab.id;
          input.renderTab(tab.id, { add: (child: { content: string }) => (nodes[tab.id] = child) });
          painted[tab.id] = nodes[tab.id]?.content ?? "";
        }
        current = "depth";
        return { close: () => {}, setTab: () => {}, activeTab: () => current };
      },
      { TextRenderable: class { content: string; constructor(_r: unknown, o: { content: string }) { this.content = o.content; } } },
      {},
      {
        metrics: {
          reviews: 0, pulls: 0, raised: 0, actedOn: 0,
          dismissed: { incorrect: 0, wontFix: 0, outOfScope: 0, deprioritised: 0 },
          answeredDisagree: 0, unknown: 0, open: 0, precision: null,
          resolvedBeforeMerge: { resolved: 0, total: 0, ratio: null }, rows: [],
        },
        depth: rows,
        visibleRows: 3,
        onKeypress: (h) => { key = h; return () => {}; },
      },
    );
    expect(handle).toBeDefined();
    expect(tabs.map((t) => t.label)).toEqual(["Managed reviews", "Review depth"]);
    expect(painted.depth).toContain("acme/app#7");
    key?.({ name: "down", sequence: "down" });
    expect(nodes.depth?.content).not.toContain("acme/app#7  pr-7");
    expect(painted.reviews).not.toContain("acme/app#7");
  });
});

// Flow 431 AC12: one projection of layers.json, the layer usage, the chunk pass and the coverage waiver.
describe("layers in the review depth", () => {
  const division = { state: "none", workingCopyCommit: "abcdef0123", prHead: "abcdef0123", commitsBetween: 0, changedPaths: [] };
  const layers = {
    version: 1,
    refreshedAt: "2026-10-13T10:00:00Z",
    prHead: "abcdef0123",
    base: "abcdef0122",
    graphCommit: "abcdef0123",
    graph: { status: "ok", commit: "abcdef0123", builtAt: "2026-10-13T10:00:00Z", nodes: 10, edges: 20 },
    wiki: { status: "ok", commit: "abcdef0123", builtAt: null, pagesRefreshed: 0, pagesStaleProse: 0, written: false, divergence: division },
    memory: { status: "ok", commit: "abcdef0123", builtAt: null, entries: 1, divergence: division },
  };
  const plan = {
    schemaVersion: 1,
    reviewer: "review-regression",
    tier: "middle",
    source: "blast-radius.json",
    maxFiles: 40,
    maxBytes: 1000,
    dropped: 2,
    chunks: [{ id: "chunk-001", files: ["src/far-1.ts"], bytes: 1 }, { id: "chunk-002", files: ["src/far-2.ts"], bytes: 1 }],
  };
  const drop = (file: string) => ({ file, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" });
  const runs = [
    { reviewer: "review-logic", status: "complete", scopeComplete: true, layersUsed: { graph: 2, wiki: 0, memory: 0, ctx: 1 } },
    { reviewer: "review-style", status: "complete", scopeComplete: true },
  ];

  async function tracked(extra: Record<string, unknown> = {}): Promise<ReviewDepthRow> {
    const root = await project({
      [`${PKG}/manifest.json`]: manifest,
      [`${PKG}/research.json`]: { dispatch: { version: 1, mode: "all", selected: ["review-logic", "review-style"], runs, ...extra } },
      [`${PKG}/layers.json`]: layers,
      [`${PKG}/scope-files.json`]: { files: ["src/a.ts"] },
      [`${PKG}/blast-radius.json`]: { schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: [drop("src/far-1.ts"), drop("src/far-2.ts")] },
      [`${PKG}/chunks.json`]: plan,
    });
    await recordChunk(path.join(root, PKG), "chunk-001", { status: "DONE", findings: [] });
    const [row] = await loadReviewDepth(root);
    return row as ReviewDepthRow;
  }

  test("the one-line form states the graph head, the layers used, the unknown count and the chunk pass", async () => {
    const row = await tracked();
    expect(layersLine(row.layersView)).toBe("graph@abcdef0 = head; wiki none; memory none; layers used 1/2; unknown 1; chunks 1/2, uncovered 1");
  });

  test("a graph built from another commit reads as differs", async () => {
    const root = await project({
      [`${PKG}/manifest.json`]: manifest,
      [`${PKG}/layers.json`]: { ...layers, graphCommit: "1111111222" },
    });
    const [row] = await loadReviewDepth(root);
    expect(layersLine(row?.layersView)).toContain("graph@1111111 = differs");
  });

  test("the full lines carry layers.json, the usage per layer, every chunk's state and the coverage counts", async () => {
    const row = await tracked();
    const text = layersDepthLines(row.layersView).join("\n");
    expect(text).toContain("graph: ok @abcdef0 = head");
    expect(text).toContain("layers used: 1 of 2 reviewer(s) (graph 1, wiki 0, memory 0, ctx 1); unknown 1 (no tool-call log)");
    expect(text).toContain("chunk pass (review-regression, middle tier): 1/2 done, 0 failed, 1 pending, 1 uncovered");
    expect(text).toContain("chunk-001: done, 1 file(s), 1 attempt(s)");
    expect(text).toContain("chunk-002: pending, 1 file(s), 0 attempt(s)");
    expect(text).toContain("coverage: in scope 3, covered 2, omitted 0, uncovered 1");
  });

  test("the waiver and the operator's quote show", async () => {
    const row = await tracked({ coverageWaiver: { operatorQuote: "skip chunk two", time: "2026-10-13T11:00:00Z", files: ["src/far-2.ts"] } });
    expect(layersDepthLines(row.layersView).join("\n")).toContain('coverage waived by the operator (2026-10-13T11:00:00Z): "skip chunk two"; 1 file(s) not reviewed');
  });

  test("the depth tab, the readline text and `/review layers` print the same lines", async () => {
    const row = await tracked();
    const lines = layersDepthLines(row.layersView);
    for (const line of lines) {
      expect(formatReviewDepthLines([row])).toContain(`  ${line}`);
      expect(renderReviewLayersText([row])).toContain(`  ${line}`);
      expect(renderReviewDepthText([row])).toContain(line);
    }
    expect(renderReviewLayersText([row])).toContain(layersLine(row.layersView));
    expect(renderReviewLayersText([])).toContain(REVIEW_DEPTH_EMPTY);
  });

  test("a package with no layers.json says how to refresh it", async () => {
    const root = await project({ [`${PKG}/manifest.json`]: manifest });
    const [row] = await loadReviewDepth(root);
    expect(layersLine(row?.layersView)).toBe("layers: not refreshed");
    expect(layersDepthLines(row?.layersView).join("\n")).toContain("keryx review layers refresh --package");
  });
});
