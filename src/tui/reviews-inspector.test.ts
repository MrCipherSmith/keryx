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
  isReviewsCommand,
  mountReviewsPanel,
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
