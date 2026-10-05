// Flow 404 (AC9): the sidebar row with the date of the last Part 1 materials sync.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG_DIR, STATUS_FILE } from "../commands/research-sync";
import { renderFailureStatus, renderStatus } from "../commands/research-sync-status";
import { findById, loadOpenTui, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import {
  mountResearchSyncPanel,
  projectResearchSyncRow,
  readResearchSyncSnapshot,
  RESEARCH_SYNC_LABEL,
  type ResearchSyncSnapshot,
} from "./research-sync-panel";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const RUN = new Date(Date.UTC(2026, 9, 5, 3, 52));
const OK_PAGE = ["# Текущее состояние / Live status", "", "Запуск (run, UTC): 2026-10-05 03:52 UTC", "", "Состояние (status): ok", ""].join("\n");

async function checkout(status?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-research-panel-"));
  roots.push(root);
  await mkdir(path.join(root, CATALOG_DIR), { recursive: true });
  if (status !== undefined) await writeFile(path.join(root, CATALOG_DIR, STATUS_FILE), status);
  return root;
}

describe("projectResearchSyncRow", () => {
  test("is hidden in a checkout without the catalog", () => {
    expect(projectResearchSyncRow({ catalog: false, status: null }, SIDEBAR_TEXT_WIDTH).visible).toBe(false);
  });

  test("escapes terminal control sequences on the run line, in an ok page and in a failed one", () => {
    // OSC (set window title, BEL-terminated), CSI (clear screen, cursor home), a bare ESC, DEL and a C1 control.
    const hostile = "\u001b]0;pwned\u0007\u001b[2J\u001b[H\u001bX\u007f\u009b31m2026-10-05 03:52 UTC";
    for (const state of ["ok", "ошибка (failed): x"]) {
      const status = `# Текущее состояние / Live status\n\nЗапуск (run, UTC): ${hostile}\n\nСостояние (status): ${state}\n`;
      const row = projectResearchSyncRow({ catalog: true, status }, 200);
      expect(row.visible).toBe(true);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(row.text)).toBe(false);
      expect(row.text).toContain("2026-10-05 03:52 UTC");
      expect(row.text).toContain("\\x1b");
    }
  });

  test("says it has not run when the status page is missing or has no run line", () => {
    for (const snapshot of [{ catalog: true, status: null }, { catalog: true, status: "# Текущее состояние / Live status\n" }] satisfies ResearchSyncSnapshot[]) {
      const row = projectResearchSyncRow(snapshot, SIDEBAR_TEXT_WIDTH);
      expect(row).toMatchObject({ visible: true, text: "ещё не запускалась", role: "muted" });
    }
  });

  test("shows the run time written by the sync, for the page the sync renders", () => {
    const page = renderStatus({
      runAt: RUN,
      head: "abc",
      snapshot: { commit: "04809f4f" },
      latest: {},
      report: {
        total: 0,
        withoutRecommendation: 0,
        deviations: [],
        ineligible: { decisions: 0 },
        byMode: { ordinary: { answered: 0, matched: 0 }, partial: { answered: 0, matched: 0 }, blind: { answered: 0, matched: 0 } },
        progress: { perArm: { threshold: 150, counts: {}, met: false }, ac11: { decisions: 0, decisionsTarget: 1, blind: 0, blindTarget: 1, met: false } },
      } as never,
      contributionRows: 1,
    });
    const row = projectResearchSyncRow({ catalog: true, status: page }, SIDEBAR_TEXT_WIDTH);
    expect(row).toMatchObject({ visible: true, text: "2026-10-05 03:52 UTC", role: "ok" });
  });

  test("marks a failed run and still shows its time; fits the sidebar width", () => {
    const failed = renderFailureStatus({ runAt: RUN, reason: "git archive failed", previous: OK_PAGE });
    const row = projectResearchSyncRow({ catalog: true, status: failed }, SIDEBAR_TEXT_WIDTH);
    expect(row.role).toBe("error");
    expect(row.text).toBe("ошибка 2026-10-05 03:52 UTC");
    expect(row.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
    expect(projectResearchSyncRow({ catalog: true, status: OK_PAGE }, 8).text.length).toBeLessThanOrEqual(8);
  });
});

describe("readResearchSyncSnapshot", () => {
  test("reads the catalog state from the checkout", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "keryx-research-panel-"));
    roots.push(empty);
    expect(await readResearchSyncSnapshot(empty)).toEqual({ catalog: false, status: null });
    expect(await readResearchSyncSnapshot(await checkout())).toEqual({ catalog: true, status: null });
    expect(await readResearchSyncSnapshot(await checkout(OK_PAGE))).toEqual({ catalog: true, status: OK_PAGE });
  });
});

describe("mounted sidebar row", () => {
  otuiTest("paints the label and the last run, and repaints on refresh", async () => {
    const otui = OTUI!;
    const h = await mountChrome(otui);
    try {
      let snapshot: ResearchSyncSnapshot = { catalog: true, status: null };
      const parent = new otui.core.BoxRenderable(h.renderer, { id: "host-research", flexDirection: "column" });
      h.chrome.sidebarTop.add(parent);
      const panel = mountResearchSyncPanel(otui.core, h.renderer, parent, {
        root: "/unused",
        width: SIDEBAR_TEXT_WIDTH,
        read: async () => snapshot,
        interval: () => () => {},
      });
      await panel.refresh();
      await settle(h);
      expect(textOf(findById(parent, "sb-research-sync-k"))).toBe(RESEARCH_SYNC_LABEL);
      expect(textOf(findById(parent, "sb-research-sync-v"))).toBe("ещё не запускалась");

      snapshot = { catalog: true, status: OK_PAGE };
      await panel.refresh();
      await settle(h);
      expect(textOf(findById(parent, "sb-research-sync-v"))).toBe("2026-10-05 03:52 UTC");

      snapshot = { catalog: false, status: null };
      await panel.refresh();
      await settle(h);
      expect(findById(parent, "sb-research-sync-v")).toBeUndefined();
      panel.dispose();
    } finally {
      h.destroy();
    }
  });
});
