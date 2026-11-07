// Flow 305 (Flow A), AC4 — `/routing`'s list + flat model picker, over a
// fixture multi-provider catalogue (never a live network probe).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatRoutingAssignmentLines,
  loadRoutingProviders,
  modelTabNotes,
  openRouting,
  pickerAssignment,
} from "./routing-inspector";
import { normalizeRoutingConfig } from "../harness/routing/config";
import { loadOpenTui, mountChrome, keypressSource, settle } from "./ops-sidebar.test-helpers";
import { applyThemeId, getThemeId } from "./theme";
import type { KeypressEvent } from "./filter-list";
import { readRoutingSettings, replaceRoutingLayer } from "../harness/routing/settings";
import { saveProviderCatalogCache } from "../harness/provider-catalog-cache";
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


test("formatRoutingAssignmentLines names every category's assignment and layer, marking the selected row", () => {
  const config = normalizeRoutingConfig({ user: { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } } });
  const lines = formatRoutingAssignmentLines(config, 1);
  expect(lines[0]).toMatch(/^ {2}default\s+session model {2}\[builtin\]$/);
  expect(lines[1]).toMatch(/^> review\s+class expert {2}\[user\]$/);
});

test("pickerAssignment maps picker rows onto routing assignments, resolving a provider default or refusing it", () => {
  expect(pickerAssignment({ kind: "session-default" })).toEqual({ mode: "baseline" });
  expect(pickerAssignment({ kind: "model", providerId: "p", modelId: "m" })).toEqual({ mode: "model", target: { providerId: "p", modelId: "m" } });
  expect(pickerAssignment({ kind: "provider-default", providerId: "ollama" })).toEqual({ mode: "model", target: { providerId: "ollama", modelId: "llama3.1:latest" } });
  expect(pickerAssignment({ kind: "provider-default", providerId: "no-such-provider" })).toHaveProperty("error");
});

otuiTest("an unapproved project layer is ignored with a notice; `t` shows it, `y` approves, and it then applies", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-trust-");
  const userConfigDir = await tempDir("keryx-routing-trust-user-");
  await replaceRoutingLayer("project", { cwd, configDir: userConfigDir }, { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } });
  try {
    const handle = openRouting(otui.core, chrome.chrome, { cwd, userConfigDir, onKeypress: wideKeypressSource(chrome.renderer), providers: async () => FIXTURE_PROVIDERS });
    await handle!.ready;
    await settle(chrome);
    expect(handle!.projectUntrusted()).toBe(true);
    expect(handle!.status()).toContain("keryx routing trust");
    expect(handle!.visibleLines().find((line) => line.includes("review"))).toContain("[builtin]");

    await chrome.mockInput.pressKeys(["t"]);
    await handle!.settled();
    expect(handle!.status()).toContain("review: class expert");
    await chrome.mockInput.pressKeys(["y"]);
    await handle!.settled();
    await settle(chrome);
    expect(handle!.projectUntrusted()).toBe(false);
    expect(handle!.visibleLines().find((line) => line.includes("review"))).toContain("class expert  [project]");
  } finally {
    chrome.destroy();
  }
});

otuiTest("with a session model, the Categories tab previews each category through the router", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-preview-");
  const userConfigDir = await tempDir("keryx-routing-preview-user-");
  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd, userConfigDir, onKeypress: wideKeypressSource(chrome.renderer), providers: async () => [], session: SESSION_MODEL,
    });
    await handle!.ready;
    await settle(chrome);
    const line = handle!.visibleLines().find((l) => l.includes("review"));
    expect(line).toContain("openai-codex/gpt-test");
    expect(line).toContain("[builtin]");
  } finally {
    chrome.destroy();
  }
});

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
    const written = readRoutingSettings({ cwd, configDir: userConfigDir }).user.layer?.categories?.default;
    expect(written).toEqual({ mode: "model", target: { providerId: "provider-7", modelId: "model-7-2" } });
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

      const written = readRoutingSettings({ cwd, configDir: userConfigDir }).user.layer?.categories?.default;
      expect(written).toEqual({ mode: "model", target: { providerId: "openai-codex", modelId: "gpt-test" } });
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

otuiTest("flow 468 AC4: settings that cannot be read show `routing settings unavailable: <reason>` — the modal does not reject or stick on `Reading routing settings…`", async () => {
  const otui = requireOtui();
  const chrome = await mountChrome(otui, { width: 160, height: 50 });
  const cwd = await tempDir("keryx-routing-badcfg-");
  const userConfigDir = await tempDir("keryx-routing-badcfg-user-");
  await writeFile(path.join(userConfigDir, "auth.json"), JSON.stringify({ modelRouting: { schemaVersion: 2, categories: { review: { mode: "sideways" } } } }));

  try {
    const handle = openRouting(otui.core, chrome.chrome, {
      cwd,
      userConfigDir,
      onKeypress: wideKeypressSource(chrome.renderer),
      providers: async () => [],
    });
    await handle!.ready; // must resolve: a rejection fails here, loudly
    await settle(chrome);

    const text = handle!.visibleLines().join("\n");
    expect(text).toContain("routing settings unavailable:");
    expect(text).toContain("categories.review.mode is invalid");
    expect(text).not.toContain("Reading routing settings…");
    expect(handle!.status()).toContain("categories.review.mode is invalid");
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

  expect(withRedetect).toEqual([{ name: "alpha", models: ["a1"], observedAt: now }]);
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
