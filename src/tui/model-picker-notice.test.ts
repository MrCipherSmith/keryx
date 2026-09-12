// "(no models found)" was the only thing `/provider` could say.
//
// The operator picked a provider, was asked nothing, and got an empty list.
// What had actually happened was that `api.x.ai` answered 403 — the stored
// grok login had expired — and the picker had no vocabulary for that. Worse,
// the dead value in `env` was itself the reason the key step never ran: the
// wizard asked for a credential only when it held none, so the one credential
// that needed replacing was the one it would never ask about.
//
// This file pins both halves: the picker SAYS why it is empty, and a refused
// credential re-opens the key step carrying the provider's own words.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedProvider } from "../commands/select";
import { modelPickerNotice, pickModelInTui, selectProviderModelInTui } from "./tui-shell";

// Same module-cycle-safe load + hard skip as `tui-shell.test.ts`: an absent
// optional native dependency must SKIP (which CI fails on) rather than pass.
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
const ESC_PARSER_TIMEOUT_MS = 20;

async function pressEscapeAndSettle(h: {
  mockInput: { pressEscape: () => void };
  flush: () => Promise<unknown>;
}): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

describe("modelPickerNotice — a notice exists only when there is something to explain", () => {
  test("an empty list with a refused credential explains itself", () => {
    expect(
      modelPickerNotice("xAI (Grok)", {
        models: [],
        source: "fallback",
        failure: { kind: "rejected", status: 403, detail: "The OAuth2 access token could not be validated." },
      }),
    ).toBe("xAI (Grok) rejected the credential (HTTP 403) — The OAuth2 access token could not be validated.");
  });

  test("BOUNDARY — a non-empty list gets no notice, however it was obtained", () => {
    expect(
      modelPickerNotice("Example", { models: ["m-1"], source: "live" }),
    ).toBeUndefined();
    // A failure alongside models would be a contradiction, but if one ever
    // appears the models win: the operator can pick one.
    expect(
      modelPickerNotice("Example", { models: ["m-1"], source: "fallback", failure: { kind: "empty" } }),
    ).toBeUndefined();
  });

  test("an empty list that never probed says nothing rather than inventing a cause", () => {
    expect(modelPickerNotice("ollama", { models: [], source: "fallback" })).toBeUndefined();
  });
});

describe("pickModelInTui renders the reason instead of a mute empty list", () => {
  otuiTest("the notice is painted, and replaces '(no models found)'", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const notice = "xAI (Grok) rejected the credential (HTTP 403) — The OAuth2 access token could not be validated.";

    const resultPromise = pickModelInTui(otui.core, h.renderer, [], notice);
    const frame = await h.waitForFrame((f) => f.includes("rejected the credential"));
    expect(frame).toContain("HTTP 403");
    expect(frame).not.toContain("(no models found)");

    await pressEscapeAndSettle(h);
    expect(await resultPromise).toBeUndefined();
    h.renderer.destroy();
  });

  otuiTest("BOUNDARY — with no notice the old wording still stands", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });

    const resultPromise = pickModelInTui(otui.core, h.renderer, []);
    const frame = await h.waitForFrame((f) => f.includes("(no models found)"));
    expect(frame).toContain("Select a model");

    await pressEscapeAndSettle(h);
    expect(await resultPromise).toBeUndefined();
    h.renderer.destroy();
  });

  otuiTest("a notice never displaces real models", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });

    const resultPromise = pickModelInTui(otui.core, h.renderer, ["deepseek-chat"], "should not appear");
    const frame = await h.waitForFrame((f) => f.includes("deepseek-chat"));
    expect(frame).not.toContain("should not appear");

    await pressEscapeAndSettle(h);
    expect(await resultPromise).toBeUndefined();
    h.renderer.destroy();
  });
});

describe("REGRESSION — a refused credential re-opens the key step", () => {
  const DEEPSEEK: DetectedProvider = {
    name: "deepseek",
    label: "DeepSeek",
    models: ["deepseek-chat"],
    baseUrl: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
  };

  otuiTest("a stale saved key no longer locks the operator out of replacing it", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    // `configDir` is threaded so this test cannot write to the machine running
    // it: `keryxConfigDir` honours XDG_DATA_HOME on Linux only, so an env-var
    // seam would still reach ~/.local/share/keryx on a developer's Mac.
    const configDir = await mkdtemp(join(tmpdir(), "keryx-picker-"));

    let probes = 0;
    const refusing = (async () => {
      probes += 1;
      return new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 });
    }) as unknown as typeof fetch;

    try {
      const resultPromise = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], {
        fetch: refusing,
        // A value IS present — the exact state that used to skip the key step
        // and leave the operator staring at an empty model list.
        env: { DEEPSEEK_API_KEY: "stale-and-refused" },
        configDir,
      });

      await h.waitForFrame((f) => f.includes("DeepSeek"));
      h.mockInput.pressEnter(); // provider step → DeepSeek
      await h.waitForFrame((f) => f.includes("api.deepseek.com"));
      h.mockInput.pressEnter(); // base-URL step → keep the endpoint

      // No key was asked for on the way in. The 401 is what brings the step back.
      const keyFrame = await h.waitForFrame((f) => f.includes("Paste your DeepSeek API key"));
      expect(keyFrame).toContain("rejected the credential");
      expect(keyFrame).toContain("HTTP 401");
      expect(keyFrame).toContain("Incorrect API key provided");
      expect(probes).toBe(1);

      // Esc backs out to the provider step (and never persists anything);
      // a second Esc cancels the wizard.
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
