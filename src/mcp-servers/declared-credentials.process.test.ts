// Flow 296 follow-up (PR #657 review): `buildMcpChildEnv` used to strip
// saved-credential names ONLY from `savedCredentialEnvKeys()` — a process
// singleton filled by `applySavedApiKeys()` (TUI startup, `serve-runner.ts`,
// `keryx acp`). Two real surfaces never call that function at all:
//
//   - `keryx shell`'s READLINE path (`--no-tui`/`--print`/non-TTY — the
//     branch from `commands/shell.ts` around line 3872) never resolves a
//     provider through `applySavedApiKeys`.
//   - `keryx mcp doctor` resolves no provider at all.
//
// On both, the singleton stays EMPTY, so the by-name strip removed nothing —
// protection by coincidence (those paths also never happened to load a
// saved key into `process.env`), not by construction. `buildMcpChildEnv` now
// also reads `declaredCredentialEnvKeys()` — the same names straight off
// `auth.json`, independent of whether anything loaded them into this run —
// and unions the two. These tests prove it against a REAL spawned child, an
// EMPTY singleton, and a temp config dir that declares a custom envKey
// present only in the PARENT env passed to the runtime/dial call (never
// noted via `noteSavedCredentialEnv`), for both the `keryx shell` runtime
// (`createMcpRuntime`) and the exact call `keryx mcp doctor` makes
// (`defaultConnect` with its own `configDir`).

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedMcpServer } from "./config";
import { createMcpRuntime, defaultConnect } from "./runtime";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const ECHO_SERVER = path.join(REPO_ROOT, "fixtures", "mcp-servers", "echo-server.ts");

/** A fresh temp dir with its own `config` (for `auth.json`) and `project` subdirs. */
function workspace(): { configDir: string; projectRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-declared-cred-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { configDir, projectRoot };
}

/** Declares one custom-named saved credential in `<configDir>/auth.json` — never a well-known provider name. */
function declareSavedApiKey(configDir: string, envKey: string, value: string): void {
  writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({ apiKeys: { [envKey]: value } }));
}

test("keryx shell path (createMcpRuntime): a custom envKey declared in auth.json but never loaded into the singleton is still stripped", async () => {
  const { configDir, projectRoot } = workspace();
  const envKey = `DECLARED_SHELL_GATEWAY_${Math.random().toString(36).slice(2)}`;
  // Declared on disk — NOT via `noteSavedCredentialEnv`, so the runtime
  // singleton (`savedCredentialEnvKeys()`) knows nothing about this name.
  declareSavedApiKey(configDir, envKey, "unused-declared-value");

  const pidFile = path.join(configDir, "echo.pid.json");
  writeFileSync(
    path.join(configDir, "mcp-servers.json"),
    JSON.stringify({
      schemaVersion: 1,
      servers: {
        echo: {
          command: process.execPath,
          args: [ECHO_SERVER],
          env: { ECHO_SERVER_PID_FILE: pidFile, ECHO_SERVER_REPORT_VAR: envKey },
        },
      },
    }),
  );

  // The PARENT env this run actually carries the value in — a real shell
  // that loaded it some other way, or simply inherited it. Whether
  // `applySavedApiKeys` ever ran is irrelevant to the claim under test.
  const runtime = createMcpRuntime({
    cwd: projectRoot,
    gitRoot: projectRoot,
    configDir,
    env: { ...process.env, [envKey]: "sentinel-parent-value" },
  });
  try {
    await runtime.ready();
    expect(runtime.servers().map((s) => s.status)).toEqual(["connected"]);
    const started = JSON.parse(readFileSync(pidFile, "utf8")) as { reportedVarPresent?: boolean };
    // Fails without the fix: the singleton is empty, so the old by-name
    // strip removed nothing, and the shape rule does not match this name.
    expect(started.reportedVarPresent).toBe(false);
  } finally {
    await runtime.close();
  }
}, 30_000);

test("keryx mcp doctor path (defaultConnect with its own configDir, the exact call doctorCommand makes): same result", async () => {
  const { configDir } = workspace();
  const envKey = `DECLARED_DOCTOR_GATEWAY_${Math.random().toString(36).slice(2)}`;
  declareSavedApiKey(configDir, envKey, "unused-declared-value");

  const pidFile = path.join(configDir, "echo.pid.json");
  const server: ResolvedMcpServer = {
    name: "echo",
    command: process.execPath,
    args: [ECHO_SERVER],
    env: { ECHO_SERVER_PID_FILE: pidFile, ECHO_SERVER_REPORT_VAR: envKey },
    source: "user",
    projectLocal: false,
    file: path.join(configDir, "mcp-servers.json"),
    enabled: true,
    raw: {},
  };

  // `commands/mcp-servers.ts`'s `doctorCommand` builds its connect closure as
  // `(server) => defaultConnect(server, env, dialling.signal, kills, deps.configDir)`
  // — this is that exact call, with an empty singleton (nothing here ever
  // calls `noteSavedCredentialEnv`).
  const env = { ...process.env, [envKey]: "sentinel-parent-value" };
  const connection = await defaultConnect(server, env, undefined, undefined, configDir);
  try {
    const started = JSON.parse(readFileSync(pidFile, "utf8")) as { reportedVarPresent?: boolean };
    expect(started.reportedVarPresent).toBe(false);
  } finally {
    await connection.close();
  }
}, 30_000);
