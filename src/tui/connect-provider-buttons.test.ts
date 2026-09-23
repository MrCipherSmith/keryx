// flow 304: `/connect`'s row list gets `[Test]`/`[Disconnect]` buttons drawn
// like the queue dock's Force/Edit/Delete (AC1-AC4, AC7, AC10). The pure
// classify/probe/remove logic these buttons call is covered in
// `src/commands/providers.disconnect.test.ts`; this file drives the actual
// mouse/keyboard surface, following `provider-endpoint-retry.test.ts` and
// `picker-theme.test.ts`'s own established harness (never a replica of the
// shipped picker — the real `selectProviderModelInTui`, mounted).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { DetectedProvider } from "../commands/select";
import { loadShellConfig, saveApiKey } from "../lib/shell-config";
import { themeColorToHex } from "./shell-chrome";
import { applyThemeId, getThemeId, resolveTheme } from "./theme";
import { selectProviderModelInTui } from "./tui-shell";

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "keryx-connect-buttons-"));
}

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
const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

const ESC_PARSER_TIMEOUT_MS = 50;

async function pressEscapeAndSettle(h: { mockInput: { pressEscape: () => void }; flush: () => Promise<unknown> }): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

/** Column of `needle` within the frame LINE that contains `rowNeedle`, or -1 if either is absent. */
function columnOnRow(frame: string, rowNeedle: string, needle: string): { row: number; col: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(rowNeedle));
  if (row < 0) return { row: -1, col: -1 };
  const col = lines[row]!.indexOf(needle);
  return { row, col: col < 0 ? -1 : col + 1 };
}

const DEEPSEEK: DetectedProvider = { name: "deepseek", label: "DeepSeek", models: ["deepseek-chat"], envKey: "DEEPSEEK_API_KEY" };
const GROQ: DetectedProvider = { name: "groq", label: "Groq", models: ["llama-3.3-70b-versatile"], envKey: "GROQ_API_KEY" };
const ENV = { DEEPSEEK_API_KEY: "sk-test", GROQ_API_KEY: "gsk-test" };

/** Always answers a live, non-empty model list — both providers pass `filterConnectedDetectedProviders`'s own probe. */
const alwaysLive = (async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) }) as Response) as unknown as typeof fetch;

describe("AC1 — /connect's row list draws Test and Disconnect on every connected row", () => {
  otuiTest("both buttons render for every connected provider, label/click selection unchanged", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    try {
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: alwaysLive, env: ENV });
      const frame = await h.waitForFrame((f) => f.includes("DeepSeek") && f.includes("Groq"));
      const dsRow = columnOnRow(frame, "DeepSeek", "[Test]");
      const dsDisc = columnOnRow(frame, "DeepSeek", "[Disconnect]");
      const groqRow = columnOnRow(frame, "Groq", "[Test]");
      const groqDisc = columnOnRow(frame, "Groq", "[Disconnect]");
      expect(dsRow.col).toBeGreaterThan(0);
      expect(dsDisc.col).toBeGreaterThan(0);
      expect(groqRow.col).toBeGreaterThan(0);
      expect(groqDisc.col).toBeGreaterThan(0);

      // Clicking the LABEL still selects the provider — unchanged from the old `SelectRenderable` behaviour.
      const mouse = otui.testing.createMockMouse(h.renderer);
      const labelCol = columnOnRow(frame, "DeepSeek", "DeepSeek");
      await mouse.click(labelCol.col, labelCol.row);
      await h.flush();
      await h.waitForFrame((f) => f.includes("Select a model"));
      h.mockInput.pressEnter(); // model step
      const result = await pending;
      expect(result?.provider).toBe("deepseek");
    } finally {
      h.renderer.destroy();
    }
  });
});

describe("AC2 — [Test] runs the live probe and shows ok/failure inline, without leaving /connect", () => {
  otuiTest("mouse click on [Test]: success shows ok + model count", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    try {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) } as Response;
      }) as unknown as typeof fetch;
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: ENV });
      const frame = await h.waitForFrame((f) => f.includes("[Test]"));
      const testBtn = columnOnRow(frame, "DeepSeek", "[Test]");
      const mouse = otui.testing.createMockMouse(h.renderer);
      await mouse.click(testBtn.col, testBtn.row);
      const okFrame = await h.waitForFrame((f) => f.includes("ok — 2 model"));
      expect(okFrame).toContain("ok — 2 model");
      expect(calls).toBeGreaterThanOrEqual(2); // the connected-filter probe, then the Test click

      await pressEscapeAndSettle(h);
      expect(await pending).toBeUndefined(); // stayed in /connect the whole time; Esc is what finally leaves
    } finally {
      h.renderer.destroy();
    }
  });

  otuiTest("mouse click on [Test]: a now-broken connection shows the humanized failure reason", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    try {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        if (calls === 1) {
          // The initial `filterConnectedDetectedProviders` probe: was connected.
          return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
        }
        // The [Test] click's own probe: the credential has since been revoked.
        return { ok: false, status: 401, text: async () => "" } as Response;
      }) as unknown as typeof fetch;
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: ENV });
      const frame = await h.waitForFrame((f) => f.includes("[Test]"));
      const testBtn = columnOnRow(frame, "DeepSeek", "[Test]");
      const mouse = otui.testing.createMockMouse(h.renderer);
      await mouse.click(testBtn.col, testBtn.row);
      const failFrame = await h.waitForFrame((f) => f.includes("rejected the credential"));
      expect(failFrame).toContain("HTTP 401");

      await pressEscapeAndSettle(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.renderer.destroy();
    }
  });
});

describe("AC3 — rows and both buttons reach without a mouse", () => {
  otuiTest("Right lands on Test; Enter runs it; Right again arms Disconnect", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    // Hermetic: arming now classifies the credential (flow 304 review #2),
    // which reads the config dir — never the real machine's.
    const configDir = tempConfigDir();
    try {
      const fetchFn = (async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }] }) }) as Response) as unknown as typeof fetch;
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], { onlyConnected: true, fetch: fetchFn, env: ENV, configDir });
      await h.waitForFrame((f) => f.includes("[Test]"));

      h.mockInput.pressArrow("right"); // Label -> Test
      h.mockInput.pressEnter(); // fires Test
      const okFrame = await h.waitForFrame((f) => f.includes("ok — 1 model"));
      expect(okFrame).toContain("ok — 1 model");

      h.mockInput.pressArrow("right"); // Test -> Disconnect
      h.mockInput.pressEnter(); // arms
      const armedFrame = await h.waitForFrame((f) => f.includes("disconnect 'DeepSeek'?"));
      expect(armedFrame).toContain("Esc to cancel");

      // flow 304 review finding #4: Esc while armed cancels ONLY the arm —
      // the step stays open. A SECOND Esc is what finally leaves.
      await pressEscapeAndSettle(h);
      const clearedFrame = h.captureCharFrame();
      expect(clearedFrame).not.toContain("disconnect 'DeepSeek'?");
      expect(clearedFrame).toContain("[Disconnect]"); // still here — the step did not close
      await pressEscapeAndSettle(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.renderer.destroy();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // flow 304 review finding #4, isolated: Esc's FIRST job is cancelling an
  // armed Disconnect, matching the hint text "Esc to cancel" literally —
  // it does not, on its own, leave `/connect`.
  otuiTest("Esc while Disconnect is armed cancels the arm and keeps the picker open; nothing is written", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const configDir = tempConfigDir();
    saveApiKey("DEEPSEEK_API_KEY", "sk-real", configDir); // a real credential that a wrongly-confirmed Esc could remove
    try {
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], { onlyConnected: true, fetch: alwaysLive, env: ENV, configDir });
      const frame = await h.waitForFrame((f) => f.includes("[Disconnect]"));
      const disc = columnOnRow(frame, "DeepSeek", "[Disconnect]");
      const mouse = otui.testing.createMockMouse(h.renderer);
      await mouse.click(disc.col, disc.row); // arm, by mouse this time
      await h.waitForFrame((f) => f.includes("disconnect 'DeepSeek'?"));

      await pressEscapeAndSettle(h); // cancel the arm only
      const afterOneEsc = h.captureCharFrame();
      expect(afterOneEsc).not.toContain("disconnect 'DeepSeek'?");
      expect(afterOneEsc).toContain("DeepSeek"); // row still here, step still open
      expect(loadShellConfig(configDir).apiKeys).toEqual({ DEEPSEEK_API_KEY: "sk-real" }); // untouched

      await pressEscapeAndSettle(h); // NOW leave
      expect(await pending).toBeUndefined();
    } finally {
      h.renderer.destroy();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  otuiTest("Down moves to the second row; Enter on Label there selects THAT provider", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    try {
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK, GROQ], { onlyConnected: true, fetch: alwaysLive, env: ENV });
      await h.waitForFrame((f) => f.includes("Groq"));

      h.mockInput.pressArrow("down"); // row 0 -> row 1 (Groq)
      h.mockInput.pressEnter(); // Label column (default) -> select Groq
      await h.waitForFrame((f) => f.includes("Select a model"));
      h.mockInput.pressEnter(); // model step
      const result = await pending;
      expect(result?.provider).toBe("groq");
    } finally {
      h.renderer.destroy();
    }
  });
});

describe("AC4 — [Disconnect] asks for confirmation; declining writes nothing", () => {
  otuiTest("clicking Disconnect once arms it; clicking Test on the SAME row cancels the arm (decline)", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    let disconnected: string | undefined;
    try {
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], {
        onlyConnected: true,
        fetch: alwaysLive,
        env: ENV,
        onDisconnected: (name) => {
          disconnected = name;
        },
      });
      const frame = await h.waitForFrame((f) => f.includes("[Disconnect]"));
      const disc = columnOnRow(frame, "DeepSeek", "[Disconnect]");
      const mouse = otui.testing.createMockMouse(h.renderer);
      await mouse.click(disc.col, disc.row);
      const armedFrame = await h.waitForFrame((f) => f.includes("disconnect 'DeepSeek'?"));
      const test = columnOnRow(armedFrame, "DeepSeek", "[Test]");

      // DECLINE: click [Test] on the same row instead of confirming.
      await mouse.click(test.col, test.row);
      await h.waitForFrame((f) => f.includes("ok — 2 model"));

      // Nothing was removed: the row is still here, onDisconnected never fired.
      expect(disconnected).toBeUndefined();
      const stillHere = h.captureCharFrame();
      expect(stillHere).toContain("DeepSeek");
      expect(stillHere).toContain("[Disconnect]");

      await pressEscapeAndSettle(h);
      expect(await pending).toBeUndefined();
    } finally {
      h.renderer.destroy();
    }
  });

  otuiTest("clicking Disconnect TWICE confirms: the row disappears, the key is gone from disk, and onDisconnected fires with its name", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const configDir = tempConfigDir();
    // A REAL keryx-saved credential — not merely present in the injected
    // `env` — so classification resolves to `saved-api-key` and confirming
    // actually has something to remove, the same as a real `/connect` row.
    saveApiKey("DEEPSEEK_API_KEY", "sk-test", configDir);
    let disconnected: string | undefined;
    try {
      const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK, GROQ], {
        onlyConnected: true,
        fetch: alwaysLive,
        env: ENV,
        configDir,
        onDisconnected: (name) => {
          disconnected = name;
        },
      });
      const frame = await h.waitForFrame((f) => f.includes("DeepSeek") && f.includes("Groq"));
      const disc = columnOnRow(frame, "DeepSeek", "[Disconnect]");
      const mouse = otui.testing.createMockMouse(h.renderer);
      await mouse.click(disc.col, disc.row);
      const armedFrame = await h.waitForFrame((f) => f.includes("disconnect 'DeepSeek'?"));
      const discAgain = columnOnRow(armedFrame, "DeepSeek", "[Disconnect]");
      await mouse.click(discAgain.col, discAgain.row); // CONFIRM

      await h.waitForFrame((f) => !f.includes("DeepSeek") && f.includes("Groq"));
      expect(disconnected).toBe("deepseek");
      expect(loadShellConfig(configDir).apiKeys ?? {}).toEqual({});

      // The picker is still open (Groq remains): select it to close cleanly.
      const groqRow = h.captureCharFrame();
      const groqLabel = columnOnRow(groqRow, "Groq", "Groq");
      await mouse.click(groqLabel.col, groqLabel.row);
      await h.waitForFrame((f) => f.includes("Select a model"));
      h.mockInput.pressEnter();
      const result = await pending;
      expect(result?.provider).toBe("groq");
    } finally {
      h.renderer.destroy();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("review finding #2 — arming Disconnect warns about a shared env var BEFORE confirming", () => {
  otuiTest("arming zai's Disconnect names zai-coding and ZAI_API_KEY (real registry pair, same shared credential)", async () => {
    const otui = requireOtui();
    const h = await otui.testing.createTestRenderer({ width: 120, height: 30 });
    const configDir = tempConfigDir();
    saveApiKey("ZAI_API_KEY", "sk-zai", configDir);
    const ZAI: DetectedProvider = { name: "zai", label: "Z.AI (GLM)", models: ["glm-5.2"] };
    const ZAI_CODING: DetectedProvider = { name: "zai-coding", label: "Z.AI GLM Coding Plan", models: ["glm-5.2"] };
    try {
      const pending = selectProviderModelInTui(otui.core, h.renderer, [ZAI, ZAI_CODING], {
        onlyConnected: true,
        fetch: alwaysLive,
        env: { ZAI_API_KEY: "sk-zai" },
        configDir,
      });
      const frame = await h.waitForFrame((f) => f.includes("Z.AI (GLM)"));
      const disc = columnOnRow(frame, "Z.AI (GLM)", "[Disconnect]");
      const mouse = otui.testing.createMockMouse(h.renderer);
      await mouse.click(disc.col, disc.row); // arm — do NOT confirm
      const armedFrame = await h.waitForFrame((f) => f.includes("disconnect 'Z.AI (GLM)'?"));
      expect(armedFrame).toContain("zai-coding");
      expect(armedFrame).toContain("ZAI_API_KEY");

      await pressEscapeAndSettle(h); // decline (cancels the arm; step stays open)
      await pressEscapeAndSettle(h); // leave
      expect(await pending).toBeUndefined();
      // Declined: neither credential was touched.
      expect(loadShellConfig(configDir).apiKeys).toEqual({ ZAI_API_KEY: "sk-zai" });
    } finally {
      h.renderer.destroy();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("AC10 — button/row colours come from the active theme", () => {
  function paintedHexes(frame: { lines: readonly { spans: readonly { fg: unknown; bg: unknown }[] }[] }): { fg: Set<string>; bg: Set<string> } {
    const fg = new Set<string>();
    const bg = new Set<string>();
    for (const line of frame.lines) {
      for (const span of line.spans) {
        const asFg = themeColorToHex(span.fg);
        if (asFg !== undefined) fg.add(asFg);
        const asBg = themeColorToHex(span.bg);
        if (asBg !== undefined) bg.add(asBg);
      }
    }
    return { fg, bg };
  }

  otuiTest("Test/Disconnect paint theme.focus/theme.error, on a dark and a light theme", async () => {
    const otui = requireOtui();
    const previous = getThemeId();
    try {
      for (const id of ["groknight", "grokday"] as const) {
        applyThemeId(id);
        const theme = resolveTheme(id);
        const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
        const pending = selectProviderModelInTui(otui.core, h.renderer, [DEEPSEEK], { onlyConnected: true, fetch: alwaysLive, env: ENV });
        await h.waitForFrame((f) => f.includes("[Test]"));
        await h.flush();

        const { fg } = paintedHexes(h.captureSpans());
        expect(fg.has(theme.focus)).toBe(true); // [Test]
        expect(fg.has(theme.error)).toBe(true); // [Disconnect]

        await pressEscapeAndSettle(h);
        expect(await pending).toBeUndefined();
        h.renderer.destroy();
      }
    } finally {
      applyThemeId(previous);
    }
  });
});

// AC7's session-side half (the `/connect` command handler comparing the
// disconnected name against the CURRENT session's provider and printing a
// system line) lives inside `launchTuiAgentShell`'s giant closure, which no
// test in this file mounts end-to-end — same reason `tui-shell.test.ts`'s own
// SLATE-3a/SLATE-3b/AC7 describe blocks (see `readFileSync`d source audits
// there) read the source rather than driving the full interactive shell. The
// STEP's own contract — `onDisconnected` fires with the right name, exactly
// once, only on a CONFIRMED disconnect — is proven above (AC4's second case).
// This audits only that the command handler actually wires that callback to
// the session comparison and the system line the operator was promised.
describe("AC7 — the /connect command handler prints the active-provider-disconnected line (source-text audit)", () => {
  const tuiSource = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const handlerStart = tuiSource.indexOf('if (command.name === "/connect" || command.name === "/provider")');
  const handlerBody = tuiSource.slice(handlerStart, handlerStart + 2500);

  test("onDisconnected compares the disconnected name against the session's OWN provider", () => {
    expect(handlerBody).toContain("onDisconnected: (name, sharedWith) => {");
    expect(handlerBody).toContain("if (name === currentSel.provider) {");
  });

  test("the system line names 'already-loaded credential' and how to move on", () => {
    expect(handlerBody).toContain("already-loaded credential");
    expect(handlerBody).toContain("/connect another provider or restart");
    expect(handlerBody).toContain("io.onSystem?.(");
  });

  // flow 304 review finding #2: the result must ALSO name every provider a
  // shared env var affected (e.g. built-in zai/zai-coding sharing ZAI_API_KEY).
  test("the result also reports sharedWith to the operator", () => {
    expect(handlerBody).toContain("if (sharedWith.length > 0) {");
    expect(handlerBody).toContain("this also disconnected");
  });

  test("the line is NOT a forced switch: no call to switchTo inside the onDisconnected callback", () => {
    const callbackStart = handlerBody.indexOf("onDisconnected: (name, sharedWith) => {");
    const callbackEnd = handlerBody.indexOf("})", callbackStart);
    const callbackBody = handlerBody.slice(callbackStart, callbackEnd);
    expect(callbackBody).not.toContain("switchTo(");
  });
});
