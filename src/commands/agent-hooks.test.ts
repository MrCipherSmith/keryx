// Flow 306 (W6 T9): production wiring for `keryx shell`'s hook runtime.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLogRecords } from "../security/service";
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
// Flow 306 (W6, T20; fix round 3, T21): `buildShellHookRuntime` wires the
// real `keryx.impact-evidence` port (W8's gate, via
// `lib/impact-evidence-hook-adapter.ts`) by default, not the runtime's own
// NOOP fallback. Proven with an observable side effect only the REAL
// provider produces (a `disabled-env` record appended to W8's own log via
// `KERYX_DISABLE_IMPACT_GATE`) — the NOOP port never touches that log at
// all, and the in-runtime invocation record's `outcome` field is identical
// ("none") for both a NOOP port and a real "allow" decision, so the log is
// the only reliable signal.
//
// Fix round 3 (F-005): this test used to mutate the REAL `process.env`
// global (`process.env.KERYX_DISABLE_IMPACT_GATE = "1"`) to flip W8's kill
// switch, restoring it in `finally` — not hermetic under a shared test
// process (a concurrent test reading `process.env` mid-run could observe the
// mutation, and a failure between the mutation and the restore leaks it to
// every later test in the run). It now passes the kill switch through
// `buildShellHookRuntime`'s own injectable `env` option, which fix round 3
// threads all the way to `ImpactEvidenceRequest.env` (see
// `impact-evidence-hook-adapter.ts`) instead of letting the adapter fall
// back to the real `process.env`.
//
// Also rewritten (F-001/F-005) to fire an `apply_patch`-SHAPED call —
// `{patch: string}`, the only edit-tool input `keryx shell`/ACP ever
// actually produce — rather than a synthetic `toolName: "Write"` with a
// `file_path` field no real Keryx tool sends. Before the F-001 fix this
// would have called the provider zero times (`extractFilePaths` found no
// target in a bare `{patch}` input), which is exactly the gap round 3 found.
test("buildShellHookRuntime wires a real keryx.impact-evidence provider by default", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-impact-"));
  try {
    await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    const patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-export const a = 1;", "+export const a = 2;", ""].join(
      "\n",
    );

    // Disable built-in command hooks to ensure the test is hermetic; no keryx
    // binary on PATH in CI, so keryx.security-check-output crashes with gate
    // fail-closed deny. This test isolates the impact-evidence port only.
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(dir, ".metaproject", "hooks.json"),
      '{"schemaVersion":"1.0.0","hooks":{"PreToolUse":[{"id":"keryx.security-check-output","enabled":false},{"id":"keryx.ctx-guard","enabled":false}]}}',
      "utf8",
    );

    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "impact-session",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir: dir,
      env: { KERYX_DISABLE_IMPACT_GATE: "1" },
    });
    expect(result).toBeDefined();

    const fire = await result!.runtime.fire(
      "PreToolUse",
      {
        sessionId: "impact-session",
        runId: "r",
        toolCallId: "c1",
        toolName: "Edit",
        keryxToolName: "apply_patch",
        toolInput: { patch },
        policyProfile: "monitored-trusted-local",
      },
      // `matcherMatches`/`selectCandidates` read the tool name from `ctx`, not
      // from the payload — see `runtime.ts`'s `fire()`. `apply_patch` is
      // aliased to `Edit` for matcher purposes (`HOOK_TOOL_NAME_ALIASES`).
      { toolName: "Edit" },
    );
    // gate-advisory: the kill switch's "allow" never denies the tool call.
    expect(fire.decisions.filter((d) => d.hookId === "keryx.impact-evidence").some((d) => d.decision === "deny")).toBe(false);

    const records = await readLogRecords(dir);
    expect(records.some((r) => r.sessionId === "impact-session" && r.event === "disabled-env")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
