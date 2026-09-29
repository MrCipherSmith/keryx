// Flow 362, AC9: `/product` lists the intents closed in code that nobody looked
// back at, with the never-checked count in the header. Asserted on the ROWS the
// modal paints, not only on the formatter that feeds them.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildIntentIndex } from "../product/corpus";
import { copyFixtureRepo } from "../product/fixtures/repo";
import { buildOpenReport, indexPath, loadOpenReport, writeIntentIndex, type OpenLoad } from "../product/service";
import { classifyBusyDispatch } from "./busy-dispatch";
import { isProductCommand, presentProductOpen, type PresentProductOptions } from "./product-open-surface";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureLoad(): Promise<OpenLoad> {
  const root = await copyFixtureRepo();
  roots.push(root);
  const index = await buildIntentIndex(root);
  await writeIntentIndex(root, index);
  return { ok: true, report: buildOpenReport(index) };
}

type Key = { name: string; sequence: string };

/** Open the modal with a fake host; returns the painted node and the key sender. */
function open(load: OpenLoad, extra: Partial<PresentProductOptions> = {}) {
  let node: { content: string } | undefined;
  let title = "";
  let keyHandler: ((key: Key) => void) | undefined;
  let closed = false;
  const handle = presentProductOpen(
    (_otui, _chrome, input) => {
      title = input.title;
      input.renderTab("open", {
        add: (child: { content: string }) => {
          node = child;
        },
      });
      return { close: () => input.onClose?.(), setTab: () => {}, activeTab: () => "open" };
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
      load,
      visibleRows: 8,
      onKeypress: (handler) => {
        keyHandler = handler;
        return () => {
          closed = true;
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
    unsubscribed: () => closed,
  };
}

describe("/product renders the open list", () => {
  test("the header carries the never-checked count and the three-way breakdown", async () => {
    const view = open(await fixtureLoad(), { visibleRows: 20 });
    expect(view.title()).toBe("/product");
    const rows = view.painted().split("\n");
    expect(rows.slice(0, 4)).toEqual([
      "intents closed in code, never checked for effect: 3 of 4",
      "  no outcome criterion stated: 2",
      "  criterion stated, never observed: 1",
      "  observed: 1",
    ]);
  });

  test("one block per never-checked flow, with its outcome criterion or the not-measured text", async () => {
    const painted = open(await fixtureLoad(), { visibleRows: 30 }).painted();
    const rows = painted.split("\n");
    expect(rows).toContain("flow 005  Bump the lockfile");
    expect(rows).toContain("flow 003  Rename the export button");
    expect(rows).toContain("flow 001  Retry checkout on a stale token");
    expect(painted).toContain("outcome: not measured — no instrument stated");
    expect(painted).toContain("outcome: Checkout error rate for expired tokens");
    expect(rows.indexOf("flow 005  Bump the lockfile")).toBeLessThan(rows.indexOf("flow 001  Retry checkout on a stale token"));
  });

  test("an observed flow and an open flow are not painted", async () => {
    const painted = open(await fixtureLoad(), { visibleRows: 30 }).painted();
    expect(painted).not.toContain("Cache the price list");
    expect(painted).not.toContain("Export the audit log");
  });

  test("scrolling moves the rows and keeps the header on screen", async () => {
    const view = open(await fixtureLoad());
    const before = view.painted().split("\n");
    expect(before[0]).toBe("intents closed in code, never checked for effect: 3 of 4");
    view.press("down");
    view.press("down");
    const after = view.painted().split("\n");
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
    expect(after).not.toEqual(before);
    expect(after.length).toBeLessThanOrEqual(8);
  });

  test("closing the modal releases the key handler", async () => {
    const view = open(await fixtureLoad());
    view.handle?.close();
    expect(view.unsubscribed()).toBe(true);
  });

  test("a project with nothing waiting says so under a zero count", () => {
    const view = open({ ok: true, report: { closed: 2, neverChecked: 0, noCriterion: 0, notObserved: 0, observed: 2, entries: [] } }, { visibleRows: 20 });
    const rows = view.painted().split("\n");
    expect(rows[0]).toBe("intents closed in code, never checked for effect: 0 of 2");
    expect(rows).toContain("Nothing closed in code is waiting for a look back.");
  });

  test("a missing index paints the message that names `keryx product index`, and no count", async () => {
    const root = await copyFixtureRepo();
    roots.push(root);
    const load = await loadOpenReport(root);
    expect(load.ok).toBe(false);
    const painted = open(load).painted();
    expect(painted).toContain("keryx product index");
    expect(painted).not.toContain("never checked for effect");
  });
});

describe("/product over a hand-edited index", () => {
  const broken: Array<[string, (index: Record<string, unknown>) => void]> = [
    ["no failures list", (index) => void delete index.failures],
    ["empty counts", (index) => void (index.counts = {})],
    ["an intent with no outcome", (index) => void delete (index.intents as Array<Record<string, unknown>>)[0]?.outcome],
  ];
  for (const [name, mutate] of broken) {
    test(`${name} paints the message that names \`keryx product index\`, and no count`, async () => {
      const root = await copyFixtureRepo();
      roots.push(root);
      const index = JSON.parse(JSON.stringify(await buildIntentIndex(root))) as Record<string, unknown>;
      mutate(index);
      await Bun.write(indexPath(root), JSON.stringify(index));
      const load = await loadOpenReport(root);
      expect(load.ok).toBe(false);
      const painted = open(load).painted();
      expect(painted).toContain("keryx product index");
      expect(painted).not.toContain("never checked for effect");
    });
  }
});

describe("/product routing", () => {
  test("only the bare command word opens it", () => {
    expect(isProductCommand("/product")).toBe(true);
    expect(isProductCommand("  /product  ")).toBe(true);
    expect(isProductCommand("/products")).toBe(false);
    expect(isProductCommand("product")).toBe(false);
  });

  test("it is read-only, so it opens while a turn is running instead of being deferred", () => {
    const base = { isSessionInfo: false, isFlows: false, isWorkspace: false, isReview: false, isMcp: false, isMcpConsumer: false };
    expect(classifyBusyDispatch({ line: "/product", commandName: "/product", ...base })).toBe("product");
  });
});
