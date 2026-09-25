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

// --- R700-01: project-hook trust wiring (flow 319, lane A) -----------------

async function makeTrustProject(): Promise<{ dir: string; homeDir: string; configDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-trust-"));
  const homeDir = dir;
  const configDir = path.join(dir, "config");
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(dir, ".metaproject", "hooks.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      hooks: { SessionStart: [{ id: "marker-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }] },
    }),
    "utf8",
  );
  return { dir, homeDir, configDir };
}

test("R700-01: a trusted project SessionStart hook runs (present in registrations)", async () => {
  const { dir, homeDir, configDir } = await makeTrustProject();
  try {
    const { recordProjectHooksTrust, projectHooksDigestOfDoc } = await import("../harness/hooks");
    const raw = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(path.join(dir, ".metaproject", "hooks.json"), "utf8")));
    const digest = projectHooksDigestOfDoc(raw);
    if (digest === undefined) throw new Error("expected a digest");
    recordProjectHooksTrust({ trustRoot: dir, digest, hookIds: ["marker-hook"], configDir });

    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    });
    expect(result?.runtime.registrations().some((r) => r.id === "marker-hook")).toBe(true);
    expect(result?.notices).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R700-01: untrusted project hooks produce a start-of-session notice naming them", async () => {
  const { dir, homeDir, configDir } = await makeTrustProject();
  try {
    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    });
    expect(result?.runtime.registrations().some((r) => r.id === "marker-hook")).toBe(false);
    expect(result?.notices?.some((n) => n.includes("marker-hook") && n.includes("not trusted"))).toBe(true);
    expect(result?.notices?.some((n) => n.includes("keryx hooks trust"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R700-01: the notice is produced on EVERY build of the runtime, not suppressed after the first", async () => {
  const { dir, homeDir, configDir } = await makeTrustProject();
  try {
    const opts = {
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local" as const,
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    };
    const first = buildShellHookRuntime(opts);
    const second = buildShellHookRuntime(opts);
    expect(first?.notices?.length).toBeGreaterThan(0);
    expect(second?.notices ?? []).toEqual(first?.notices ?? []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R700-01 fix (flow 319): takeNotices() returns the lines once, then [] on the SAME context", async () => {
  const { dir, homeDir, configDir } = await makeTrustProject();
  try {
    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    });
    // `.notices` (untouched, read as many times as a caller likes) still
    // shows the untrusted-project-hooks notice from the shared fixture.
    expect(result?.notices?.length).toBeGreaterThan(0);
    // A first consumer (e.g. a TUI session that starts and prints these at
    // startup) gets the same lines back from `takeNotices()` …
    expect(result?.takeNotices?.()).toEqual(result?.notices);
    // … but a SECOND consumer of the SAME context — the readline fallback a
    // TUI session falls through to after an unrelated later failure — gets
    // nothing, so the operator is never shown the same lines twice.
    expect(result?.takeNotices?.()).toEqual([]);
    expect(result?.takeNotices?.()).toEqual([]);
    // `.notices` itself is unaffected by `takeNotices()` having run — it
    // still reflects what was computed, for any reader that only wants that.
    expect(result?.notices?.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R700-01: a user-disabled gate produces the OFF banner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-gate-off-"));
  try {
    await mkdir(path.join(dir, ".keryx"), { recursive: true });
    await writeFile(
      path.join(dir, ".keryx", "hooks.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        hooks: { PreToolUse: [{ id: "keryx.ctx-guard", enabled: false, acknowledge: "disable-builtin-gate" }] },
      }),
      "utf8",
    );
    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir: dir,
      env: { KERYX_HOOKS: "on" },
    });
    expect(result?.notices?.some((n) => n.includes("keryx.ctx-guard") && n.includes("OFF"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R700-01: forChild/inheritedHookIds never include an untrusted project hook", async () => {
  const { dir, homeDir, configDir } = await makeTrustProject();
  try {
    const result = buildShellHookRuntime({
      projectRoot: dir,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    });
    if (result === undefined) throw new Error("expected a runtime");
    const child = result.runtime.forChild({ sessionId: "child-s", runId: "child-r" });
    expect(child.registrations().some((r) => r.id === "marker-hook")).toBe(false);
    expect(child.inheritedHookIds()).not.toContain("marker-hook");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R700-01/D9: trust recorded for the main root applies to a worktree copy with identical hooks.json, not to a changed one", async () => {
  const { recordProjectHooksTrust, projectHooksDigestOfDoc } = await import("../harness/hooks");
  const mainRoot = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-main-"));
  const worktree = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-worktree-"));
  const configDir = path.join(mainRoot, "config");
  const homeDir = mainRoot;
  try {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: { SessionStart: [{ id: "marker-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }] },
    };
    await mkdir(path.join(mainRoot, ".metaproject"), { recursive: true });
    await mkdir(path.join(worktree, ".metaproject"), { recursive: true });
    await writeFile(path.join(mainRoot, ".metaproject", "hooks.json"), JSON.stringify(doc), "utf8");
    await writeFile(path.join(worktree, ".metaproject", "hooks.json"), JSON.stringify(doc), "utf8"); // identical

    const digest = projectHooksDigestOfDoc(doc);
    if (digest === undefined) throw new Error("expected a digest");
    recordProjectHooksTrust({ trustRoot: mainRoot, digest, hookIds: ["marker-hook"], configDir });

    const identical = buildShellHookRuntime({
      projectRoot: worktree,
      trustRoot: mainRoot,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    });
    expect(identical?.runtime.registrations().some((r) => r.id === "marker-hook")).toBe(true);

    // Now the worktree's hooks.json diverges from what was trusted.
    const changedDoc = {
      schemaVersion: "1.0.0",
      hooks: { SessionStart: [{ id: "marker-hook", matcher: "*", class: "observe", command: { argv: ["false"] } }] },
    };
    await writeFile(path.join(worktree, ".metaproject", "hooks.json"), JSON.stringify(changedDoc), "utf8");
    const changed = buildShellHookRuntime({
      projectRoot: worktree,
      trustRoot: mainRoot,
      sessionId: "s",
      runId: "r",
      interactive: true,
      profileId: "monitored-trusted-local",
      homeDir,
      configDir,
      env: { KERYX_HOOKS: "on" },
    });
    expect(changed?.runtime.registrations().some((r) => r.id === "marker-hook")).toBe(false);
    expect(changed?.notices?.some((n) => n.includes("changed since you trusted it"))).toBe(true);
  } finally {
    await rm(mainRoot, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
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
