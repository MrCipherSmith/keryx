import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchProviderWizardInTui, selectProviderModelInTui } from "./tui-shell";
import { createShellChrome, type ShellChrome } from "./shell-chrome";
import { commandsForMode } from "../commands/agent-commands";
import type { DetectedProvider } from "../commands/select";
import type { SearchProviderController, SearchProviderDescriptor } from "../harness/search";

// Flow 270: inside the running shell both wizards render every step in
// ModalHost — header and sidebar stay on screen, nothing is mounted as a
// full-screen overlay on the renderer root. The bare-renderer path (startup
// picker, chat shell) is covered by the existing tui-shell and
// provider-endpoint-retry tests, unchanged.

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

/** OpenTUI holds a lone ESC this long to tell it from an escape sequence. */
const ESC_PARSER_TIMEOUT_MS = 50;

async function mountChrome(otui: OtuiBundle): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: 120, height: 40 });
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

/** Every wizard step is a ModalHost dialog inside the shell, never a root overlay. */
function expectStepInModal(h: TestSetup & { chrome: ShellChrome }, overlayId: string): void {
  const root = h.renderer.root;
  expect(root.findDescendantById("modal-backdrop")?.visible).toBe(true);
  expect(root.findDescendantById("header")).toBeDefined();
  expect(root.findDescendantById("sidebar")).toBeDefined();
  // The overlay form of the step mounts a box with this id on the root.
  expect(root.findDescendantById(overlayId)).toBeUndefined();
}

const ENV_KEY = "KERYX_FLOW270_TEST_KEY";
const PROVIDER: DetectedProvider = {
  name: "flow270-acme",
  label: "Acme (flow 270)",
  models: ["acme-small", "acme-large"],
  envKey: ENV_KEY,
};

let configDir: string | undefined;
afterEach(() => {
  delete process.env[ENV_KEY];
  if (configDir !== undefined) {
    rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
  }
});

describe("flow 270: /provider wizard steps render in ModalHost", () => {
  otuiTest("AC1: provider → API key → model, each step a dialog inside the shell", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    configDir = mkdtempSync(join(tmpdir(), "keryx-f270-"));

    const result = selectProviderModelInTui(otui.core, h.chrome, [PROVIDER], { env: {}, configDir });
    await h.flush();
    let frame = h.captureCharFrame();
    expect(frame).toContain("Select a provider");
    expect(frame).toContain("Acme (flow 270)");
    expectStepInModal(h, "picker");

    h.mockInput.pressEnter(); // Acme is first
    await h.flush();
    frame = h.captureCharFrame();
    expect(frame).toContain("Paste your Acme (flow 270) API key");
    expect(frame).toContain("esc back");
    expectStepInModal(h, "key-picker");

    // AC4: ←/→ move the cursor inside the field instead of switching tabs.
    await h.mockInput.typeText("abc");
    h.mockInput.pressArrow("left");
    await h.mockInput.typeText("Z");
    await h.flush();
    const keyInput = h.renderer.root.findDescendantById("kp-input") as { value: string } | undefined;
    expect(keyInput?.value).toBe("abZc");

    h.mockInput.pressEnter();
    await h.flush();
    frame = h.captureCharFrame();
    expect(frame).toContain("Select a model");
    expect(frame).toContain("acme-small");
    expectStepInModal(h, "model-picker");

    h.mockInput.pressEnter();
    await h.flush();
    expect(await result).toEqual({ provider: "flow270-acme", model: "acme-small" });
    expect(h.renderer.root.findDescendantById("modal-backdrop")?.visible).toBe(false);
    h.destroy();
  });

  otuiTest("AC4: Esc on the key step goes back to the provider list; Esc there cancels", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    configDir = mkdtempSync(join(tmpdir(), "keryx-f270-"));

    const result = selectProviderModelInTui(otui.core, h.chrome, [PROVIDER], { env: {}, configDir });
    await h.flush();
    h.mockInput.pressEnter();
    await h.flush();
    expect(h.captureCharFrame()).toContain("API key");

    await pressEscape(h);
    const frame = h.captureCharFrame();
    expect(frame).toContain("Select a provider");
    expectStepInModal(h, "picker");

    await pressEscape(h);
    expect(await result).toBeUndefined();
    expect(h.chrome.overlayActive()).toBe(false);
    h.destroy();
  });

  // Found on a live pty: the provider dialog re-opened after Esc on the URL
  // step, focused and working, but nothing redrew the screen, so it was
  // invisible and the next Esc closed a dialog nobody could see.
  otuiTest("AC4: Esc on the URL step shows the provider list again without any other redraw", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    configDir = mkdtempSync(join(tmpdir(), "keryx-f270-"));

    const withUrl: DetectedProvider = { ...PROVIDER, baseUrl: "http://localhost:9" };
    const result = selectProviderModelInTui(otui.core, h.chrome, [withUrl], { env: {}, configDir });
    await h.flush();
    h.mockInput.pressEnter();
    await h.flush();
    expect(h.captureCharFrame()).toContain("endpoint URL");

    await pressEscape(h);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.flush();
    expect(h.captureCharFrame()).toContain("Select a provider");

    await pressEscape(h);
    expect(await result).toBeUndefined();
    h.destroy();
  });
});

const BRAVE: SearchProviderDescriptor = {
  id: "brave",
  displayName: "Brave Search API",
  kind: "remote",
  fields: [],
  defaults: {},
  credentialSchema: { required: true, label: "Brave Search API key", secret: true },
  documentationUrl: "https://api.search.brave.com/app/documentation",
  capabilities: { localLoopback: false, supportsPublicationDate: false },
  testConnection: async () => ({ ok: true }),
  search: async () => ({ query: "", results: [] }),
};

function fakeController(): { controller: SearchProviderController; calls: string[] } {
  const calls: string[] = [];
  const fake = {
    configurable: () => [BRAVE],
    configure: (id: string) => {
      calls.push(`configure:${id}`);
    },
    test: async (id: string) => {
      calls.push(`test:${id}`);
      return { ok: true };
    },
    select: async (id: string) => {
      calls.push(`select:${id}`);
      return { ok: true };
    },
  };
  // A structural fake of the public members the wizard calls, as in tui-shell.test.ts.
  return { controller: fake as unknown as SearchProviderController, calls };
}

describe("flow 270: /search-provider wizard steps render in ModalHost", () => {
  otuiTest("AC2: provider → credential → active toggle → test, each step a dialog inside the shell", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { controller, calls } = fakeController();

    const done = searchProviderWizardInTui(otui.core, h.chrome, controller);
    await h.flush();
    expect(h.captureCharFrame()).toContain("Select a search provider");
    expectStepInModal(h, "search-provider-picker");

    h.mockInput.pressEnter();
    await h.flush();
    expect(h.captureCharFrame()).toContain("Paste your Brave Search API key");
    expectStepInModal(h, "search-credential-picker");

    await h.mockInput.typeText("secret");
    h.mockInput.pressEnter();
    await h.flush();
    expect(h.captureCharFrame()).toContain("Set as active provider");
    expectStepInModal(h, "search-active-picker");

    h.mockInput.pressEnter(); // "Yes"
    await h.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.flush();
    const testFrame = h.captureCharFrame();
    expect(testFrame).toContain("configured, tested, and set as active");
    expectStepInModal(h, "search-test-picker");

    h.mockInput.pressEnter();
    await done;
    expect(calls).toEqual(["configure:brave", "test:brave", "select:brave"]);
    expect(h.renderer.root.findDescendantById("modal-backdrop")?.visible).toBe(false);
    h.destroy();
  });

  otuiTest("AC4: Esc on the credential step goes back to the provider list", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const { controller, calls } = fakeController();

    const done = searchProviderWizardInTui(otui.core, h.chrome, controller);
    await h.flush();
    h.mockInput.pressEnter();
    await h.flush();
    expect(h.captureCharFrame()).toContain("Paste your");

    await pressEscape(h);
    expect(h.captureCharFrame()).toContain("Select a search provider");

    await pressEscape(h);
    await done;
    expect(calls).toEqual([]);
    h.destroy();
  });
});

// --- flow 270 review round 1 ------------------------------------------------

describe("flow 270 review: nothing leaks out of a wizard between or after steps", () => {
  // F-001: each step's dialog used to close with focus restored to the
  // composer, so text typed while the wizard awaited the network was
  // submitted as a turn.
  otuiTest("while the wizard awaits the model list, the composer is not focused and Enter submits nothing", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    configDir = mkdtempSync(join(tmpdir(), "keryx-f270-"));
    const submitted: string[] = [];
    h.chrome.onSubmit((line) => submitted.push(line));
    const deepseek: DetectedProvider = {
      name: "deepseek",
      label: "DeepSeek",
      models: ["deepseek-chat"],
      baseUrl: "https://api.deepseek.test",
      envKey: "DEEPSEEK_API_KEY",
    };
    const neverAnswers = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    void selectProviderModelInTui(otui.core, h.chrome, [deepseek], {
      env: { DEEPSEEK_API_KEY: "k" },
      fetch: neverAnswers,
      configDir,
    });
    await h.flush();
    h.mockInput.pressEnter(); // provider
    await h.flush();
    expect(h.captureCharFrame()).toContain("endpoint URL");
    h.mockInput.pressEnter(); // keep the URL → the model list is now being fetched
    await h.flush();

    expect(h.renderer.currentFocusedRenderable?.id).not.toBe("prompt");
    await h.mockInput.typeText("hello");
    h.mockInput.pressEnter();
    await h.flush();
    expect(submitted).toEqual([]);
    h.destroy();
  });

  // F-002: Esc while the connection test was running went back to the
  // fields, but the test carried on and set the provider active anyway.
  otuiTest("Esc during a running search-provider test leaves it inactive and throws nothing", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    const calls: string[] = [];
    let finishTest: ((result: { ok: true }) => void) | undefined;
    const controller = {
      configurable: () => [BRAVE],
      configure: (id: string) => {
        calls.push(`configure:${id}`);
      },
      test: (id: string) => {
        calls.push(`test:${id}`);
        return new Promise<{ ok: true }>((resolve) => {
          finishTest = resolve;
        });
      },
      select: async (id: string) => {
        calls.push(`select:${id}`);
        return { ok: true };
      },
    } as unknown as SearchProviderController;

    void searchProviderWizardInTui(otui.core, h.chrome, controller);
    await h.flush();
    h.mockInput.pressEnter(); // brave
    await h.flush();
    await h.mockInput.typeText("secret");
    h.mockInput.pressEnter(); // credential
    await h.flush();
    h.mockInput.pressEnter(); // "Yes" → the test starts
    await h.flush();
    expect(h.captureCharFrame()).toContain("Testing 'brave'");

    await pressEscape(h); // back out mid-test
    finishTest?.({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.flush();

    expect(calls).toEqual(["configure:brave", "test:brave"]); // no select()
    // "retry" restarts the fields from their first sub-step — brave's credential.
    expect(h.captureCharFrame()).toContain("Paste your Brave Search API key");
    h.destroy();
  });
});
