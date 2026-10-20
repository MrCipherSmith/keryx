// Flow 305 (Flow A), AC4 — `/routing`'s list + flat model picker, over a
// fixture multi-provider catalogue (never a live network probe).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeTaskCostSuffix,
  formatRoutingListLines,
  loadRoutingProviders,
  modelTabNotes,
  openRouting,
  ROUTING_PROVIDERS_TIMEOUT_MS,
  routingCategoryRows,
} from "./routing-inspector";
import type { TaskCostLookup } from "../harness/routing/task-cost";
import { loadOpenTui, mountChrome, keypressSource, settle } from "./ops-sidebar.test-helpers";
import { applyThemeId, getThemeId } from "./theme";
import type { KeypressEvent } from "./filter-list";
import { loadRoutingConfig, loadRoutingConfigRaw, saveRoutingConfig } from "../harness/routing/config";
import { saveProviderCatalogCache } from "../harness/provider-catalog-cache";
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

// ---------------------------------------------------------------------------
// Flow 341 (AC7) — the per-task cost suffix next to a `"derived"` row.
// ---------------------------------------------------------------------------

test("describeTaskCostSuffix: empty when the lookup has nothing for this row", () => {
  const rows = routingCategoryRows(
    { table: {} },
    { table: {} },
    () => true,
    { subagents: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
  );
  const subagents = rows.find((r) => r.category === "subagents")!;
  expect(subagents.source).toBe("derived");
  const lookup: TaskCostLookup = () => undefined;
  expect(describeTaskCostSuffix(subagents, lookup)).toBe("");
});

test("describeTaskCostSuffix: shows the median cost and n when the row resolved from the derived layer and stats exist", () => {
  const rows = routingCategoryRows(
    { table: {} },
    { table: {} },
    () => true,
    { subagents: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
  );
  const subagents = rows.find((r) => r.category === "subagents")!;
  const lookup: TaskCostLookup = (providerId, modelId, category) =>
    providerId === "anthropic" && modelId === "claude-x" && category === "subagents"
      ? { providerId, modelId, category, n: 37, medianTokens: 900, medianCostUsd: 0.04, successRate: 1 }
      : undefined;
  expect(describeTaskCostSuffix(subagents, lookup)).toBe("  ·  ~$0.04/task (n=37)");
});

test("describeTaskCostSuffix: empty for a non-derived row even when stats exist for that provider/model/category", () => {
  const rows = routingCategoryRows(
    { table: { subagents: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } },
    { table: {} },
  );
  const subagents = rows.find((r) => r.category === "subagents")!;
  expect(subagents.source).toBe("project"); // not "derived"
  const lookup: TaskCostLookup = () => ({ providerId: "anthropic", modelId: "claude-x", category: "subagents", n: 100, medianTokens: 1, medianCostUsd: 1, successRate: 1 });
  expect(describeTaskCostSuffix(subagents, lookup)).toBe("");
});

test("formatRoutingListLines: threads the cost suffix onto the derived row's line", () => {
  const rows = routingCategoryRows(
    { table: {} },
    { table: {} },
    () => true,
    { subagents: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
  );
  const lookup: TaskCostLookup = () => ({ providerId: "anthropic", modelId: "claude-x", category: "subagents", n: 20, medianTokens: 500, medianCostUsd: 0.1234, successRate: 0.9 });
  const lines = formatRoutingListLines(rows, 0, "anthropic", lookup);
  const subagentsLine = lines.find((l) => l.includes("subagents"))!;
  expect(subagentsLine).toContain("~$0.12/task (n=20)");
});

test("formatRoutingListLines: omitted taskCostFor — byte-identical to before flow 341", () => {
  const rows = routingCategoryRows(
    { table: {} },
    { table: {} },
    () => true,
    { subagents: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
  );
  const lines = formatRoutingListLines(rows, 0, "anthropic");
  const subagentsLine = lines.find((l) => l.includes("subagents"))!;
  expect(subagentsLine).not.toContain("/task");
});

test("formatRoutingListLines marks the selected row", () => {
  const rows = routingCategoryRows({ table: {} }, { table: {} });
  const lines = formatRoutingListLines(rows, 1);
  expect(lines[0]?.startsWith(" ")).toBe(true);
  expect(lines[1]?.startsWith(">")).toBe(true);
});

otuiTest(
  "flow 468 AC4: the list shows every category; Enter opens a FLAT picker (provider/model rows, one provider-default row per connected provider, one session-default row — never a two-step provider-then-model flow); a pick writes immediately to the per-user layer",
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

// ---------------------------------------------------------------------------
// Flow 468 (Phase A) — the session's own model is always pickable, and every
// failure shows its own text instead of a silent "session default"-only list.
// Titles start "flow 468 AC<n>:" so `-t "flow 468 AC4"` selects exactly these.
//
// Seams used:
//  - `FlatPickerProvider.authFailed` marks a provider whose auth failed and
//    `listUnavailable` one with no model list; `models: []` is "0 models".
//  - `RoutingModalOptions.timeoutMs` bounds how long `reload()` waits for the
//    provider loader before showing it as unavailable.
//  - `RoutingModalOptions.catalog` and `.redetect` drive the default loader.
//  - `options.session` is the session's own provider/model.
// ---------------------------------------------------------------------------

const SESSION_MODEL = { providerId: "openai-codex", modelId: "gpt-test" } as const;

/** The whole rendered screen as text — what the operator sees, not a handle accessor. */
function frameOf(chrome: { captureCharFrame(): string }): string {
  return chrome.captureCharFrame();
}

async function openModelTab(
  otui: NonNullable<typeof OTUI>,
  chrome: Awaited<ReturnType<typeof mountChrome>>,
  options: Partial<Parameters<typeof openRouting>[2]> & { cwd: string },
) {
  const handle = openRouting(otui.core, chrome.chrome, { onKeypress: wideKeypressSource(chrome.renderer), ...options });
  await handle!.ready;
  await settle(chrome);
  chrome.mockInput.pressEnter(); // the selected category's picker = the Model tab
  await settle(chrome, 5);
  return handle!;
}

otuiTest(
  "flow 468 AC3: the session's own provider/model is listed `(current session)` although the provider loader returns none; Enter writes the user-layer pick and the Categories tab shows it",
  async () => {
    const otui = requireOtui();
    const chrome = await mountChrome(otui, { width: 160, height: 50 });
    const cwd = await tempDir("keryx-routing-session-");
    const userConfigDir = await tempDir("keryx-routing-session-user-");

    try {
      const handle = await openModelTab(otui, chrome, { cwd, userConfigDir, providers: async () => [], session: SESSION_MODEL });
      expect(handle.activeTab()).toBe("picker");

      const labels = handle.pickerOptions().map((o) => o.label);
      expect(labels.some((l) => l.includes("openai-codex/gpt-test") && l.includes("(current session)"))).toBe(true);

      await chrome.mockInput.pressKeys([..."gpt-test"]);
      await settle(chrome);
      chrome.mockInput.pressEnter();
      await handle.settled();
      await settle(chrome);

      const written = await loadRoutingConfig("user", { cwd, userConfigDir });
      expect(written.table.default).toEqual({ kind: "model", providerId: "openai-codex", modelId: "gpt-test" });
      expect(handle.activeTab()).toBe("list");
      // The Categories tab shows the pick, resolved (not rejected as "not connected").
      const line = handle.visibleLines().find((l) => l.includes("default") && l.includes("[user]"));
      expect(line).toContain("openai-codex/gpt-test");
      expect(line).not.toContain("falling back");
    } finally {
      chrome.destroy();
    }
  },
);

otuiTest("flow 468 AC4: no provider connected — the Model tab says so and points at /connect", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-none-");
  const userConfigDir = await tempDir("keryx-routing-none-user-");

  try {
    await openModelTab(otui, chrome, { cwd, userConfigDir, providers: async () => [] });
    const frame = frameOf(chrome);
    expect(frame).toContain("no providers connected");
    expect(frame).toContain("/connect");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: the catalog is unavailable — the Model tab shows the reason it gave", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-down-");
  const userConfigDir = await tempDir("keryx-routing-down-user-");

  try {
    await openModelTab(otui, chrome, {
      cwd,
      userConfigDir,
      providers: async () => {
        throw new Error("catalog host refused the connection");
      },
    });
    const frame = frameOf(chrome);
    expect(frame).toContain("unavailable");
    expect(frame).toContain("catalog host refused the connection");
    // A failed load is not "nothing connected": the two states never show together.
    expect(frame).not.toContain("no providers connected");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: a provider whose auth failed, and one with 0 models, are each shown on the Model tab — not omitted", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-states-");
  const userConfigDir = await tempDir("keryx-routing-states-user-");
  const providers: readonly FlatPickerProvider[] = [
    { name: "alpha", models: ["a1"] },
    { name: "beta", models: [], authFailed: true },
    { name: "gamma", models: [] },
  ];

  try {
    await openModelTab(otui, chrome, { cwd, userConfigDir, providers: async () => providers });
    const lines = frameOf(chrome).split("\n");
    expect(lines.some((l) => l.includes("beta") && l.includes("auth failed"))).toBe(true);
    expect(lines.some((l) => l.includes("gamma") && l.includes("0 models"))).toBe(true);
    // Each state is reported once, as itself: an auth-failed provider is not also "0 models", and a healthy one gets no note.
    expect(lines.some((l) => l.includes("beta: 0 models"))).toBe(false);
    expect(lines.some((l) => l.includes("alpha:"))).toBe(false);
    expect(lines.some((l) => l.includes("no providers connected"))).toBe(false);
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: an assigned model missing from its provider's list says `model not in <provider>'s list`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-missing-");
  const userConfigDir = await tempDir("keryx-routing-missing-user-");
  await saveRoutingConfig("user", { cwd, userConfigDir }, { coding: { kind: "model", providerId: "alpha", modelId: "gone-model" } });

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [{ name: "alpha", models: ["a1"] }],
    });
    await handle!.ready;
    await settle(chrome);
    const line = handle!.visibleLines().find((l) => l.includes("coding"));
    expect(line).toContain("model not in alpha's list");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: an assignment to a provider absent from a non-empty list says `provider not connected`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-absent-");
  const userConfigDir = await tempDir("keryx-routing-absent-user-");
  await saveRoutingConfig("user", { cwd, userConfigDir }, { coding: { kind: "model", providerId: "beta", modelId: "b1" } });

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [{ name: "alpha", models: ["a1"] }],
    });
    await handle!.ready;
    await settle(chrome);
    const line = handle!.visibleLines().find((l) => l.includes("coding"));
    expect(line).toContain("provider not connected");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: a LOADED but EMPTY provider list says `no providers connected` for an assignment — distinct from `provider list unavailable`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-empty-");
  const userConfigDir = await tempDir("keryx-routing-empty-user-");
  await saveRoutingConfig("user", { cwd, userConfigDir }, { coding: { kind: "model", providerId: "alpha", modelId: "a1" } });

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [],
    });
    await handle!.ready;
    await settle(chrome);
    const line = handle!.visibleLines().find((l) => l.includes("coding"));
    expect(line).toContain("no providers connected");
    expect(line).not.toContain("provider list unavailable");
    expect(line).not.toContain("provider not connected");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: an assignment to an auth-failed provider says `provider auth failed`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-authfail-");
  const userConfigDir = await tempDir("keryx-routing-authfail-user-");
  await saveRoutingConfig("user", { cwd, userConfigDir }, { coding: { kind: "model", providerId: "beta", modelId: "b1" } });

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [{ name: "beta", models: [], authFailed: true }],
    });
    await handle!.ready;
    await settle(chrome);
    const line = handle!.visibleLines().find((l) => l.includes("coding"));
    expect(line).toContain("provider auth failed");
    expect(line).not.toContain("provider list unavailable");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: a REJECTING provider loader leaves `Reading routing table…`, and its assignments say `provider list unavailable`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-reject-");
  const userConfigDir = await tempDir("keryx-routing-reject-user-");
  await saveRoutingConfig("user", { cwd, userConfigDir }, { coding: { kind: "model", providerId: "alpha", modelId: "a1" } });

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => {
        throw new Error("loader blew up");
      },
    });
    await handle!.ready;
    await settle(chrome);

    expect(handle!.visibleLines().join("\n")).not.toContain("Reading routing table…");
    expect(frameOf(chrome)).not.toContain("Reading routing table…");
    expect(handle!.visibleLines().find((l) => l.includes("coding"))).toContain("provider list unavailable");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: a provider loader that NEVER resolves leaves `Reading routing table…` within the timeout, and the Model tab says it timed out", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-hang-");
  const userConfigDir = await tempDir("keryx-routing-hang-user-");

  try {
    const startedAt = performance.now();
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: () => new Promise<never>(() => {}),
      timeoutMs: 30, // test seam: production uses its own bound
    });
    // Settles once the 30 ms bound fires and the reload finishes; if the bound is gone it never does and this test times out.
    await handle!.ready;
    const elapsedMs = performance.now() - startedAt;
    await settle(chrome);

    // Well under the production bound: the modal gave up on the seam's bound, not on the real 12 s one.
    expect(elapsedMs).toBeLessThan(ROUTING_PROVIDERS_TIMEOUT_MS / 2);
    expect(handle!.visibleLines().join("\n")).not.toContain("Reading routing table…");
    expect(frameOf(chrome)).not.toContain("Reading routing table…");

    // The same state, positively: the Model tab names the timeout instead of claiming nothing is connected.
    chrome.mockInput.pressEnter();
    await settle(chrome, 5);
    const frame = frameOf(chrome);
    expect(frame).toContain("model list unavailable");
    expect(frame).toContain("timed out");
    expect(frame).not.toContain("no providers connected");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: config that cannot be read shows `routing table unavailable: <reason>` — the modal does not reject or stick on `Reading routing table…`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-badcfg-");
  const userConfigDir = await tempDir("keryx-routing-badcfg-user-");

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [],
      load: async () => {
        throw new Error("config unreadable");
      },
    });
    await handle!.ready; // must resolve: a rejection fails here, loudly
    await settle(chrome);

    const text = handle!.visibleLines().join("\n");
    expect(text).toContain("routing table unavailable: config unreadable");
    expect(text).not.toContain("Reading routing table…");
    expect(handle!.status()).toContain("config unreadable");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: an assignment to a provider with no model list says `model list unavailable (<reason>)`, not `provider not connected`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-unlisted-cat-");
  const userConfigDir = await tempDir("keryx-routing-unlisted-cat-user-");
  await saveRoutingConfig("user", { cwd, userConfigDir }, { coding: { kind: "model", providerId: "gamma", modelId: "g1" } });

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [{ name: "alpha", models: ["a1"] }, { name: "gamma", models: [], listUnavailable: "timed out" }],
    });
    await handle!.ready;
    await settle(chrome);
    const line = handle!.visibleLines().find((l) => l.includes("coding"));
    expect(line).toContain("model list unavailable (timed out)");
    expect(line).not.toContain("provider not connected");
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC4: a provider with no model list is shown on the Model tab with its reason, and is not selectable", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-unlisted-");
  const userConfigDir = await tempDir("keryx-routing-unlisted-user-");

  try {
    const handle = await openModelTab(otui, chrome, {
      cwd,
      userConfigDir,
      providers: async () => [
        { name: "alpha", models: ["a1"] },
        { name: "gamma", models: [], listUnavailable: "timed out" },
      ],
    });
    const lines = frameOf(chrome).split("\n");
    expect(lines.some((l) => l.includes("gamma") && l.includes("model list unavailable (timed out)"))).toBe(true);
    // Not a "0 models" line as well, and nothing to pick for it.
    expect(lines.some((l) => l.includes("gamma: 0 models"))).toBe(false);
    expect(handle.pickerOptions().some((o) => o.label.includes("gamma"))).toBe(false);
  } finally {
    chrome.destroy();
  }
});

// --- the default loader (no injected `providers`): the wiring `/routing` ships with ---

const NO_NETWORK = (async () => {
  throw new Error("the default loader must not reach the network in this test");
}) as unknown as typeof fetch;

otuiTest("flow 468 AC4: the default loader serves the catalog cache with status rows — an auth-failed provider is shown and is not selectable", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-default-");
  const userConfigDir = await tempDir("keryx-routing-default-user-");
  const catalogDir = await tempDir("keryx-routing-default-catalog-");
  const now = new Date().toISOString();
  await saveProviderCatalogCache(
    {
      fetchedAt: now,
      providers: {
        alpha: { name: "alpha", status: "ok", models: ["a1"], fallbackModels: [], fetchedAt: now },
        beta: { name: "beta", status: "auth-failed", models: [], fallbackModels: ["b1"], fetchedAt: now },
        gamma: { name: "gamma", status: "unreachable", models: [], fallbackModels: [], fetchedAt: now },
      },
    },
    catalogDir,
  );

  try {
    const handle = await openModelTab(otui, chrome, { cwd, userConfigDir, catalog: { dir: catalogDir, fetch: NO_NETWORK, env: {} } });
    const lines = frameOf(chrome).split("\n");
    expect(lines.some((l) => l.includes("beta") && l.includes("auth failed"))).toBe(true);
    expect(lines.some((l) => l.includes("gamma") && l.includes("model list unavailable (unreachable)"))).toBe(true);
    const labels = handle.pickerOptions().map((o) => o.label);
    expect(labels).toContain("alpha/a1");
    expect(labels.some((l) => l.includes("beta"))).toBe(false);
    expect(labels.some((l) => l.includes("gamma"))).toBe(false);
  } finally {
    chrome.destroy();
  }
});

otuiTest("flow 468 AC1: the default loader detects live through the shell's `redetect` when the catalog cache is empty", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-redetect-");
  const userConfigDir = await tempDir("keryx-routing-redetect-user-");
  const catalogDir = await tempDir("keryx-routing-redetect-catalog-");
  let detections = 0;

  try {
    const handle = await openModelTab(otui, chrome, {
      cwd,
      userConfigDir,
      catalog: { dir: catalogDir, fetch: NO_NETWORK, env: {} },
      redetect: async () => {
        detections += 1;
        return [{ name: "ollama", models: ["llama-fake"] }];
      },
    });
    expect(detections).toBe(1);
    expect(handle.pickerOptions().map((o) => o.label)).toContain("ollama/llama-fake");
  } finally {
    chrome.destroy();
  }
});

test("flow 468 AC1: loadRoutingProviders serves a fresh non-empty cache as is and never calls `redetect`", async () => {
  const catalogDir = await tempDir("keryx-routing-load-catalog-");
  const now = new Date().toISOString();
  await saveProviderCatalogCache(
    { fetchedAt: now, providers: { alpha: { name: "alpha", status: "ok", models: ["a1"], fallbackModels: [], fetchedAt: now } } },
    catalogDir,
  );
  let detections = 0;

  const withRedetect = await loadRoutingProviders(
    async () => {
      detections += 1;
      return [];
    },
    { dir: catalogDir, fetch: NO_NETWORK, env: {} },
  );

  expect(withRedetect).toEqual([{ name: "alpha", models: ["a1"] }]);
  expect(detections).toBe(0);
});

test("flow 468 AC4: modelTabNotes reports each state once and keeps `no providers connected` for a loaded empty list only", () => {
  expect(modelTabNotes([], undefined)).toEqual(["no providers connected — add one with /connect"]);
  expect(modelTabNotes([], "timed out after 12s")).toEqual(["model list unavailable (timed out after 12s)"]);
  expect(modelTabNotes([{ name: "alpha", models: ["a1"] }], undefined)).toEqual([]);
  expect(
    modelTabNotes(
      [
        { name: "beta", models: [], authFailed: true },
        { name: "gamma", models: [], listUnavailable: "unreachable" },
        { name: "delta", models: [] },
      ],
      undefined,
    ),
  ).toEqual([
    "beta: auth failed — /connect to re-enter the key",
    "gamma: model list unavailable (unreachable)",
    "delta: 0 models",
  ]);
});
