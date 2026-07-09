import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { installRuntimeHook, uninstallRuntimeHook } from "./hook-install";
import {
  ANTIGRAVITY_RUNTIME,
  CODEX_RUNTIME,
  CURSOR_RUNTIME,
  OPENCODE_RUNTIME,
  WINDSURF_RUNTIME,
  getRuntime,
} from "./runtimes";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-rt-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- per-harness payload parsing (each harness delivers the command differently)

test("codex parses the Claude-shaped tool_input.command payload", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rg foo" } });
  expect(CODEX_RUNTIME.parseCommand(payload)).toBe("rg foo");
});

test("cursor parses the top-level command field", () => {
  expect(CURSOR_RUNTIME.parseCommand(JSON.stringify({ command: "grep x" }))).toBe("grep x");
  expect(CURSOR_RUNTIME.parseCommand(JSON.stringify({ nope: 1 }))).toBeNull();
});

test("windsurf parses tool_info.command_line", () => {
  const payload = JSON.stringify({ tool_info: { command_line: "cat big.log", cwd: "/x" } });
  expect(WINDSURF_RUNTIME.parseCommand(payload)).toBe("cat big.log");
});

test("antigravity parses toolCall.args.CommandLine", () => {
  const payload = JSON.stringify({ toolCall: { args: { CommandLine: "git log" } } });
  expect(ANTIGRAVITY_RUNTIME.parseCommand(payload)).toBe("git log");
});

// --- per-harness block signalling (three distinct contracts)

test("cursor blocks via stdout {permission:deny} + agent_message, exit 0", () => {
  const action = CURSOR_RUNTIME.block("rg foo", { block: true, matched: "rg", suggestion: "keryx ctx rg" });
  expect(action.exitCode).toBe(0);
  const parsed = JSON.parse(action.stdout ?? "{}");
  expect(parsed.permission).toBe("deny");
  expect(parsed.agent_message).toContain("keryx ctx");
});

test("antigravity blocks via stdout {allow_tool:false, deny_reason}, always exit 0", () => {
  const action = ANTIGRAVITY_RUNTIME.block("git log", { block: true, matched: "git log", suggestion: "keryx ctx run -- git log" });
  expect(action.exitCode).toBe(0);
  const parsed = JSON.parse(action.stdout ?? "{}");
  expect(parsed.allow_tool).toBe(false);
  expect(parsed.deny_reason).toContain("keryx ctx");
});

test("windsurf blocks via exit 2 + stderr", () => {
  const action = WINDSURF_RUNTIME.block("cat f", { block: true, matched: "cat", suggestion: "keryx ctx read" });
  expect(action.exitCode).toBe(2);
  expect(action.stderr).toContain("keryx ctx");
});

// --- per-harness install artifacts land at the right path with the right schema

test("codex installs a PreToolUse group into .codex/hooks.json", async () => {
  await withTempDir(async (root) => {
    const { path: file, errors } = await installRuntimeHook(root, CODEX_RUNTIME);
    expect(errors).toEqual([]);
    expect(file).toBe(path.join(root, ".codex", "hooks.json"));
    const s = JSON.parse(await readFile(file, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    const g = s.hooks.PreToolUse.find((x) => x.matcher === "Bash");
    expect(g?.hooks?.[0]?.command).toBe("keryx ctx hook codex");
    expect(await uninstallRuntimeHook(root, CODEX_RUNTIME)).toBe(true);
  });
});

test("cursor installs version:1 + beforeShellExecution entry", async () => {
  await withTempDir(async (root) => {
    const { path: file, errors } = await installRuntimeHook(root, CURSOR_RUNTIME);
    expect(errors).toEqual([]);
    const s = JSON.parse(await readFile(file, "utf8")) as {
      version?: number;
      hooks: { beforeShellExecution: Array<{ command?: string }> };
    };
    expect(s.version).toBe(1);
    expect(s.hooks.beforeShellExecution[0]?.command).toBe("keryx ctx hook cursor");
  });
});

test("windsurf installs a pre_run_command entry", async () => {
  await withTempDir(async (root) => {
    const { path: file, errors } = await installRuntimeHook(root, WINDSURF_RUNTIME);
    expect(errors).toEqual([]);
    const s = JSON.parse(await readFile(file, "utf8")) as {
      hooks: { pre_run_command: Array<{ command?: string; show_output?: boolean }> };
    };
    expect(s.hooks.pre_run_command[0]?.command).toBe("keryx ctx hook windsurf");
    expect(s.hooks.pre_run_command[0]?.show_output).toBe(true);
  });
});

test("antigravity installs a run_command group and uninstalls cleanly", async () => {
  await withTempDir(async (root) => {
    const { path: file, errors } = await installRuntimeHook(root, ANTIGRAVITY_RUNTIME);
    expect(errors).toEqual([]);
    expect(file).toBe(path.join(root, ".agents", "hooks.json"));
    const s = JSON.parse(await readFile(file, "utf8")) as Record<string, { PreToolUse?: Array<{ matcher?: string }> }>;
    const group = s["keryx-ctx-guard"];
    expect(group?.PreToolUse?.[0]?.matcher).toBe("run_command");
    expect(await uninstallRuntimeHook(root, ANTIGRAVITY_RUNTIME)).toBe(true);
  });
});

test("opencode writes a bridge plugin file and removes it on uninstall", async () => {
  await withTempDir(async (root) => {
    const { path: file, errors } = await installRuntimeHook(root, OPENCODE_RUNTIME);
    expect(errors).toEqual([]);
    expect(file).toBe(path.join(root, ".opencode", "plugin", "keryx-ctx-guard.js"));
    const content = await readFile(file, "utf8");
    expect(content).toContain("tool.execute.before");
    expect(content).toContain("keryx");
    expect(await uninstallRuntimeHook(root, OPENCODE_RUNTIME)).toBe(true);
    // second uninstall: nothing to remove
    expect(await uninstallRuntimeHook(root, OPENCODE_RUNTIME)).toBe(false);
  });
});

test("getRuntime returns undefined for unsupported zed", () => {
  expect(getRuntime("zed")).toBeUndefined();
});
