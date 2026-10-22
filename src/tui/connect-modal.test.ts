// flow 471: `/connect` is ONE "Providers" dialog with two tabs, "Connected" and
// "Add provider" (AC2, AC4, AC5, AC6, AC7, AC11). Every test mounts the real
// `selectProviderModelInTui` inside the real shell chrome (so the dialog is a
// ModalHost modal, not the bare-renderer overlay), with an injected fetch/env
// and a temp config dir — never the real home and never the network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsForMode } from "../commands/agent-commands";
import type { DetectedProvider } from "../commands/select";
import { loadShellConfig, saveApiKey, shellConfigPath } from "../lib/shell-config";
import { createShellChrome, type ShellChrome } from "./shell-chrome";
import { selectProviderModelInTui } from "./tui-shell";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    // SEQUENTIAL, never `Promise.all` — see `shell-chrome.test.ts`'s own loader.
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;
type Mounted = TestSetup & { chrome: ShellChrome; destroy: () => void };

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

const ESC_PARSER_TIMEOUT_MS = 50;

async function mountChrome(otui: OtuiBundle, size: { width: number; height: number } = { width: 120, height: 40 }): Promise<Mounted> {
  const setup = await otui.testing.createTestRenderer(size);
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · chrome",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
  });
  await setup.flush();
  return {
    ...setup,
    chrome,
    destroy: () => {
      chrome.destroy();
      setup.renderer.destroy();
    },
  };
}

async function pressEscape(h: TestSetup): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

/** Wait for a frame matching `predicate` against a wall-clock deadline (not a render-pass count). */
async function waitFor(h: TestSetup, predicate: (frame: string) => boolean, deadlineMs = 5_000): Promise<string> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    await h.flush();
    const frame = h.captureCharFrame();
    if (predicate(frame) || Date.now() >= until) return frame;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Zero-based `{ row, col }` of `needle` within the frame LINE containing `rowNeedle` (col + 1: inside the text). */
function locate(frame: string, rowNeedle: string, needle: string): { row: number; col: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(rowNeedle));
  if (row < 0) return { row: -1, col: -1 };
  const col = lines[row]!.indexOf(needle);
  return { row, col: col < 0 ? -1 : col + 1 };
}

const DEEPSEEK: DetectedProvider = { name: "deepseek", label: "DeepSeek", models: ["deepseek-chat"], envKey: "DEEPSEEK_API_KEY" };
const GROQ: DetectedProvider = { name: "groq", label: "Groq", models: ["llama-3.3-70b-versatile"], envKey: "GROQ_API_KEY" };
const ENV_KEYS = ["DEEPSEEK_API_KEY", "GROQ_API_KEY"] as const;
const SECRET = "sk-flow471-SECRET-0123456789";

/** Counts calls and answers a live two-model list, whatever the credential. */
function countingFetch(): { fetchFn: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchFn = (async () => {
    n += 1;
    return { ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => n };
}

let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "keryx-connect-modal-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(configDir, { recursive: true, force: true });
});

/** Seed a saved key so a provider counts as connected without touching process.env. */
function seedConnected(...providers: DetectedProvider[]): void {
  for (const p of providers) saveApiKey(p.envKey!, "sk-seeded", configDir);
}

describe("AC2 — one Providers dialog with two tabs", () => {
  otuiTest("opens on Connected when something is connected; digits, Tab and the mouse switch tabs", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      let frame = await waitFor(h, (f) => f.includes("[Disconnect]"));
      expect(h.renderer.root.findDescendantById("modal-backdrop")?.visible).toBe(true);
      expect(frame).toContain("Providers");
      expect(frame).toContain("Connected");
      expect(frame).toContain("Add provider");
      expect(frame).toContain("[Test]");
      expect(frame).not.toContain("Groq"); // not connected: only on the Add tab

      await h.mockInput.pressKeys(["2"]);
      frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      expect(frame).toContain("Groq");

      await h.mockInput.pressKeys(["1"]);
      frame = await waitFor(h, (f) => f.includes("[Disconnect]"));
      expect(frame).not.toContain("Add custom provider");

      h.mockInput.pressTab(); // cycles to the next tab
      frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressTab(); // and wraps
      frame = await waitFor(h, (f) => f.includes("[Disconnect]"));

      // Clicking the tab strip switches too (the second occurrence is the tab, the first the button).
      const lines = frame.split("\n");
      const row = lines.findIndex((l) => l.includes("Providers")) + 1;
      const tabRow = lines.findIndex((l, i) => i >= row - 1 && l.includes("Connected") && l.includes("Add provider"));
      expect(tabRow).toBeGreaterThanOrEqual(0);
      const col = lines[tabRow]!.lastIndexOf("Add provider");
      await h.mockMouse.click(col + 1, tabRow);
      frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      expect(frame).toContain("[Connect]");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("opens on Add provider when nothing is connected, with no toast and no network call", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      const frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      expect(frame).toContain("[Connect]");
      expect(frame).toContain("DeepSeek");
      expect(frame).not.toContain("No connected providers");
      expect(frame).not.toContain("[Disconnect]");
      expect(calls()).toBe(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
      expect(h.chrome.overlayActive()).toBe(false);
    } finally {
      h.destroy();
    }
  });

  otuiTest("disconnecting the last connected provider moves to the Add tab", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("[Disconnect]"));
      h.mockInput.pressArrow("right");
      h.mockInput.pressArrow("right"); // Label -> Test -> Disconnect
      await h.flush();
      h.mockInput.pressEnter(); // arm
      await waitFor(h, (f) => f.includes("disconnect 'DeepSeek'?"));
      h.mockInput.pressEnter(); // confirm
      const frame = await waitFor(h, (f) => f.includes("No providers connected"));
      expect(frame).toContain("Add custom provider");
      expect(loadShellConfig(configDir).apiKeys?.DEEPSEEK_API_KEY).toBeUndefined();

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });
});

describe("AC4 — the [Add provider] button, by mouse and by keyboard", () => {
  otuiTest("clicking [Add provider] opens the Add tab", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      const frame = await waitFor(h, (f) => f.includes("[Add provider]"));
      const button = locate(frame, "[Add provider]", "[Add provider]");
      expect(button.col).toBeGreaterThan(0);
      await h.mockMouse.click(button.col, button.row);
      const added = await waitFor(h, (f) => f.includes("Add custom provider"));
      expect(added).toContain("Groq");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("the a key opens the Add tab", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("[Disconnect]"));
      await h.mockInput.pressKeys(["a"]);
      const added = await waitFor(h, (f) => f.includes("Add custom provider"));
      expect(added).toContain("Groq");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });
});

describe("AC5 — the Add tab lists every provider with [Connect] and [Test]", () => {
  otuiTest("each provider and the custom entry get their buttons; Test with no credential makes no request", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      let frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      for (const label of ["DeepSeek", "Groq"]) {
        expect(locate(frame, label, "[Connect]").col).toBeGreaterThan(0);
        expect(locate(frame, label, "[Test]").col).toBeGreaterThan(0);
      }
      expect(locate(frame, "Add custom provider", "[Connect]").col).toBeGreaterThan(0);

      const test = locate(frame, "DeepSeek", "[Test]");
      await h.mockMouse.click(test.col, test.row);
      frame = await waitFor(h, (f) => f.includes("no credential, Connect first"));
      expect(frame).toContain("no credential, Connect first");
      expect(calls()).toBe(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
      expect(calls()).toBe(0);
    } finally {
      h.destroy();
    }
  });

  otuiTest("Right moves the row action from Connect to Test; Enter then runs the check without a request", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressArrow("right");
      await h.flush();
      h.mockInput.pressEnter();
      const frame = await waitFor(h, (f) => f.includes("no credential, Connect first"));
      expect(frame).toContain("no credential, Connect first");
      expect(calls()).toBe(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });
});

describe("AC6, AC7 — [Connect] saves, checks /models, returns to Connected and never switches the session", () => {
  otuiTest("a pasted key is saved 0600, /models is checked, the Connected tab lists it, and no frame ever shows the key", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const seen: string[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth !== `Bearer ${SECRET}`) return { ok: false, status: 401, text: async () => "" } as Response;
      return { ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) } as Response;
    }) as unknown as typeof fetch;
    const snap = async (predicate: (f: string) => boolean): Promise<string> => {
      const frame = await waitFor(h, predicate);
      seen.push(frame);
      return frame;
    };
    let settled = false;
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      void pending.then(() => {
        settled = true;
      });
      await snap((f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter(); // [Connect] is the default action
      const keyStep = await snap((f) => f.includes("API key"));
      expect(keyStep).toContain("DeepSeek");

      // The key step shows what is being typed (the field is the one place it
      // is visible); every frame AFTER Enter must be free of it.
      await h.mockInput.typeText(SECRET);
      await h.flush();
      h.mockInput.pressEnter();

      const frame = await snap((f) => f.includes("connected —") && f.includes("[Disconnect]"));
      expect(frame).toContain("DeepSeek connected — 2 model(s)");
      expect(frame).toContain("[Test]");
      expect(frame).toContain("[Add provider]");
      expect(settled).toBe(false); // the session was not switched; the dialog is still open

      // Saved owner-only, in the temp dir, and in exactly one place.
      expect(loadShellConfig(configDir).apiKeys?.DEEPSEEK_API_KEY).toBe(SECRET);
      expect(statSync(shellConfigPath(configDir)).mode & 0o777).toBe(0o600);
      const stored = readFileSync(shellConfigPath(configDir), "utf8");
      expect(stored.split(SECRET).length - 1).toBe(1);

      // Once the step is left, the key is on no frame the operator sees.
      for (const f of seen) expect(f).not.toContain(SECRET);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      h.destroy();
    }
  });

  otuiTest("a rejected key shows the reason, asks again, and the second key connects", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth !== `Bearer ${SECRET}`) return { ok: false, status: 401, text: async () => "" } as Response;
      return { ok: true, json: async () => ({ data: [{ id: "m1" }] }) } as Response;
    }) as unknown as typeof fetch;
    const frames: string[] = [];
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("API key"));
      await h.mockInput.typeText("sk-wrong-key");
      h.mockInput.pressEnter();
      const retry = await waitFor(h, (f) => f.includes("rejected the credential"));
      frames.push(retry);
      expect(retry).toContain("API key");

      await h.mockInput.typeText(SECRET);
      h.mockInput.pressEnter();
      const done = await waitFor(h, (f) => f.includes("connected —") && f.includes("[Disconnect]"));
      frames.push(done);
      expect(done).toContain("DeepSeek connected — 1 model(s)");
      for (const f of frames) {
        expect(f).not.toContain(SECRET);
        expect(f).not.toContain("sk-wrong-key");
      }

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("Esc at the key step returns to the Add tab and saves nothing", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("API key"));
      await h.mockInput.typeText("sk-typed-then-abandoned");

      await pressEscape(h);
      const frame = await waitFor(h, (f) => f.includes("Add custom provider") && !f.includes("API key"));
      expect(frame).toContain("[Connect]");
      expect(frame).not.toContain("sk-typed-then-abandoned");
      expect(loadShellConfig(configDir).apiKeys?.DEEPSEEK_API_KEY).toBeUndefined();
      expect(calls()).toBe(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("a connected provider's [Connect] on the Add tab skips the key step it does not need", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("[Disconnect]"));
      await h.mockInput.pressKeys(["2"]);
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      const frame = await waitFor(h, (f) => f.includes("connected —") && f.includes("[Disconnect]"));
      expect(frame).toContain("DeepSeek connected — 2 model(s)");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });
});

/** Everything outside the frame that a key could reach while the dialog runs: toasts, header, status, title. */
function spyOnChrome(chrome: ShellChrome): string[] {
  const seen: string[] = [];
  for (const name of ["showToast", "setStatus", "setHeaderMeta", "setTitle"] as const) {
    const original = chrome[name].bind(chrome);
    (chrome as unknown as Record<string, (text: string) => void>)[name] = (text: string) => {
      seen.push(text);
      original(text);
    };
  }
  return seen;
}

/** Every piece of text the transcript box holds, walked from its nodes. */
function transcriptText(chrome: ShellChrome): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const candidate = node as { plainText?: unknown; content?: unknown; getChildren?: () => unknown[] };
    if (typeof candidate.plainText === "string") parts.push(candidate.plainText);
    if (typeof candidate.content === "string") parts.push(candidate.content);
    for (const child of candidate.getChildren?.() ?? []) walk(child);
  };
  walk(chrome.transcript);
  return parts.join("\n");
}

/** Wait for the dialog's first frame and make sure the Add tab is showing (it opens on Connected when something is connected). */
async function showAddTab(h: TestSetup): Promise<string> {
  const first = await waitFor(h, (f) => f.includes("Add custom provider") || f.includes("[Disconnect]") || f.includes("[Add provider]"));
  if (first.includes("Add custom provider")) return first;
  await h.mockInput.pressKeys(["a"]);
  return waitFor(h, (f) => f.includes("Add custom provider"));
}

const DEEPSEEK_AT_URL: DetectedProvider = { ...DEEPSEEK, baseUrl: "https://api.deepseek.com" };
const COPILOT: DetectedProvider = { name: "github-copilot", label: "GitHub Copilot", models: ["gpt-4o"] };

describe("review round 2 — the Add tab's other paths", () => {
  otuiTest("a skipped key step does not connect a provider that needs a key", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("API key"));
      h.mockInput.pressEnter(); // empty Enter = skip
      const frame = await waitFor(h, (f) => f.includes("no key entered"));
      expect(frame).toContain("DeepSeek: no key entered");
      expect(frame).toContain("Add custom provider");
      expect(frame).not.toContain("connected —");
      expect(loadShellConfig(configDir).apiKeys?.DEEPSEEK_API_KEY).toBeUndefined();
      expect(calls()).toBe(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("[Test] on the Add tab with a stored credential says ok with the model count", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("[Disconnect]"));
      await h.mockInput.pressKeys(["a"]);
      const frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      const test = locate(frame, "DeepSeek", "[Test]");
      await h.mockMouse.click(test.col, test.row);
      const done = await waitFor(h, (f) => f.includes("ok — 2 model(s)"));
      expect(done).toContain("ok — 2 model(s)");
      expect(calls()).toBeGreaterThan(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("[Test] on the Add tab shows the failure line when the provider refuses the credential", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const fetchFn = (async () => ({ ok: false, status: 401, text: async () => "" }) as Response) as unknown as typeof fetch;
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      const frame = await showAddTab(h);
      const test = locate(frame, "DeepSeek", "[Test]");
      await h.mockMouse.click(test.col, test.row);
      const done = await waitFor(h, (f) => f.includes("rejected the credential"));
      expect(done).toContain("rejected the credential (HTTP 401)");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("Esc at the base-URL step returns to the Add tab and saves nothing", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn, calls } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK_AT_URL], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await showAddTab(h);
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("endpoint URL"));
      await h.mockInput.typeText("-edited");

      await pressEscape(h);
      const frame = await waitFor(h, (f) => f.includes("Add custom provider") && !f.includes("endpoint URL"));
      expect(frame).toContain("[Connect]");
      expect(loadShellConfig(configDir).baseUrls?.deepseek).toBeUndefined();
      expect(calls()).toBe(0);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("Esc at the device-login step returns to the Add tab and saves nothing", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const hanging = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [COPILOT], { onlyConnected: true, fetch: hanging, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("Device login"));

      await pressEscape(h);
      const frame = await waitFor(h, (f) => f.includes("Add custom provider") && !f.includes("Device login"));
      expect(frame).toContain("[Connect]");
      expect(frame).not.toContain("connected —");
      expect(readdirSync(configDir)).toEqual([]);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("Esc in the custom-provider wizard returns to the Add tab and saves nothing", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressArrow("down");
      await h.flush();
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("Provider name"));
      await h.mockInput.typeText("half-typed");

      await pressEscape(h);
      const frame = await waitFor(h, (f) => f.includes("Add custom provider") && !f.includes("Provider name"));
      expect(frame).not.toContain("half-typed");
      expect(readdirSync(configDir)).toEqual([]);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("an endpoint that cannot be reached re-opens the URL step with the reason, and a corrected URL connects", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const fetchFn = (async (input: RequestInfo | URL) => {
      if (!String(input).includes("good")) throw new Error("connect ECONNREFUSED");
      return { ok: true, json: async () => ({ data: [{ id: "m1" }] }) } as Response;
    }) as unknown as typeof fetch;
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK_AT_URL], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await showAddTab(h);
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("endpoint URL"));
      h.mockInput.pressEnter(); // keep the default; it cannot be reached
      const retry = await waitFor(h, (f) => f.includes("could not be reached"));
      expect(retry).toContain("endpoint URL");

      await h.mockInput.typeText("/good");
      h.mockInput.pressEnter();
      const done = await waitFor(h, (f) => f.includes("connected —") || f.includes("could not"));
      expect(done).toContain("DeepSeek connected — 1 model(s)");
      expect(loadShellConfig(configDir).baseUrls?.deepseek).toContain("good");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("a Connect that ends in an error shows the reason on the Add tab and lists nothing as connected", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const fetchFn = (async () => ({ ok: false, status: 500, text: async () => "" }) as Response) as unknown as typeof fetch;
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("API key"));
      await h.mockInput.typeText(SECRET);
      h.mockInput.pressEnter();
      const frame = await waitFor(h, (f) => f.includes("could not list models"));
      expect(frame).toContain("DeepSeek could not list models (HTTP 500)");
      expect(frame).toContain("Add custom provider");
      expect(frame).not.toContain("connected —");
      expect(frame).not.toContain(SECRET);

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });

  otuiTest("Enter on a Connected row picks the provider, then a model, and resolves that selection", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("[Disconnect]"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("m1") && f.includes("m2"));
      h.mockInput.pressEnter();
      const selection = await pending;
      expect(selection?.provider).toBe("deepseek");
      expect(["m1", "m2"]).toContain(selection?.model ?? "");
    } finally {
      h.destroy();
    }
  });

  otuiTest("the typed key is on no channel the shell shows: frames, toasts, header, status or transcript", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const channels = spyOnChrome(h.chrome);
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth !== `Bearer ${SECRET}`) return { ok: false, status: 401, text: async () => "" } as Response;
      return { ok: true, json: async () => ({ data: [{ id: "m1" }] }) } as Response;
    }) as unknown as typeof fetch;
    const frames: string[] = [];
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      await waitFor(h, (f) => f.includes("Add custom provider"));
      h.mockInput.pressEnter();
      await waitFor(h, (f) => f.includes("API key"));
      await h.mockInput.typeText(SECRET);
      h.mockInput.pressEnter();
      frames.push(await waitFor(h, (f) => f.includes("connected —") && f.includes("[Disconnect]")));
      await pressEscape(h);
      expect(await pending).toBeUndefined();
      frames.push(await waitFor(h, () => true));

      for (const frame of frames) expect(frame).not.toContain(SECRET);
      for (const text of channels) expect(text).not.toContain(SECRET);
      expect(transcriptText(h.chrome)).not.toContain(SECRET);
      expect(existsSync(configDir)).toBe(true);
    } finally {
      h.destroy();
    }
  });
});

describe("AC11 — the dialog and its footer fit 80x24", () => {
  const FIT = { width: 80, height: 24 };

  otuiTest("both tabs keep the whole panel on screen and the footer lists the active tab's keys", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui, FIT);
    const { fetchFn } = countingFetch();
    seedConnected(DEEPSEEK, GROQ);
    try {
      const pending = selectProviderModelInTui(otui.core, h.chrome, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: fetchFn, env: {}, configDir });
      let frame = await waitFor(h, (f) => f.includes("[Disconnect]"));
      const panel = h.renderer.root.findDescendantById("modal-panel") as { x: number; y: number; width: number; height: number };
      expect(panel.y).toBeGreaterThanOrEqual(0);
      expect(panel.y + panel.height).toBeLessThanOrEqual(FIT.height);
      expect(panel.x + panel.width).toBeLessThanOrEqual(FIT.width);
      expect(frame).toContain("DeepSeek");
      expect(frame).toContain("Groq");
      expect(frame).toContain("Enter run"); // the Connected footer's own keys
      expect(frame).toContain("a add");

      await h.mockInput.pressKeys(["2"]);
      frame = await waitFor(h, (f) => f.includes("Add custom provider"));
      const after = h.renderer.root.findDescendantById("modal-panel") as { y: number; height: number };
      expect(after.y + after.height).toBeLessThanOrEqual(FIT.height);
      expect(frame).toContain("Enter run");
      expect(frame).toContain("←/→ Connect/Test"); // the Add footer names its own keys
      expect(frame).not.toContain("a add");
      expect(frame).toContain("[Connect]");

      await pressEscape(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.destroy();
    }
  });
});
