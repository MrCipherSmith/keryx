// A typo'd endpoint was a dead end in `/provider`.
//
// The operator edited the base URL, got it slightly wrong, and the picker
// answered with an empty model list and no way back to the URL step: the only
// exits were Esc (losing the provider choice) or picking nothing. The endpoint
// is the operator's own input and the one thing they can fix on the spot, so
// the picker now re-opens that step carrying the provider's own words.
//
// The discipline this file pins is NOT "retry on any empty list" — that was the
// original shape of this fix, and it would now fire on a refused credential
// (which the key step handles) and on a provider that honestly has no models
// (where the URL is already right). `endpointMayBeAtFault` draws that line and
// the tests below hold it from both sides.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedProvider } from "../commands/select";
import { endpointMayBeAtFault, selectProviderModelInTui } from "./tui-shell";

// Same module-cycle-safe load + hard skip as `model-picker-notice.test.ts`: an
// absent optional native dependency must SKIP (which CI fails on), not pass.
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

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): NonNullable<Awaited<ReturnType<typeof loadOpenTui>>> {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without the optional TUI dependency");
  }
  return OTUI;
}

/** A bare Esc is only distinguishable from an escape SEQUENCE after the parser times out. */
const ESC_PARSER_TIMEOUT_MS = 50;

async function pressEscapeAndSettle(h: {
  mockInput: { pressEscape: () => void };
  flush: () => Promise<unknown>;
}): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

/**
 * Replace an input's contents rather than appending to them.
 *
 * The endpoint step seeds the field with the CURRENT base URL, and `typeText`
 * appends — typing a corrected URL straight in produces the two concatenated,
 * which is still a broken endpoint and hides whether the retry actually works.
 */
async function replaceInputWith(
  h: { mockInput: { pressKey: (key: string) => void; typeText: (text: string) => Promise<void> } },
  text: string,
  seededLength: number,
): Promise<void> {
  h.mockInput.pressKey("END");
  for (let i = 0; i < seededLength; i += 1) {
    h.mockInput.pressKey("BACKSPACE");
  }
  await h.mockInput.typeText(text);
}

// A registered OpenAI-compat provider, because only those probe `/models` at
// all (`resolveModelsForPicker` returns the curated list untouched for the
// rest, and an unprobed provider has no failure to react to). `baseUrl` on the
// DETECTED entry overrides the registry's, which is exactly how a typo'd
// endpoint reaches the resolver in real use.
const TYPO_URL = "https://typo.example.invalid";
const GOOD_URL = "https://api.deepseek.com";

const DEEPSEEK: DetectedProvider = {
  name: "deepseek",
  label: "DeepSeek",
  models: ["deepseek-chat"],
  baseUrl: TYPO_URL,
  envKey: "DEEPSEEK_API_KEY",
};

// A key IS present so the credential step is skipped on the way in: this file
// is about the endpoint, and an unrelated key prompt would sit between the
// base-URL step and the probe.
const ENV = { DEEPSEEK_API_KEY: "test-key" };

describe("endpointMayBeAtFault — only the kinds a different URL could fix", () => {
  test("nothing answered, or the wrong thing answered: the URL is suspect", () => {
    expect(endpointMayBeAtFault({ kind: "unreachable", detail: "ECONNREFUSED" })).toBe(true);
    expect(endpointMayBeAtFault({ kind: "http", status: 404 })).toBe(true);
  });

  test("BOUNDARY — a refused credential is not the endpoint's fault", () => {
    // The endpoint was found and it spoke; it just refused the key. Re-opening
    // the URL step here would walk the operator away from the actual fix.
    expect(endpointMayBeAtFault({ kind: "rejected", status: 401 })).toBe(false);
  });

  test("BOUNDARY — an honest empty catalogue is not the endpoint's fault", () => {
    expect(endpointMayBeAtFault({ kind: "empty" })).toBe(false);
  });

  test("BOUNDARY — no failure at all never re-opens the step", () => {
    // An offline `fake`/`ollama` entry that never probed reaches the picker
    // with no failure recorded. Nothing was attempted, so nothing is suspect.
    expect(endpointMayBeAtFault(undefined)).toBe(false);
  });
});

describe("REGRESSION — an unreachable endpoint re-opens the URL step", () => {
  otuiTest("the reason is shown, the corrected URL is probed, and the models arrive", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    // `configDir` is threaded so this test cannot write to the machine running
    // it — same reasoning as `model-picker-notice.test.ts`.
    const configDir = await mkdtemp(join(tmpdir(), "keryx-endpoint-"));
    const probed: string[] = [];
    const flaky = (async (input: string | URL) => {
      const url = String(input);
      probed.push(url);
      if (url.includes("typo.example.invalid")) {
        // Nothing answers at the typo'd host: `fetch` rejects, which the
        // resolver records as `unreachable`.
        throw new Error("getaddrinfo ENOTFOUND typo.example.invalid");
      }
      return new Response(JSON.stringify({ data: [{ id: "deepseek-reasoner" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const resultPromise = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], {
        fetch: flaky,
        env: ENV,
        configDir,
      });

      await h.waitForFrame((f) => f.includes("DeepSeek"));
      h.mockInput.pressEnter(); // provider step → DeepSeek

      await h.waitForFrame((f) => f.includes("typo.example.invalid"));
      h.mockInput.pressEnter(); // base-URL step → keep the (wrong) endpoint

      // The probe failed, so the endpoint step comes BACK, and it says why
      // rather than dropping the operator on an empty list.
      const retryFrame = await h.waitForFrame((f) => f.includes("could not be reached"));
      expect(retryFrame).toContain("DeepSeek endpoint URL");
      expect(retryFrame).toContain("ENOTFOUND");

      // Correct the host and let it through.
      await replaceInputWith(h, GOOD_URL, TYPO_URL.length);
      h.mockInput.pressEnter();

      const modelsFrame = await h.waitForFrame((f) => f.includes("deepseek-reasoner"));
      expect(modelsFrame).toContain("deepseek-reasoner");

      // Both endpoints were actually tried — the retry re-probed rather than
      // reusing the first, failed answer.
      expect(probed.some((u) => u.includes("typo.example.invalid"))).toBe(true);
      expect(probed.some((u) => u.includes("api.deepseek.com"))).toBe(true);

      h.mockInput.pressEnter(); // model step → deepseek-reasoner
      const result = await resultPromise;
      // The corrected endpoint is what the caller is handed back, not the typo.
      expect(result).toEqual({ provider: "deepseek", model: "deepseek-reasoner", baseUrl: GOOD_URL });
    } finally {
      h.renderer.destroy();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  otuiTest("Esc at the re-opened URL step goes back to the provider list, not onward", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const configDir = await mkdtemp(join(tmpdir(), "keryx-endpoint-"));
    const refusing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND typo.example.invalid");
    }) as unknown as typeof fetch;

    try {
      const resultPromise = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], {
        fetch: refusing,
        env: ENV,
        configDir,
      });

      await h.waitForFrame((f) => f.includes("DeepSeek"));
      h.mockInput.pressEnter();
      await h.waitForFrame((f) => f.includes("typo.example.invalid"));
      h.mockInput.pressEnter();
      // BOTH conditions, deliberately: "endpoint URL" alone also matches the
      // FIRST pass through this step (before anything was probed), and "could
      // not be reached" alone also matches the model picker carrying that
      // sentence as a notice. Only the re-opened endpoint step shows both.
      const retryFrame = await h.waitForFrame((f) => f.includes("endpoint URL") && f.includes("could not be reached"));
      expect(retryFrame).not.toContain("Select a model");

      // Backing out of the endpoint step must NOT fall through to a model
      // picker built from the failed probe.
      await pressEscapeAndSettle(h);
      await h.waitForFrame((f) => f.includes("Select a provider"));
      await pressEscapeAndSettle(h);
      expect(await resultPromise).toBeUndefined();
    } finally {
      h.renderer.destroy();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe("BOUNDARY — the endpoint step stays shut when the URL is not the problem", () => {
  otuiTest("an honestly empty catalogue goes straight to the picker's notice", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const configDir = await mkdtemp(join(tmpdir(), "keryx-endpoint-"));
    let probes = 0;
    const empty = (async () => {
      probes += 1;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const resultPromise = selectProviderModelInTui(otui.core, h.renderer, [{ ...DEEPSEEK, baseUrl: GOOD_URL }], {
        fetch: empty,
        env: ENV,
        configDir,
      });

      await h.waitForFrame((f) => f.includes("DeepSeek"));
      h.mockInput.pressEnter();
      await h.waitForFrame((f) => f.includes("api.deepseek.com"));
      h.mockInput.pressEnter();

      // The endpoint answered correctly — it simply has nothing to offer. The
      // operator gets that sentence, NOT a second round of URL editing.
      const frame = await h.waitForFrame((f) => f.includes("reports no models"));
      expect(frame).not.toContain("endpoint URL");
      expect(probes).toBe(1);

      await pressEscapeAndSettle(h);
      await h.waitForFrame((f) => f.includes("Select a provider"));
      await pressEscapeAndSettle(h);
      expect(await resultPromise).toBeUndefined();
    } finally {
      h.renderer.destroy();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
