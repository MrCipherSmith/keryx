import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatReviewDepthLines, loadReviewDepth, renderReviewDepthText, REVIEW_DEPTH_EMPTY, type ReviewDepthRow } from "./review-panel";
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
