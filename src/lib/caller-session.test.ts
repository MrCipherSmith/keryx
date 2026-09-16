import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExternalChildEnv } from "../harness/external/env";
import { resolveShellEnv } from "../harness/process/shell-spawn";
import { exportCallerSession, resolveCallerSession } from "./caller-session";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A config directory holding a `keryx shell` selection, as `auth.json` persists it. */
function persisted(provider: string, model: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-caller-session-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ provider, model }));
  return dir;
}

test("flags win, and are taken as a pair", () => {
  const configDir = persisted("demo", "demo-medium");
  const resolved = resolveCallerSession({
    flagProvider: "anthropic",
    env: { KERYX_SESSION_MODEL: "other" },
    fromShellConfig: true,
    configDir,
  });
  // The model is NOT borrowed from the env or the persisted file: half of one
  // source plus half of another is a session that never existed.
  expect(resolved).toEqual({ providerId: "anthropic", modelId: "", source: "flags" });
});

test("KERYX_SESSION_* is next", () => {
  expect(
    resolveCallerSession({ env: { KERYX_SESSION_PROVIDER: "anthropic", KERYX_SESSION_MODEL: "claude-opus-5" } }),
  ).toEqual({ providerId: "anthropic", modelId: "claude-opus-5", source: "env" });
});

test("the persisted `keryx shell` selection is never read unless asked for", () => {
  const configDir = persisted("demo", "demo-medium");
  expect(resolveCallerSession({ env: {}, configDir })).toEqual({ providerId: "", modelId: "", source: "none" });
  expect(resolveCallerSession({ env: {}, configDir, fromShellConfig: true })).toEqual({
    providerId: "demo",
    modelId: "demo-medium",
    source: "shell-config",
  });
});

test("keryx shell's exported session is what a command it runs resolves", async () => {
  const env: Record<string, string | undefined> = {};
  exportCallerSession("demo", "demo-medium", env);
  expect(resolveCallerSession({ env })).toEqual({ providerId: "demo", modelId: "demo-medium", source: "env" });

  // A `/model` switch re-exports; half a session clears instead of publishing.
  exportCallerSession("demo", "", env);
  expect(resolveCallerSession({ env }).source).toBe("none");
});

test("shell_exec passes the exported session to its commands, and external agents never get it", async () => {
  const saved = { provider: process.env.KERYX_SESSION_PROVIDER, model: process.env.KERYX_SESSION_MODEL };
  try {
    exportCallerSession("demo", "demo-medium");
    const shellEnv = await resolveShellEnv();
    expect(shellEnv.KERYX_SESSION_PROVIDER).toBe("demo");
    expect(shellEnv.KERYX_SESSION_MODEL).toBe("demo-medium");
    // A Claude Code or Codex child is not this session.
    const external = buildExternalChildEnv({ parent: process.env, depth: 1 });
    expect(external.KERYX_SESSION_PROVIDER).toBeUndefined();
    expect(external.KERYX_SESSION_MODEL).toBeUndefined();
  } finally {
    if (saved.provider === undefined) delete process.env.KERYX_SESSION_PROVIDER;
    else process.env.KERYX_SESSION_PROVIDER = saved.provider;
    if (saved.model === undefined) delete process.env.KERYX_SESSION_MODEL;
    else process.env.KERYX_SESSION_MODEL = saved.model;
  }
});
