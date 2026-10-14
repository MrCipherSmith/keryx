// `/reviews`: the TUI and readline halves of `keryx review metrics`. The modal, the sidebar row
// and the text equivalent are all built from the same `BotMetrics`, so no surface states a number
// the CLI does not.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBotMetrics, type BotMetrics, type ReviewRow } from "../review/bot/metrics";
import { classifyBusyDispatch } from "./busy-dispatch";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { findById, loadOpenTui, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";
import {
  formatReviewRowLines,
  formatReviewsHeaderLines,
  isReviewLayersCommand,
  isReviewsCommand,
  mountReviewsPanel,
  projectReviewsLayerLines,
  presentReviews,
  projectReviewsRow,
  renderReviewsText,
  REVIEWS_EMPTY,
  type PresentReviewsOptions,
} from "./reviews-inspector";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function row(over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    reviewId: "r1",
    pull: "acme/app#7",
    round: 1,
    head: "0123456789abcdef",
    findings: 4,
    actedOn: 2,
    dismissed: 1,
    answeredDisagree: 0,
    unknown: 1,
    precision: 2 / 3,
    mergedAt: null,
    resolvedBeforeMerge: null,
    ...over,
  };
}

function metrics(over: Partial<BotMetrics> = {}): BotMetrics {
  return {
    reviews: 2,
    pulls: 1,
    raised: 6,
    actedOn: 3,
    dismissed: { incorrect: 1, wontFix: 0, outOfScope: 0, deprioritised: 0 },
    answeredDisagree: 0,
    unknown: 2,
    open: 2,
    precision: 0.75,
    resolvedBeforeMerge: { resolved: 0, total: 0, ratio: null },
    rows: [row(), row({ reviewId: "r2", round: 2, head: "fedcba9876543210", findings: 2, actedOn: 1, dismissed: 0, unknown: 1, precision: 1 })],
    ...over,
  };
}

const EMPTY: BotMetrics = {
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
};

type Key = { name: string; sequence: string };

function open(load: BotMetrics, extra: Partial<PresentReviewsOptions> = {}) {
  let node: { content: string } | undefined;
  let title = "";
  let keyHandler: ((key: Key) => void) | undefined;
  let released = false;
  const handle = presentReviews(
    (_otui, _chrome, input) => {
      title = input.title;
      input.renderTab("reviews", {
        add: (child: { content: string }) => {
          node = child;
        },
      });
      return { close: () => input.onClose?.(), setTab: () => {}, activeTab: () => "reviews" };
    },
    {
      TextRenderable: class {
        content: string;
        constructor(_r: unknown, opts: { content: string }) {
          this.content = opts.content;
        }
      },
    },
    {},
    {
      metrics: load,
      visibleRows: 8,
      onKeypress: (handler) => {
        keyHandler = handler;
        return () => {
          released = true;
        };
      },
      ...extra,
    },
  );
  return {
    handle,
    title: () => title,
    painted: () => node?.content ?? "",
    press: (name: string) => keyHandler?.({ name, sequence: name }),
    released: () => released,
  };
}

describe("/reviews routing", () => {
  test("only the bare token is the command; /review is not it", () => {
    expect(isReviewsCommand("/reviews")).toBe(true);
    expect(isReviewsCommand("  /reviews  ")).toBe(true);
    expect(isReviewsCommand("/review")).toBe(false);
    expect(isReviewsCommand("/reviewsx")).toBe(false);
  });

  test("it is a busy-safe read-only surface with its own dispatch target", () => {
    const base = { isSessionInfo: false, isFlows: false, isWorkspace: false, isReview: false, isMcp: false, isMcpConsumer: false };
    expect(classifyBusyDispatch({ line: "/reviews", commandName: "/reviews", ...base })).toBe("reviews");
    expect(classifyBusyDispatch({ line: "/review", commandName: "/review", ...base })).not.toBe("reviews");
  });
});

describe("the rows the surfaces share", () => {
  test("the header carries the counts and the ratios, with n/a for a ratio nothing measured", () => {
    expect(formatReviewsHeaderLines(metrics())).toEqual([
      "2 review(s) on 1 pull request(s); 6 finding(s) raised, 2 open",
      "precision 75%   resolved before merge n/a",
    ]);
  });

  test("a review row states round, head, the findings by disposition, precision and resolved-before-merge", () => {
    expect(formatReviewRowLines(row())).toEqual([
      "acme/app#7  round 1  head 0123456",
      "  findings 4: acted on 2, dismissed 1, answered 0, open 1",
      "  precision 67%   resolved before merge n/a",
    ]);
    const merged = formatReviewRowLines(row({ mergedAt: "2026-09-01T00:00:00.000Z", resolvedBeforeMerge: 3, findings: 4 }));
    expect(merged[2]).toBe("  precision 67%   resolved before merge 3 of 4");
  });

  test("a review with no head recorded says so", () => {
    expect(formatReviewRowLines(row({ head: null }))[0]).toBe("acme/app#7  round 1  head unknown");
  });
});

describe("/reviews modal", () => {
  test("paints the header, then one block per managed review", () => {
    const view = open(metrics(), { visibleRows: 30 });
    expect(view.title()).toBe("/reviews");
    const rows = view.painted().split("\n");
    expect(rows.slice(0, 2)).toEqual(formatReviewsHeaderLines(metrics()));
    for (const line of metrics().rows.flatMap((entry) => formatReviewRowLines(entry))) expect(rows).toContain(line);
  });

  test("no managed review yet says how to get one", () => {
    const view = open(EMPTY, { visibleRows: 30 });
    expect(view.painted()).toContain(REVIEWS_EMPTY);
    expect(view.painted()).toContain("precision n/a   resolved before merge n/a");
  });

  test("scrolling moves the rows and keeps the header on screen", () => {
    const many = metrics({ rows: Array.from({ length: 6 }, (_, index) => row({ reviewId: `r${index}`, round: index + 1 })) });
    const view = open(many);
    const before = view.painted().split("\n");
    view.press("down");
    view.press("down");
    const after = view.painted().split("\n");
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after).not.toEqual(before);
    expect(after.length).toBeLessThanOrEqual(8);
  });

  test("closing the modal releases the key handler", () => {
    const view = open(metrics());
    view.handle?.close();
    expect(view.released()).toBe(true);
  });
});

describe("readline text equivalent", () => {
  test("it is the metrics block the CLI prints, then the same rows the modal paints", () => {
    const text = renderReviewsText(metrics());
    expect(text.startsWith(renderBotMetrics(metrics()))).toBe(true);
    for (const line of metrics().rows.flatMap((entry) => formatReviewRowLines(entry))) expect(text).toContain(line);
  });

  test("with nothing on record it says so instead of printing an empty table", () => {
    expect(renderReviewsText(EMPTY)).toContain(REVIEWS_EMPTY);
  });
});

describe("sidebar row", () => {
  test("shows the open-findings count, fits the sidebar width and opens the modal on click", () => {
    const shown = projectReviewsRow(metrics(), SIDEBAR_TEXT_WIDTH);
    expect(shown.text).toBe("2 open findings");
    expect(shown.action).toBe("open");
    expect(projectReviewsRow(metrics({ open: 1 }), SIDEBAR_TEXT_WIDTH).text).toBe("1 open finding");
    expect(projectReviewsRow(metrics({ open: 0, unknown: 0 }), SIDEBAR_TEXT_WIDTH).text).toBe("no open findings");
    expect(projectReviewsRow(EMPTY, SIDEBAR_TEXT_WIDTH).text).toBe("no reviews yet");
    expect(projectReviewsRow(undefined, SIDEBAR_TEXT_WIDTH).text).toBe("reading reviews…");
    for (const text of [shown.text, projectReviewsRow(metrics({ open: 123456789 }), 10).text]) expect(text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
    expect(projectReviewsRow(metrics({ open: 123456789 }), 10).text.length).toBeLessThanOrEqual(10);
  });

  otuiTest("the mounted section reads the project's managed reviews and paints the count", async () => {
    const otui = OTUI!;
    const h = await mountChrome(otui);
    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "keryx-reviews-"));
      roots.push(cwd);
      let opened = 0;
      const parent = new otui.core.BoxRenderable(h.renderer, { id: "host", flexDirection: "column" });
      h.chrome.sidebarTop.add(parent);
      const panel = mountReviewsPanel(otui.core, h.renderer, parent, {
        cwd,
        width: SIDEBAR_TEXT_WIDTH,
        onOpen: () => {
          opened += 1;
        },
        read: async () => metrics(),
      });
      await panel.refresh();
      await settle(h);
      expect(textOf(findById(parent, "sb-reviews-k"))).toBe("Reviews");
      expect(textOf(findById(parent, "sb-reviews-v"))).toBe("2 open findings");
      expect(panel.activate()).toBe("open");
      expect(opened).toBe(1);
      panel.dispose();
    } finally {
      h.destroy();
    }
  });

  otuiTest("a read that fails paints an unreadable state rather than a count", async () => {
    const otui = OTUI!;
    const h = await mountChrome(otui);
    try {
      const parent = new otui.core.BoxRenderable(h.renderer, { id: "host2", flexDirection: "column" });
      h.chrome.sidebarTop.add(parent);
      const panel = mountReviewsPanel(otui.core, h.renderer, parent, {
        cwd: "/nonexistent",
        width: SIDEBAR_TEXT_WIDTH,
        onOpen: () => {},
        read: async () => {
          throw new Error("boom");
        },
      });
      await panel.refresh();
      await settle(h);
      expect(textOf(findById(parent, "sb-reviews-v"))).toBe("unreadable");
      panel.dispose();
    } finally {
      h.destroy();
    }
  });
});

// Flow 431 AC12: the layers line per review in the sidebar, and the menu actions.
describe("layers in /reviews", () => {
  const depthRow = (over: object = {}) =>
    ({
      reviewId: "r1",
      pull: "acme/app#7",
      mode: "all",
      selected: [],
      required: [],
      excluded: [],
      missing: [],
      filesKnown: true,
      mutation: { passes: 0, totals: { killed: 0, survived: 0, invalid: 0, timeout: 0 }, pending: 0 },
      mutationWaived: false,
      layersView: {
        dir: "/p/r1",
        layers: null,
        usage: { withLog: 1, usedAny: 1, unknown: 1, total: 2, perLayer: { graph: 1, wiki: 0, memory: 0, ctx: 0 } },
        chunks: { schemaVersion: 1, reviewer: "review-regression", tier: "middle", totals: { chunks: 4, files: 4, done: 2, failed: 0, pending: 2 }, chunks: [], uncoveredFiles: [], findings: [] },
        coverageTracked: true,
        uncovered: 3,
        coverage: "coverage: in scope 5, covered 2, omitted 0, uncovered 3",
        waiver: undefined,
      },
      ...over,
    }) as never;

  test("`/review layers` is its own command and the bare /review is not it", () => {
    expect(isReviewLayersCommand("/review layers")).toBe(true);
    expect(isReviewLayersCommand("  /review   layers  ")).toBe(true);
    expect(isReviewLayersCommand("/review")).toBe(false);
    expect(isReviewLayersCommand("/reviews layers")).toBe(false);
  });

  test("the sidebar carries one entry per review with the layers used, the unknown count and the chunk pass, within the width", () => {
    const lines = projectReviewsLayerLines([depthRow(), depthRow({ reviewId: "r2" })], SIDEBAR_TEXT_WIDTH);
    expect(lines).toHaveLength(2);
    const joined = lines[0]!.replace(/\n/g, " ");
    expect(joined).toContain("layers used 1/2");
    expect(joined).toContain("unknown 1");
    expect(joined).toContain("chunks 2/4, uncovered 3");
    for (const line of lines[0]!.split("\n")) expect(line.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
    expect(projectReviewsLayerLines(undefined, SIDEBAR_TEXT_WIDTH)).toEqual([]);
  });

  test("`l` refreshes the newest review's layers and `c` prepares its missing chunks, through the menu actions", async () => {
    const called: string[] = [];
    const actions = {
      refreshLayers: async (r: { reviewId: string }) => (called.push(`layers:${r.reviewId}`), "refreshed"),
      runMissingChunks: async (r: { reviewId: string }) => (called.push(`chunks:${r.reviewId}`), "estimated"),
    };
    const view = open(metrics(), { depth: [depthRow(), depthRow({ reviewId: "r2" })], actions });
    view.press("l");
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.press("c");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called).toEqual(["layers:r1", "chunks:r1"]);
  });

  test("a key pressed while an action for the same review is still running is ignored, and works again once it ends", async () => {
    const called: string[] = [];
    let release: (message: string) => void = () => {};
    const actions = {
      refreshLayers: (r: { reviewId: string }) => {
        called.push(`layers:${r.reviewId}`);
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      runMissingChunks: async (r: { reviewId: string }) => (called.push(`chunks:${r.reviewId}`), "estimated"),
    };
    const view = open(metrics(), { depth: [depthRow()], actions });
    view.press("l");
    view.press("l");
    view.press("c");
    expect(called).toEqual(["layers:r1"]);
    release("refreshed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.press("c");
    expect(called).toEqual(["layers:r1", "chunks:r1"]);
  });

  describe("the guard is shared by every open view of the same package", () => {
    const settleLater = () => {
      const releases: Array<(message: string) => void> = [];
      const called: string[] = [];
      const actions = {
        refreshLayers: (r: { reviewId: string }) => {
          called.push(`layers:${r.reviewId}`);
          return new Promise<string>((resolve) => {
            releases.push(resolve);
          });
        },
        runMissingChunks: async (r: { reviewId: string }) => (called.push(`chunks:${r.reviewId}`), "estimated"),
      };
      return { actions, called, release: () => releases.splice(0).forEach((resolve) => resolve("refreshed")) };
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    test("a second view over the same package is refused while the first one's action is pending", async () => {
      const first = settleLater();
      const second = settleLater();
      try {
        const viewOne = open(metrics(), { depth: [depthRow()], actions: first.actions });
        const viewTwo = open(metrics(), { depth: [depthRow()], actions: second.actions });
        viewOne.press("l");
        viewTwo.press("l");
        viewTwo.press("c");
        expect(first.called).toEqual(["layers:r1"]);
        expect(second.called).toEqual([]);
      } finally {
        first.release();
        second.release();
        await tick();
      }
      const again = open(metrics(), { depth: [depthRow()], actions: second.actions });
      again.press("l");
      expect(second.called).toEqual(["layers:r1"]);
      second.release();
      await tick();
    });

    test("views over two different packages both start", async () => {
      const first = settleLater();
      const second = settleLater();
      try {
        const viewOne = open(metrics(), { depth: [depthRow()], actions: first.actions });
        const viewTwo = open(metrics(), {
          depth: [depthRow({ reviewId: "r2", layersView: { ...(depthRow() as unknown as { layersView: object }).layersView, dir: "/p/r2" } })],
          actions: second.actions,
        });
        viewOne.press("l");
        viewTwo.press("l");
        expect(first.called).toEqual(["layers:r1"]);
        expect(second.called).toEqual(["layers:r2"]);
      } finally {
        first.release();
        second.release();
        await tick();
      }
    });
  });

  test("an action that rejects frees the review instead of leaving it pending", async () => {
    const called: string[] = [];
    const actions = {
      refreshLayers: async (r: { reviewId: string }) => {
        called.push(`layers:${r.reviewId}`);
        throw new Error("boom");
      },
      runMissingChunks: async (r: { reviewId: string }) => (called.push(`chunks:${r.reviewId}`), "estimated"),
    };
    const view = open(metrics(), { depth: [depthRow()], actions });
    view.press("l");
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.press("c");
    expect(called).toEqual(["layers:r1", "chunks:r1"]);
  });

  test("without actions the keys do nothing", async () => {
    const view = open(metrics(), { depth: [depthRow()] });
    expect(() => view.press("l")).not.toThrow();
  });
});
