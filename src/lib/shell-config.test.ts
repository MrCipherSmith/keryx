import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadShellConfig, saveShellConfig, shellConfigPath } from "./shell-config";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-cfg-"));
}

test("loadShellConfig returns {} when no file exists", () => {
  expect(loadShellConfig(tempDir())).toEqual({});
});

test("saveShellConfig writes and loadShellConfig reads back (merge semantics)", () => {
  const dir = tempDir();
  saveShellConfig({ provider: "openrouter", model: "openai/gpt-4o-mini" }, dir);
  expect(loadShellConfig(dir)).toEqual({ provider: "openrouter", model: "openai/gpt-4o-mini" });
  // A patch merges, not replaces.
  saveShellConfig({ openrouterKey: "sk-or-xyz" }, dir);
  expect(loadShellConfig(dir)).toEqual({
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    openrouterKey: "sk-or-xyz",
  });
});

test("saveShellConfig writes the file mode 0600 (owner-only)", () => {
  const dir = tempDir();
  saveShellConfig({ openrouterKey: "sk-or-secret" }, dir);
  const mode = statSync(shellConfigPath(dir)).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("shellConfigPath honors XDG_DATA_HOME on non-Windows (cross-platform dir)", () => {
  if (process.platform === "win32") {
    return; // Windows uses %APPDATA%; skip the XDG assertion
  }
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(tmpdir(), "xdg-keryx-test");
  try {
    expect(shellConfigPath()).toBe(path.join(process.env.XDG_DATA_HOME, "keryx", "auth.json"));
  } finally {
    if (saved === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = saved;
    }
  }
});

test("loadShellConfig tolerates malformed JSON → {}", () => {
  const dir = tempDir();
  // Write junk directly, then load.
  saveShellConfig({ provider: "x" }, dir);
  require("node:fs").writeFileSync(shellConfigPath(dir), "{not json", { mode: 0o600 });
  expect(loadShellConfig(dir)).toEqual({});
});
