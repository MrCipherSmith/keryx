import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectProviderModelInTui } from "./tui-shell";

async function bundle() {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch { return undefined; }
}
const otui = await bundle();
const uiTest = test.skipIf(otui === undefined);

uiTest("subscription without an envKey opens device login; Esc cancels its request", async () => {
  if (!otui) return;
  const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
  const dir = mkdtempSync(join(tmpdir(), "keryx-codex-wizard-"));
  let signal: AbortSignal | undefined;
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  }) as typeof globalThis.fetch;
  try {
    const pending = selectProviderModelInTui(otui.core, h.renderer, [{ name: "openai-codex", label: "ChatGPT / Codex", models: ["gpt-5.3-codex"] }], { fetch, env: {}, configDir: dir });
    await h.flush(); h.mockInput.pressEnter();
    await h.flush();
    expect(h.captureCharFrame()).toContain("Requesting a device code");
    expect(signal).toBeDefined();
    h.mockInput.pressEscape(); await new Promise((resolve) => setTimeout(resolve, 170)); await h.flush();
    expect(signal?.aborted).toBe(true);
    h.mockInput.pressEscape(); await new Promise((resolve) => setTimeout(resolve, 170)); await h.flush();
    expect(await pending).toBeUndefined();
  } finally { h.renderer.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

uiTest("OpenAI API opens key entry directly without requesting an endpoint", async () => {
  if (!otui) return;
  const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
  const dir = mkdtempSync(join(tmpdir(), "keryx-api-wizard-"));
  try {
    const pending = selectProviderModelInTui(otui.core, h.renderer, [{ name: "openai", label: "OpenAI API", envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com", models: ["gpt-4o"] }], { env: {}, configDir: dir });
    await h.flush(); h.mockInput.pressEnter(); await h.flush();
    expect(h.captureCharFrame()).toContain("Paste your OpenAI API key");
    h.mockInput.pressEscape(); await new Promise((resolve) => setTimeout(resolve, 170)); await h.flush();
    h.mockInput.pressEscape(); await new Promise((resolve) => setTimeout(resolve, 170)); await h.flush();
    expect(await pending).toBeUndefined();
  } finally { h.renderer.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
