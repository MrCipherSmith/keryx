import { describe, expect, test } from "bun:test";
import { buildHookEnv, createRealHookRunner } from "./runner";

describe("buildHookEnv", () => {
  test("passes through only the fixed allowlist plus KERYX_*/CLAUDE_PROJECT_DIR plus command.env", () => {
    const env = buildHookEnv({
      processEnv: { PATH: "/usr/bin", HOME: "/home/x", SECRET_TOKEN: "shhh", RANDOM_VAR: "nope" },
      hookEvent: "PreToolUse",
      hookId: "keryx.ctx-guard",
      sessionId: "s1",
      runId: "r1",
      projectRoot: "/proj",
      policyProfile: "monitored-trusted-local",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
    expect(env.KERYX_HOOK_EVENT).toBe("PreToolUse");
    expect(env.KERYX_HOOK_ID).toBe("keryx.ctx-guard");
    expect(env.KERYX_SESSION_ID).toBe("s1");
    expect(env.KERYX_RUN_ID).toBe("r1");
    expect(env.KERYX_PROJECT_ROOT).toBe("/proj");
    expect(env.KERYX_POLICY_PROFILE).toBe("monitored-trusted-local");
    expect(env.CLAUDE_PROJECT_DIR).toBe("/proj");
  });

  test("command.env is merged in on top of the allowlist", () => {
    const env = buildHookEnv({
      processEnv: {},
      commandEnv: { MY_FLAG: "1" },
      hookEvent: "Stop",
      hookId: "h",
      sessionId: "s",
      runId: "r",
      projectRoot: "/proj",
      policyProfile: "read-only-review",
    });
    expect(env.MY_FLAG).toBe("1");
  });

  test("an absent inherited key is simply not present, not empty-string", () => {
    const env = buildHookEnv({
      processEnv: {},
      hookEvent: "Stop",
      hookId: "h",
      sessionId: "s",
      runId: "r",
      projectRoot: "/proj",
      policyProfile: "read-only-review",
    });
    expect("PATH" in env).toBe(false);
  });
});

describe("createRealHookRunner — real subprocess (bun -e scripts, unsandboxed)", () => {
  const runner = createRealHookRunner({
    projectRoot: process.cwd(),
    sandboxProfile: {
      mode: "workspace-write",
      network: "off",
      writableRoots: [],
      readDenyList: [],
      allowedDomains: [],
      required: false, // isolation not required -> unsandboxed is permitted
    },
  });

  test("delivers stdin to the child and captures stdout", async () => {
    const result = await runner.run({
      argv: [process.execPath, "-e", "process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0));"],
      cwd: ".",
      env: { PATH: process.env.PATH ?? "" },
      stdin: "hello-from-test",
      timeoutMs: 5000,
      network: "none",
      runsIn: "unsandboxed",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-test");
    expect(result.timedOut).toBe(false);
  });

  test("exit 2 surfaces as exitCode 2 with stderr captured", async () => {
    const result = await runner.run({
      argv: [process.execPath, "-e", "process.stderr.write('blocked'); process.exit(2);"],
      cwd: ".",
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 5000,
      network: "none",
      runsIn: "unsandboxed",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("blocked");
  });

  test("a hung child is killed at its timeout in well under 2s", async () => {
    const started = Date.now();
    const result = await runner.run({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      cwd: ".",
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 200,
      network: "none",
      runsIn: "unsandboxed",
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  // Flow 306 fix round 1, finding 2: a timed-out child that has already
  // spawned a DETACHED grandchild sharing (inheriting) its own stdout fd
  // escapes the runner's SIGKILL — `process.kill(-child.pid, "SIGKILL")`
  // only reaches the immediate child's process group, not the grandchild's
  // own detached one — so the grandchild survives and keeps that fd open.
  // Before the fix this meant `close` never fired and `spawnAndCollect`'s
  // promise never resolved, hanging the calling hook (and, transitively, the
  // whole gate) forever with no `hook-timeout` deny ever reached. Skipped on
  // win32: process groups/`detached` don't carry the same fd-inheritance
  // escape there. Both the immediate child and the grandchild self-exit
  // after a few seconds (belt-and-braces process hygiene for the test run,
  // not part of what's being asserted) — the assertion is that the runner
  // resolves FAR sooner than that, from the grace-period fix alone.
  test.skipIf(process.platform === "win32")(
    "a timed-out child whose detached grandchild inherits its stdout still resolves within timeout+grace, timedOut true",
    async () => {
      const started = Date.now();
      const script = [
        "const { spawn } = require('child_process');",
        "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000); setInterval(() => {}, 1000);'], { detached: true, stdio: 'inherit' });",
        "gc.unref();",
        "setTimeout(() => process.exit(0), 5000);",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const result = await runner.run({
        argv: [process.execPath, "-e", script],
        cwd: ".",
        env: { PATH: process.env.PATH ?? "" },
        stdin: "",
        timeoutMs: 300,
        network: "none",
        runsIn: "unsandboxed",
      });
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      // timeoutMs (300) + the runner's own grace period (500) + generous
      // scheduling slack — well under the 5s the escaped grandchild would
      // otherwise hold the fd open for.
      expect(elapsed).toBeLessThan(3000);
    },
    8000,
  );

  test("an env var not on the allowlist and not in command.env never reaches the child", async () => {
    const result = await runner.run({
      argv: [process.execPath, "-e", "process.stdout.write(process.env.SECRET_TOKEN ? 'leaked' : 'clean');"],
      cwd: ".",
      env: buildHookEnv({
        processEnv: { PATH: process.env.PATH ?? "", SECRET_TOKEN: "shhh" },
        hookEvent: "PreToolUse",
        hookId: "h",
        sessionId: "s",
        runId: "r",
        projectRoot: process.cwd(),
        policyProfile: "read-only-review",
      }),
      stdin: "",
      timeoutMs: 5000,
      network: "none",
      runsIn: "unsandboxed",
    });
    expect(result.stdout).toBe("clean");
  });

  test("a cwd escaping the project root is refused", async () => {
    const result = await runner.run({
      argv: [process.execPath, "-e", "process.exit(0);"],
      cwd: "../../outside",
      env: {},
      stdin: "",
      timeoutMs: 1000,
      network: "none",
      runsIn: "unsandboxed",
    });
    expect(result.spawnError).toBe("refused");
  });
});

describe("createRealHookRunner — fail-closed sandbox rules", () => {
  test("runsIn sandbox with an unavailable launcher fails closed", async () => {
    const runner = createRealHookRunner({
      projectRoot: process.cwd(),
      launcher: { available: false, platform: "darwin", reason: "not installed" },
    });
    const result = await runner.run({
      argv: [process.execPath, "-e", "process.exit(0);"],
      cwd: ".",
      env: {},
      stdin: "",
      timeoutMs: 1000,
      network: "none",
      runsIn: "sandbox",
    });
    expect(result.spawnError).toBe("sandbox-unavailable");
  });

  test("runsIn unsandboxed is refused when the profile requires isolation", async () => {
    const runner = createRealHookRunner({
      projectRoot: process.cwd(),
      sandboxProfile: {
        mode: "workspace-write",
        network: "off",
        writableRoots: [],
        readDenyList: [],
        allowedDomains: [],
        required: true,
      },
    });
    const result = await runner.run({
      argv: [process.execPath, "-e", "process.exit(0);"],
      cwd: ".",
      env: {},
      stdin: "",
      timeoutMs: 1000,
      network: "none",
      runsIn: "unsandboxed",
    });
    expect(result.spawnError).toBe("refused");
  });
});
