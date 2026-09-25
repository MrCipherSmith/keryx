// Flow 305 (Flow A), AC4 — `/routing`'s list + flat model picker, over a
// fixture multi-provider catalogue (never a live network probe).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatRoutingListLines,
  openRouting,
  routingCategoryRows,
} from "./routing-inspector";
import { loadOpenTui, mountChrome, keypressSource, settle } from "./ops-sidebar.test-helpers";
import type { KeypressEvent } from "./filter-list";
import { loadRoutingConfig, saveRoutingConfig } from "../harness/routing/config";
import type { FlatPickerProvider } from "../harness/routing/table";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

/**
 * `keypressSource` (`ops-sidebar.test-helpers.ts`) is typed narrowly
 * (`{name, sequence}`) because most of its callers only need that — but it
 * forwards the SAME real keypress event object every renderer produces
 * (`ctrl`/`meta`/`preventDefault`/`stopPropagation` included), which is what
 * `/routing`'s flat picker needs (`mountFilterList`'s `onKey`). Widened here
 * rather than in the shared helper, to avoid touching every other test file
 * that imports it.
 */
function wideKeypressSource(renderer: Parameters<typeof keypressSource>[0]): (handler: (key: KeypressEvent) => void) => () => void {
  return keypressSource(renderer) as unknown as (handler: (key: KeypressEvent) => void) => () => void;
}

function requireOtui(): NonNullable<typeof OTUI> {
  if (OTUI === undefined) throw new Error("unreachable: otuiTest skips without the optional TUI dependency");
  return OTUI;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const FIXTURE_PROVIDERS: readonly FlatPickerProvider[] = [
  { name: "anthropic", models: ["claude-x", "claude-y"] },
  { name: "deepseek", models: ["deepseek-chat", "deepseek-reasoner"] },
];

test("routingCategoryRows: an empty routing table resolves every category to session default", () => {
  const rows = routingCategoryRows({ table: {} }, { table: {} });
  expect(rows).toHaveLength(8);
  expect(rows.every((r) => r.assignment.kind === "session-default" && r.source === "default")).toBe(true);
});

test("routingCategoryRows: project wins over user, which wins over default (AC3's precedence)", () => {
  const rows = routingCategoryRows(
    { table: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } },
    {
      table: {
        review: { kind: "model", providerId: "deepseek", modelId: "deepseek-chat" },
        quick: { kind: "provider-default", providerId: "deepseek" },
      },
    },
  );
  const review = rows.find((r) => r.category === "review")!;
  expect(review.source).toBe("project");
  expect(review.assignment).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
  const quick = rows.find((r) => r.category === "quick")!;
  expect(quick.source).toBe("user");
  expect(quick.assignment).toEqual({ kind: "provider-default", providerId: "deepseek" });
});

test("formatRoutingListLines marks the selected row", () => {
  const rows = routingCategoryRows({ table: {} }, { table: {} });
  const lines = formatRoutingListLines(rows, 1);
  expect(lines[0]?.startsWith(" ")).toBe(true);
  expect(lines[1]?.startsWith(">")).toBe(true);
});

otuiTest(
  "AC4: the list shows every category; Enter opens a FLAT picker (provider/model rows, one provider-default row per connected provider, one session-default row — never a two-step provider-then-model flow); a pick writes immediately to the per-user layer",
  async () => {
    const otui = requireOtui();
    const chrome = await mountChrome(otui);
    const cwd = await tempDir("keryx-routing-modal-");
    const userConfigDir = await tempDir("keryx-routing-user-");

    try {
      const handle = openRouting(otui.core, chrome.chrome, {
        cwd,
        userConfigDir,
        onKeypress: wideKeypressSource(chrome.renderer),
        providers: async () => FIXTURE_PROVIDERS,
      });
      expect(handle).toBeDefined();
      await handle!.ready;
      await settle(chrome);

      // The list side: every category, session default until configured.
      const listLines = handle!.visibleLines();
      expect(listLines.some((l) => l.includes("review") && l.includes("session default"))).toBe(true);
      expect(listLines.some((l) => l.includes("subagents"))).toBe(true);
      expect(handle!.selectedCategory()).toBe("default");

      // Move to `review` (index 1) and open its picker.
      chrome.mockInput.pressArrow("down");
      await settle(chrome);
      expect(handle!.selectedCategory()).toBe("review");
      chrome.mockInput.pressEnter();
      await settle(chrome);
      expect(handle!.activeTab()).toBe("picker");

      // Flat: one list, every connected model plus a provider-default row per
      // provider plus a session-default row — no "pick a provider first" step.
      const options = handle!.pickerOptions();
      const labels = options.map((o) => o.label);
      expect(labels).toContain("session default");
      expect(labels).toContain("anthropic (provider default)");
      expect(labels).toContain("deepseek (provider default)");
      expect(labels).toContain("anthropic/claude-x");
      expect(labels).toContain("deepseek/deepseek-chat");

      // Picking a model writes IMMEDIATELY to the per-user layer (AC3's
      // default write layer) — not on modal close. Drive the real SelectRenderable via keyboard rather than calling the
      // internal onPick directly — exercises the same path an operator does.
      // `mountFilterList`'s SelectRenderable starts on index 0; type a filter
      // that narrows to exactly one row, then Enter picks it.
      await chrome.mockInput.pressKeys([..."claude-x"]);
      await settle(chrome);
      chrome.mockInput.pressEnter();
      await settle(chrome);

      expect(handle!.activeTab()).toBe("list");
      const written = await loadRoutingConfig("user", { cwd, userConfigDir });
      expect(written.table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
      expect(handle!.status()).toContain("review -> anthropic/claude-x");
    } finally {
      chrome.destroy();
    }
  },
);

test("AC2/AC3 cross-check: a write through the shared loader is visible to a subsequent read of the same layer", async () => {
  const cwd = await tempDir("keryx-routing-cli-");
  const userConfigDir = await tempDir("keryx-routing-cli-user-");
  await saveRoutingConfig(
    "user",
    { cwd, userConfigDir },
    { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
  );
  const read = await loadRoutingConfig("user", { cwd, userConfigDir });
  expect(read.table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
});
