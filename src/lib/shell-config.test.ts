import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueTestRoot } from "./test-tmp";
import {
  applySavedApiKeys,
  envWithSavedApiKeys,
  loadShellConfig,
  removeApiKey,
  removeProviderBaseUrl,
  removeProviderModelParams,
  saveApiKey,
  saveProviderBaseUrl,
  saveProviderModelParams,
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

// flow 304 review finding #6: auth.json now writes atomically (temp + rename)
// so a crash or a racing second write can never leave it half-written.
test("saveShellConfig writes atomically: same content and mode as before, and no temp file survives", () => {
  const dir = tempDir();
  saveShellConfig({ provider: "openrouter" }, dir);
  saveShellConfig({ model: "openai/gpt-4o-mini" }, dir); // a second, merging write
  const file = shellConfigPath(dir);
  expect(loadShellConfig(dir)).toEqual({ provider: "openrouter", model: "openai/gpt-4o-mini" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const entries = readdirSync(dir);
  expect(entries).toEqual(["auth.json"]); // no `*.tmp` sibling left behind
});

// Round 2 item 2 added, then round 3 removed, a shared `auth.json` sync lock
// (`withAuthFileLockSync`) `saveShellConfig` and `model-profile.ts`'s
// migration strip used to take — it could block every `saveShellConfig`
// call, including hot TUI paths, for up to its own 2s timeout on
// contention. `saveShellConfig` is back to its pre-lock, unconditional
// read-merge-write (see its own doc); the migration strip now protects
// itself with a narrow, lock-free read/verify/write instead
// (`stripModelProfilesFromAuthJsonUnlocked`,
// `../harness/routing/model-profile.ts` — its own tests, in
// `model-profile.test.ts`, cover that retry/verify window directly).

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

test("envWithSavedApiKeys copies a grok OAuth access token onto XAI_API_KEY without exposing it in other fields", () => {
  const dir = tempDir();
  saveShellConfig(
    {
      oauthGrants: {
        grok: { method: "device-code", access: "oauth-access-token", obtainedAt: "2026-01-01T00:00:00.000Z" },
      },
    },
    dir,
  );
  const merged = envWithSavedApiKeys({}, dir);
  expect(merged.XAI_API_KEY).toBe("oauth-access-token");
});

test("saveApiKey merges per-provider keys under apiKeys (flow 085)", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  saveApiKey("GROQ_API_KEY", "gsk-x", dir);
  expect(loadShellConfig(dir).apiKeys).toEqual({ DEEPSEEK_API_KEY: "sk-ds", GROQ_API_KEY: "gsk-x" });
});

test("saveProviderBaseUrl merges endpoint overrides per provider", () => {
  const dir = tempDir();
  saveProviderBaseUrl("rapid-mlx", "http://127.0.0.1:8010", dir);
  saveProviderBaseUrl("openrouter", "https://openrouter.ai/api/v1", dir);

  expect(loadShellConfig(dir).baseUrls).toEqual({
    "rapid-mlx": "http://127.0.0.1:8010",
    openrouter: "https://openrouter.ai/api/v1",
  });
});

// flow 268 (AC2)
test("saveProviderModelParams merges per-provider without clobbering other providers' entries", () => {
  const dir = tempDir();
  saveProviderModelParams("openrouter", { temperature: 0.2, maxOutputTokens: 4096 }, dir);
  saveProviderModelParams("deepseek", { timeoutMs: 60_000 }, dir);

  expect(loadShellConfig(dir).modelParams).toEqual({
    openrouter: { temperature: 0.2, maxOutputTokens: 4096 },
    deepseek: { timeoutMs: 60_000 },
  });
});

test("saveProviderModelParams merges a second patch into the SAME provider's existing entry", () => {
  const dir = tempDir();
  saveProviderModelParams("openrouter", { temperature: 0.2 }, dir);
  saveProviderModelParams("openrouter", { maxOutputTokens: 4096 }, dir);

  expect(loadShellConfig(dir).modelParams).toEqual({
    openrouter: { temperature: 0.2, maxOutputTokens: 4096 },
  });
});

// flow 304 (AC5): the `/connect` Disconnect button + `keryx providers remove`.
test("removeApiKey deletes exactly the named key, leaving its siblings intact", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  saveApiKey("GROQ_API_KEY", "gsk-x", dir);
  removeApiKey("DEEPSEEK_API_KEY", dir);
  expect(loadShellConfig(dir).apiKeys).toEqual({ GROQ_API_KEY: "gsk-x" });
});

test("removeApiKey on a key that was never saved is a no-op, not an error", () => {
  const dir = tempDir();
  saveApiKey("GROQ_API_KEY", "gsk-x", dir);
  removeApiKey("DEEPSEEK_API_KEY", dir); // never saved
  expect(loadShellConfig(dir).apiKeys).toEqual({ GROQ_API_KEY: "gsk-x" });
});

test("removeProviderBaseUrl deletes exactly one provider's override, leaving siblings intact", () => {
  const dir = tempDir();
  saveProviderBaseUrl("rapid-mlx", "http://127.0.0.1:8010", dir);
  saveProviderBaseUrl("openrouter", "https://openrouter.ai/api/v1", dir);
  removeProviderBaseUrl("rapid-mlx", dir);
  expect(loadShellConfig(dir).baseUrls).toEqual({ openrouter: "https://openrouter.ai/api/v1" });
});

test("removeProviderModelParams deletes exactly one provider's overrides, leaving siblings intact", () => {
  const dir = tempDir();
  saveProviderModelParams("openrouter", { temperature: 0.2 }, dir);
  saveProviderModelParams("deepseek", { timeoutMs: 60_000 }, dir);
  removeProviderModelParams("openrouter", dir);
  expect(loadShellConfig(dir).modelParams).toEqual({ deepseek: { timeoutMs: 60_000 } });
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
