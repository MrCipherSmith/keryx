// `/rendering [mode]` (flow 395; AC8): the typed command behind the /settings row. It reads and
// writes the remote config file; the next message part picks the change up with no restart.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { loadRemoteConfig, saveRemoteConfig } from "../remote/config";
import { makeRemoteDir, testConfig } from "../remote/remote.test-helpers";
import { isRenderingCommand, RENDERING_FALLBACK_NOTE, RENDERING_MEANING, runRenderingCommand } from "./rendering-command";

let dir: string;
beforeEach(() => {
  dir = makeRemoteDir();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("only the exact command word is a rendering command", () => {
  expect(isRenderingCommand("/rendering")).toBe(true);
  expect(isRenderingCommand("  /rendering html")).toBe(true);
  expect(isRenderingCommand("/renderingx")).toBe(false);
  expect(isRenderingCommand("rendering")).toBe(false);
});

test("bare: the mode in effect marked, every mode explained, the fallback chain, the usage", () => {
  saveRemoteConfig(testConfig({ rendering: "rich" }), dir);
  const text = runRenderingCommand("", dir);
  expect(text).toContain("Telegram rendering: rich (saved in the remote config)");
  expect(text).toContain(`  * rich: ${RENDERING_MEANING.rich}`);
  expect(text).toContain(`    auto: ${RENDERING_MEANING.auto}`);
  expect(text).toContain(RENDERING_FALLBACK_NOTE);
  expect(text).toContain("Usage: /rendering [auto|rich|html|plain]");
});

test("bare with no saved key says it is the default; with no remote config it says remote control is not set up", () => {
  saveRemoteConfig(testConfig(), dir);
  expect(runRenderingCommand("", dir)).toContain("Telegram rendering: auto (default (auto))");
  rmSync(dir, { recursive: true, force: true });
  const fresh = makeRemoteDir();
  try {
    expect(runRenderingCommand("", fresh)).toContain("default, remote control is not set up yet");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("a mode is saved in the remote config and reported, with the rest of the file kept", () => {
  saveRemoteConfig(testConfig({ orphanMs: 5000 }), dir);
  const text = runRenderingCommand("plain", dir);
  expect(text).toContain("Telegram rendering: plain");
  expect(text).toContain("Saved; it applies to the next message.");
  const loaded = loadRemoteConfig(dir);
  expect(loaded.ok && loaded.value).toMatchObject({ rendering: "plain", orphanMs: 5000 });
});

test("a bad mode is refused naming the valid ones and changes nothing", () => {
  saveRemoteConfig(testConfig({ rendering: "html" }), dir);
  const text = runRenderingCommand("sparkly", dir);
  expect(text).toContain("/rendering: rendering must be one of auto, rich, html, plain");
  expect(text).not.toContain("sparkly");
  const loaded = loadRemoteConfig(dir);
  expect(loaded.ok && loaded.value.rendering).toBe("html");
});

test("with no remote config a mode cannot be saved, and the message says why instead of throwing", () => {
  const text = runRenderingCommand("html", dir);
  expect(text).toContain("/rendering: remote control is not set up on this machine");
});
