// K-015: `shell_exec` does not hand the operator's saved provider keys to commands.
//
// Found by the arena, 2026-09-11: an agent ran `env` in a keryx arm and printed the
// operator's DeepSeek, OpenRouter and xAI keys. The arena had started keryx with
// none of them; `resolveShellEnv` loaded every key saved in `auth.json` into the
// env and passed the lot to each command.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applySavedApiKeys, saveShellConfig } from "../../lib/shell-config";
import { resolveShellEnv } from "./shell-spawn";

const TOUCHED = ["K015_SAVED_API_KEY", "K015_UNAPPLIED_API_KEY", "K015_OPERATOR_API_KEY", "KERYX_SHELL_PASS_SAVED_KEYS"];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

function savedKeys(keys: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-k015-"));
  saveShellConfig({ apiKeys: keys }, dir);
  return dir;
}

test("a key keryx loaded from auth.json stays with keryx; the operator's own export reaches the command", async () => {
  const dir = savedKeys({ K015_SAVED_API_KEY: "saved-value" });
  process.env.K015_OPERATOR_API_KEY = "exported-value";

  expect(applySavedApiKeys(dir)).toContain("K015_SAVED_API_KEY");
  // keryx's own providers still find it.
  expect(process.env.K015_SAVED_API_KEY).toBe("saved-value");

  const env = await resolveShellEnv(dir);
  expect(env.K015_SAVED_API_KEY).toBeUndefined();
  expect(env.K015_OPERATOR_API_KEY).toBe("exported-value");
});

test("building the command env no longer loads saved keys as a side effect", async () => {
  const dir = savedKeys({ K015_UNAPPLIED_API_KEY: "saved-value" });

  const env = await resolveShellEnv(dir);

  expect(env.K015_UNAPPLIED_API_KEY).toBeUndefined();
  expect(process.env.K015_UNAPPLIED_API_KEY).toBeUndefined();
});

test("KERYX_SHELL_PASS_SAVED_KEYS=1 hands the saved keys over, as before", async () => {
  const dir = savedKeys({ K015_UNAPPLIED_API_KEY: "saved-value" });
  process.env.KERYX_SHELL_PASS_SAVED_KEYS = "1";

  const env = await resolveShellEnv(dir);

  expect(env.K015_UNAPPLIED_API_KEY).toBe("saved-value");
});
