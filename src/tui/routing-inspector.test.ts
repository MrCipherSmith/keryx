// Flow 305 (Flow A), AC4 — `/routing`'s list + flat model picker, over a
// fixture multi-provider catalogue (never a live network probe).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatRoutingListLines,
  openRouting,
  routingCategoryRows,
} from "./routing-inspector";
import { loadOpenTui, mountChrome, keypressSource, settle } from "./ops-sidebar.test-helpers";
import { applyThemeId, getThemeId } from "./theme";
import type { KeypressEvent } from "./filter-list";
import { loadRoutingConfig, loadRoutingConfigRaw, saveRoutingConfig } from "../harness/routing/config";
import { connectedPredicateFrom } from "../harness/routing/table";
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

test("flow 305 AC10: routingCategoryRows falls through an unconnected assignment and reports it as `rejected`", () => {
  const connected = connectedPredicateFrom([{ name: "deepseek", models: ["deepseek-chat"] }]);
  const rows = routingCategoryRows(
    { table: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } },
    { table: {} },
    connected,
  );
  const review = rows.find((r) => r.category === "review")!;
  expect(review.source).toBe("default");
  expect(review.assignment).toEqual({ kind: "session-default" });
  expect(review.rejected).toEqual({
    assignment: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    source: "project",
  });
});

test("flow 305 AC10: formatRoutingListLines shows the exact fallback notice text", () => {
  const connected = connectedPredicateFrom([]);
  const rows = routingCategoryRows({ table: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } }, { table: {} }, connected);
  const lines = formatRoutingListLines(rows, 0);
  const reviewLine = lines.find((l) => l.includes("review"))!;
  expect(reviewLine).toContain("anthropic/claude-x - not connected, falling back to session default");
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
      await handle!.settled();
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

// ---------------------------------------------------------------------------
// Flow 305 AC11 — an unapproved project routing.config.json is ignored with
// a notice; `t` then `y` in the modal approves it (showing entries first);
// editing after approval voids it.
// ---------------------------------------------------------------------------

otuiTest("flow 305 AC11: an unapproved project file is ignored, with a visible notice; `t` shows its entries, `y` approves, and it then applies", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui);
  const cwd = await tempDir("keryx-routing-trust-modal-");
  const userConfigDir = await tempDir("keryx-routing-trust-user-");
  await writeFile(
    path.join(cwd, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } }),
    "utf8",
  );

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => FIXTURE_PROVIDERS,
    });
    await handle!.ready;
    await settle(chrome);

    expect(handle!.projectUntrusted()).toBe(true);
    const listLines = handle!.visibleLines();
    expect(listLines.some((l) => l.includes("review") && l.includes("session default"))).toBe(true);

    // Arm the approval — shows the file's entries BEFORE recording anything.
    chrome.mockInput.pressKey("t");
    await handle!.settled();
    await settle(chrome);
    expect(handle!.status()).toContain("anthropic/claude-x");
    expect(handle!.status()).toContain("y confirms");

    // Any other key cancels.
    chrome.mockInput.pressKey("q");
    await settle(chrome);
    expect(handle!.status()).toContain("cancelled");
    expect(handle!.projectUntrusted()).toBe(true);

    // Arm again, this time confirm.
    chrome.mockInput.pressKey("t");
    await handle!.settled();
    await settle(chrome);
    chrome.mockInput.pressKey("y");
    await handle!.settled();
    await settle(chrome);

    expect(handle!.projectUntrusted()).toBe(false);
    const appliedLines = handle!.visibleLines();
    expect(appliedLines.some((l) => l.includes("review") && l.includes("anthropic/claude-x") && l.includes("[project]"))).toBe(true);

    const raw = await loadRoutingConfigRaw("project", { cwd, userConfigDir });
    expect(raw.table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 305 AC11: editing the project file after approval voids it — the modal shows it unapproved again on reload", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui);
  const cwd = await tempDir("keryx-routing-trust-modal-");
  const userConfigDir = await tempDir("keryx-routing-trust-user-");
  await writeFile(
    path.join(cwd, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } }),
    "utf8",
  );

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => FIXTURE_PROVIDERS,
    });
    await handle!.ready;
    await settle(chrome);
    chrome.mockInput.pressKey("t");
    await handle!.settled();
    await settle(chrome);
    chrome.mockInput.pressKey("y");
    await handle!.settled();
    await settle(chrome);
    expect(handle!.projectUntrusted()).toBe(false);

    await writeFile(
      path.join(cwd, "routing.config.json"),
      JSON.stringify({ categories: { review: { kind: "model", providerId: "anthropic", modelId: "claude-y" } } }),
      "utf8",
    );
    await handle!.reload();
    await settle(chrome);

    expect(handle!.projectUntrusted()).toBe(true);
    const listLines = handle!.visibleLines();
    expect(listLines.some((l) => l.includes("review") && l.includes("session default"))).toBe(true);
  } finally {
    chrome.destroy();
  }
});

// ---------------------------------------------------------------------------
// Flow 305 item 6 — the picker's destroyed-renderable fix, regression-pinned;
// and a scale check over ~300 models.
// ---------------------------------------------------------------------------

otuiTest("flow 305 item 6: a theme change while the PICKER tab is active does not crash, and the list tab repaints correctly afterwards", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui);
  const cwd = await tempDir("keryx-routing-theme-");
  const userConfigDir = await tempDir("keryx-routing-theme-user-");
  const before = getThemeId();

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => FIXTURE_PROVIDERS,
    });
    await handle!.ready;
    await settle(chrome);
    chrome.mockInput.pressEnter(); // "default" category -> picker tab
    await settle(chrome);
    expect(handle!.activeTab()).toBe("picker");

    // This is exactly the sequence that used to throw "TextBuffer is
    // destroyed": `onThemeChange` fires `paintList`, which — before the
    // `currentTab` guard — wrote into the LIST tab's `bodyNode`, already
    // torn down by modal-host's `unmountActiveTab` when the picker tab
    // mounted.
    expect(() => applyThemeId(before === "groknight" ? "grokday" : "groknight")).not.toThrow();
    await settle(chrome);

    // The modal is still fully functional afterwards: back to the list tab
    // (Esc CLOSES this modal outright — `left` is modal-host's own
    // previous-tab key), it repaints with real content, not a stale/blank body.
    chrome.mockInput.pressArrow("left");
    await settle(chrome);
    expect(handle!.activeTab()).toBe("list");
    const lines = handle!.visibleLines();
    expect(lines.some((l) => l.includes("review"))).toBe(true);
  } finally {
    applyThemeId(before);
    chrome.destroy();
  }
});

otuiTest("flow 305 item 6: the flat picker over ~300 models filters correctly and stays fast (no obviously quadratic blow-up)", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui);
  const cwd = await tempDir("keryx-routing-scale-");
  const userConfigDir = await tempDir("keryx-routing-scale-user-");
  const BIG: readonly FlatPickerProvider[] = Array.from({ length: 10 }, (_, p) => ({
    name: `provider-${p}`,
    models: Array.from({ length: 30 }, (_, m) => `model-${p}-${m}`),
  })); // 10 * 30 = 300 models, plus 10 provider-default rows and 1 session-default row.

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => BIG,
    });
    await handle!.ready;
    await settle(chrome);
    chrome.mockInput.pressEnter();
    await settle(chrome);
    expect(handle!.activeTab()).toBe("picker");
    expect(handle!.pickerOptions().length).toBe(1 + 10 + 300);

    const start = performance.now();
    // A filter that narrows to exactly the models of one provider (30 rows).
    await chrome.mockInput.pressKeys([..."provider-7/model-7-2"]);
    await settle(chrome);
    const elapsedMs = performance.now() - start;

    // Not a tight perf assertion (headless test timing varies) — a generous
    // ceiling that a linear `.filter()` over 300 plain-string comparisons
    // clears trivially, and a quadratic-per-keystroke re-render would not.
    expect(elapsedMs).toBeLessThan(2000);

    chrome.mockInput.pressEnter();
    await handle!.settled();
    await settle(chrome);
    expect(handle!.activeTab()).toBe("list");
    const written = await loadRoutingConfig("user", { cwd, userConfigDir });
    expect(written.table.default).toEqual({ kind: "model", providerId: "provider-7", modelId: "model-7-2" });
  } finally {
    chrome.destroy();
  }
});
