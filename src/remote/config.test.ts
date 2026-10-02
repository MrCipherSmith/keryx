// `remote.rendering` in the remote config (flow 395; AC7): auto|rich|html|plain, default auto,
// anything else refused with a message that names the valid values. The setting lives in the same
// closed-schema file as the chat id and the allow-list.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRemoteConfig, parseRemoteConfig, saveRemoteConfig } from "./config";
import { remoteConfigPath } from "./paths";
import { makeRemoteDir, testConfig } from "./remote.test-helpers";
import { readRenderingSetting, writeRenderingMode } from "./rendering-config";
import { DEFAULT_RENDER_MODE, isRenderMode, RENDER_MODES } from "./rendering-mode";

const dirs: string[] = [];
function freshDir(): string {
  const dir = makeRemoteDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = { schemaVersion: 1, chatId: -1001, allowedUserIds: [7] };

describe("remote.rendering is parsed from the remote config", () => {
  test("the four documented values are accepted", () => {
    expect([...RENDER_MODES]).toEqual(["auto", "rich", "html", "plain"]);
    for (const mode of RENDER_MODES) {
      const parsed = parseRemoteConfig({ ...BASE, rendering: mode });
      expect(parsed.ok && parsed.value.rendering).toBe(mode);
    }
  });

  test("the default is auto, and a config without the key keeps no key", () => {
    expect(DEFAULT_RENDER_MODE).toBe("auto");
    const parsed = parseRemoteConfig(BASE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rendering).toBeUndefined();
      expect("rendering" in parsed.value).toBe(false);
    }
  });

  for (const bad of ["Rich", "markdown", "", "html ", 1, null, true, ["html"]]) {
    test(`${JSON.stringify(bad)} is refused with a message naming the valid values`, () => {
      const parsed = parseRemoteConfig({ ...BASE, rendering: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        for (const mode of RENDER_MODES) {
          expect(parsed.reason).toContain(mode);
        }
        expect(parsed.reason).toContain("rendering");
      }
    });
  }

  test("an unknown key is still refused: the schema stays closed", () => {
    expect(parseRemoteConfig({ ...BASE, rendring: "auto" }).ok).toBe(false);
  });

  test("isRenderMode is exact, with no case folding", () => {
    expect(isRenderMode("auto")).toBe(true);
    expect(isRenderMode("AUTO")).toBe(false);
    expect(isRenderMode(undefined)).toBe(false);
  });
});

describe("the file on disk", () => {
  test("a config saved without rendering round-trips byte-for-byte as before", () => {
    const dir = freshDir();
    const saved = saveRemoteConfig(testConfig(), dir);
    expect(saved.ok).toBe(true);
    const text = readFileSync(remoteConfigPath(dir), "utf8");
    expect(text).not.toContain("rendering");
    const loaded = loadRemoteConfig(dir);
    expect(loaded.ok && loaded.value).toEqual(testConfig());
  });

  test("a saved mode is read back, with the file owner-only", () => {
    const dir = freshDir();
    saveRemoteConfig(testConfig({ rendering: "rich" }), dir);
    const loaded = loadRemoteConfig(dir);
    expect(loaded.ok && loaded.value.rendering).toBe("rich");
  });

  test("a hand-edited file with a bad mode makes the load fail with the valid values, not crash", () => {
    const dir = freshDir();
    saveRemoteConfig(testConfig(), dir);
    const file = remoteConfigPath(dir);
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...doc, rendering: "fancy" }), { mode: 0o600 });
    const loaded = loadRemoteConfig(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toContain("auto, rich, html, plain");
      expect(loaded.reason).not.toContain(path.sep + "token");
    }
  });
});

describe("readRenderingSetting / writeRenderingMode", () => {
  test("no remote config: the default, and nothing to save into", () => {
    const dir = freshDir();
    expect(readRenderingSetting(dir)).toEqual({ mode: "auto", source: "default", saveable: false });
    const written = writeRenderingMode("html", dir);
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.reason).toContain("not set up");
    }
  });

  test("a config without the key: the default, saveable", () => {
    const dir = freshDir();
    saveRemoteConfig(testConfig(), dir);
    expect(readRenderingSetting(dir)).toEqual({ mode: "auto", source: "default", saveable: true });
  });

  test("a mode is saved, case and spaces forgiven, and the rest of the config is kept", () => {
    const dir = freshDir();
    saveRemoteConfig(testConfig({ orphanMs: 1234 }), dir);
    expect(writeRenderingMode("  Plain ", dir)).toEqual({ ok: true, value: "plain" });
    expect(readRenderingSetting(dir)).toEqual({ mode: "plain", source: "config", saveable: true });
    const loaded = loadRemoteConfig(dir);
    expect(loaded.ok && loaded.value.orphanMs).toBe(1234);
  });

  test("a bad value is refused naming the valid ones, and the file is not touched", () => {
    const dir = freshDir();
    saveRemoteConfig(testConfig({ rendering: "rich" }), dir);
    const before = readFileSync(remoteConfigPath(dir), "utf8");
    const written = writeRenderingMode("bogus", dir);
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.reason).toContain("auto, rich, html, plain");
      expect(written.reason).not.toContain("bogus");
    }
    expect(readFileSync(remoteConfigPath(dir), "utf8")).toBe(before);
  });
});
