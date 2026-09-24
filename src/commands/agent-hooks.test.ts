// Flow 306 (W6 T9): production wiring for `keryx shell`'s hook runtime.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  aliasHookToolName,
  buildShellHookRuntime,
  derivePolicyProfileId,
  HOOK_TOOL_NAME_ALIASES,
  resolveHooksHomeDir,
  resolveHooksProjectRoot,
} from "./agent-hooks";

test("derivePolicyProfileId: unattended wins over everything else", () => {
  expect(derivePolicyProfileId(false, false)).toBe("unattended-untrusted");
  expect(derivePolicyProfileId(false, true)).toBe("unattended-untrusted");
});

test("derivePolicyProfileId: read-only wins when interactive", () => {
  expect(derivePolicyProfileId(true, true)).toBe("read-only-review");
});

test("derivePolicyProfileId: monitored-trusted-local otherwise", () => {
  expect(derivePolicyProfileId(true, false)).toBe("monitored-trusted-local");
});

test("aliasHookToolName maps known Keryx tools, passes through unknown ones", () => {
  expect(aliasHookToolName("shell_exec")).toBe("Bash");
  expect(aliasHookToolName("apply_patch")).toBe("Edit");
  expect(aliasHookToolName("workspace_context")).toBe("workspace_context");
  expect(HOOK_TOOL_NAME_ALIASES.shell_exec).toBe("Bash");
});

test("KERYX_HOOKS=off disables the runtime entirely", () => {
  const result = buildShellHookRuntime({
    projectRoot: "/nonexistent",
    sessionId: "s",
    runId: "r",
    interactive: true,
    profileId: "monitored-trusted-local",
    env: { KERYX_HOOKS: "off" },
  });
  expect(result).toBeUndefined();
});

test("no config files present builds a real runtime with just the built-ins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-"));
  try {
    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir: dir, // no ~/.keryx/hooks.json either
      env: {},
    });
    expect(result).toBeDefined();
    expect(result?.runtime.interactive).toBe(true);
    expect(result?.runtime.registrations().length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid project hooks.json builds a runtime that denies every PreToolUse/UserPromptSubmit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-invalid-"));
  try {
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    // Not valid JSON at all -> loadHookConfig reports ok:false.
    await writeFile(path.join(dir, ".metaproject", "hooks.json"), "{ not json", "utf8");
    const diagnostics: (readonly { code: string; message: string }[])[] = [];
    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir: dir,
      env: {},
      onConfigError: (d) => diagnostics.push(d),
    });
    expect(result).toBeDefined();
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.[0]?.code).toBe("invalid-json");

    const fire = await result!.runtime.fire("PreToolUse", {
      sessionId: "s",
      runId: "r",
      toolCallId: "c1",
      toolName: "Bash",
      toolInput: {},
      policyProfile: "monitored-trusted-local",
    });
    expect(fire.decisions.some((d) => d.decision === "deny")).toBe(true);

    const promptFire = await result!.runtime.fire("UserPromptSubmit", { sessionId: "s", runId: "r", prompt: "hi" });
    expect(promptFire.tightened).toBe("deny");

    // Observe-only events never gain a decision from the invalid-config guard.
    const postFire = await result!.runtime.fire("PostToolUse", {
      sessionId: "s",
      runId: "r",
      toolCallId: "c1",
      toolName: "Bash",
      toolInput: {},
      toolOutput: "ok",
    });
    expect(postFire.decisions.length).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review finding 11: `keryx hooks` and `buildShellHookRuntime` used to
// resolve `~/.keryx/hooks.json` to two DIFFERENT paths — the CLI honored
// `KERYX_HOME`, the runtime always read `os.homedir()`. Both now share
// `resolveHooksHomeDir`/`resolveHooksProjectRoot`.
test("resolveHooksHomeDir: an explicit homeDir wins, then KERYX_HOME, then the real homedir", () => {
  expect(resolveHooksHomeDir({}, "/explicit")).toBe("/explicit");
  expect(resolveHooksHomeDir({ KERYX_HOME: "/from-env" })).toBe("/from-env");
  expect(resolveHooksHomeDir({ KERYX_HOME: "/from-env" }, "/explicit")).toBe("/explicit");
  expect(resolveHooksHomeDir({ KERYX_HOME: "" })).not.toBe("");
});

test("buildShellHookRuntime honors KERYX_HOME exactly like `keryx hooks` does, with a subdirectory projectRoot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-kh-"));
  try {
    // A subdirectory `cwd`, resolved to the project root the same way
    // `commands/shell.ts` resolves it (`resolveHooksProjectRoot`), mirrors
    // `keryx hooks` being invoked from a subdirectory (AC/finding 11). Fake a
    // `.git` marker at `dir` so `resolveProjectRoot`'s walk-up stops there
    // instead of falling back to `sub` itself (no real ancestor of a tmp dir
    // is guaranteed to hold one).
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const sub = path.join(dir, "src", "nested");
    await mkdir(sub, { recursive: true });
    expect(resolveHooksProjectRoot(sub)).toBe(dir);

    const fakeHome = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-kh-home-"));
    try {
      const result = buildShellHookRuntime({
        projectRoot: resolveHooksProjectRoot(sub),
        sessionId: "s",
        runId: "r",
        interactive: true,
        profileId: "monitored-trusted-local",
        // No explicit `homeDir` — must fall back to KERYX_HOME, same as
        // `keryx hooks` (`resolveHomeDir` in `./hooks.ts`).
        env: { KERYX_HOME: fakeHome },
      });
      expect(result).toBeDefined();
      expect(result?.runtime.registrations().length).toBeGreaterThan(0);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
