import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueTestRoot } from "./test-tmp";
import {
  applySavedApiKeys,
  envWithSavedApiKeys,
  loadShellConfig,
  saveApiKey,
  saveShellConfig,
  shellConfigPath,
} from "./shell-config";

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
  process.env.XDG_DATA_HOME = uniqueTestRoot(tmpdir(), "xdg-keryx-test");
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

test("saveApiKey merges per-provider keys under apiKeys (flow 085)", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  saveApiKey("GROQ_API_KEY", "gsk-x", dir);
  expect(loadShellConfig(dir).apiKeys).toEqual({ DEEPSEEK_API_KEY: "sk-ds", GROQ_API_KEY: "gsk-x" });
});

test("applySavedApiKeys sets env for saved keys without overwriting an existing env var", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-saved", dir);
  saveApiKey("GROQ_API_KEY", "gsk-saved", dir);
  const prevD = process.env.DEEPSEEK_API_KEY;
  const prevG = process.env.GROQ_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.GROQ_API_KEY = "gsk-from-env"; // env already set → must win
  try {
    const applied = applySavedApiKeys(dir);
    expect(process.env.DEEPSEEK_API_KEY ?? "").toBe("sk-saved");
    expect(process.env.GROQ_API_KEY).toBe("gsk-from-env");
    expect(applied).toContain("DEEPSEEK_API_KEY");
    expect(applied).not.toContain("GROQ_API_KEY");
  } finally {
    if (prevD === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevD;
    if (prevG === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = prevG;
  }
});

test("envWithSavedApiKeys merges auth.json keys into a snapshot without mutating process.env", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-from-auth", dir);
  const prevD = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const merged = envWithSavedApiKeys({ PATH: "/bin", GROQ_API_KEY: "gsk-live" }, dir);
    expect(merged.DEEPSEEK_API_KEY).toBe("sk-from-auth");
    expect(merged.GROQ_API_KEY).toBe("gsk-live");
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); // no side effect
  } finally {
    if (prevD === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevD;
  }
});

test("applySavedApiKeys migrates the legacy openrouterKey into OPENROUTER_API_KEY", () => {
  const dir = tempDir();
  saveShellConfig({ openrouterKey: "sk-or-legacy" }, dir);
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    applySavedApiKeys(dir);
    expect(process.env.OPENROUTER_API_KEY ?? "").toBe("sk-or-legacy");
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});

test("loadShellConfig tolerates malformed JSON → {}", () => {
  const dir = tempDir();
  // Write junk directly, then load.
  saveShellConfig({ provider: "x" }, dir);
  require("node:fs").writeFileSync(shellConfigPath(dir), "{not json", { mode: 0o600 });
  expect(loadShellConfig(dir)).toEqual({});
});
