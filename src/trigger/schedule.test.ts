// Flow 286 T10, AC6: `renderScheduleLines` / `resolveScheduleEntry` — the
// core-zone half of `keryx trigger schedule <name>`. The "the printed line
// is exercised by a test that runs it as the scheduler would" half of AC6 is
// proven at the command level, in `../commands/trigger-schedule.e2e.test.ts`
// (a real spawn, minimal PATH, no TTY) — this file covers the shape and the
// resolution logic.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invocationArgv, isBunExecPath, projectScheduleHash, renderScheduleLines, resolveKeryxInvocation, resolveScheduleEntry, type KeryxInvocation } from "./schedule";
import { triggersConfigPath } from "./config";

async function writeTriggers(root: string, triggers: unknown[]): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(triggersConfigPath(root), JSON.stringify({ schemaVersion: 1, triggers }), "utf8");
}

const FAKE_INVOCATION: KeryxInvocation = { execPath: "/opt/node/bin/node", scriptPath: "/opt/keryx/dist/cli.js" };

describe("resolveScheduleEntry", () => {
  test("no config: 'config-absent'", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-"));
    expect(resolveScheduleEntry(root, "nightly")).toEqual({ kind: "config-absent" });
  });

  test("unknown name: lists what IS known", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-"));
    await writeTriggers(root, [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }]);
    expect(resolveScheduleEntry(root, "nope")).toEqual({ kind: "unknown-name", known: ["nightly"] });
  });

  test("an event-fired entry by that name: 'not-a-schedule'", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-"));
    await writeTriggers(root, [{ name: "on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } }]);
    const result = resolveScheduleEntry(root, "on-merge");
    expect(result.kind).toBe("not-a-schedule");
  });

  test("a schedule entry: 'ready'", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-"));
    await writeTriggers(root, [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }]);
    const result = resolveScheduleEntry(root, "nightly");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.entry.fire.cron).toBe("0 2 * * *");
  });
});

describe("renderScheduleLines", () => {
  test("the cron line never says bare `keryx` — it bakes in the resolved interpreter and script by absolute path", () => {
    const lines = renderScheduleLines({ projectRoot: "/srv/project", name: "nightly", cron: "0 2 * * *", invocation: FAKE_INVOCATION });
    expect(lines.cronLine.startsWith("0 2 * * * ")).toBe(true);
    expect(lines.cronCommand).toContain("/opt/node/bin/node");
    expect(lines.cronCommand).toContain("/opt/keryx/dist/cli.js");
    expect(lines.cronCommand).not.toContain("' keryx "); // no bare "keryx" invoked as a command word
    expect(lines.cronCommand.startsWith("keryx ")).toBe(false);
    expect(lines.cronCommand).toContain("trigger run 'nightly'");
  });

  test("the assumed PATH includes the interpreter's own directory plus standard git locations", () => {
    const lines = renderScheduleLines({ projectRoot: "/srv/project", name: "nightly", cron: "0 2 * * *", invocation: FAKE_INVOCATION });
    expect(lines.assumedPath).toBe("/opt/node/bin:/usr/local/bin:/usr/bin:/bin");
    expect(lines.cronCommand).toContain(`PATH='${lines.assumedPath}'`);
  });

  test("the systemd service ExecStart uses the same absolute-path invocation, no bare `keryx`", () => {
    const lines = renderScheduleLines({ projectRoot: "/srv/project", name: "nightly", cron: "0 2 * * *", invocation: FAKE_INVOCATION });
    // flow 319: FAKE_INVOCATION's interpreter is /opt/node/bin/node — Node, not
    // Bun — so no SAFE_BUN_SPAWN_ARGS here (Node does not accept those flags
    // and refuses to start with them). See the bun-interpreter case below.
    expect(lines.systemdService).toContain("ExecStart=/opt/node/bin/node /opt/keryx/dist/cli.js trigger run nightly");
    expect(lines.systemdService).not.toContain("--no-env-file");
    expect(lines.systemdService).toContain("WorkingDirectory=/srv/project");
    // Flow 295 (AC8): a REAL OnCalendar= (flow 286 printed only a commented
    // placeholder, which never fired), and a project-unique unit name.
    expect(lines.systemdTimer).toContain("\nOnCalendar=*-*-* 02:00:00\n");
    expect(lines.systemdTimer).not.toContain("# OnCalendar=");
    expect(lines.systemdTimer).toContain("0 2 * * *"); // the cron expression it was translated from
    expect(lines.timerUnitName).toBe(`keryx-${projectScheduleHash("/srv/project")}-nightly.timer`);
  });

  test("flow 319: a BUN interpreter DOES get SAFE_BUN_SPAWN_ARGS in ExecStart (only Node is exempt)", () => {
    const lines = renderScheduleLines({
      projectRoot: "/srv/project",
      name: "nightly",
      cron: "0 2 * * *",
      invocation: { execPath: "/opt/bun/bin/bun", scriptPath: "/opt/keryx/dist/cli.js" },
    });
    expect(lines.systemdService).toContain("ExecStart=/opt/bun/bin/bun --no-env-file --config=/dev/null /opt/keryx/dist/cli.js trigger run nightly");
  });

  test("a cron with no systemd equivalent keeps the placeholder and says why", () => {
    const lines = renderScheduleLines({ projectRoot: "/srv/project", name: "odd", cron: "0 9 1 * 1", invocation: FAKE_INVOCATION });
    expect(lines.onCalendar.ok).toBe(false);
    expect(lines.systemdTimer).toContain("# OnCalendar=");
    expect(lines.systemdTimer).toContain("has no systemd equivalent");
  });

  // Flow 295 (AC8): the timer `keryx trigger schedule` prints fires when the cron
  // says, proven by systemd itself.
  const calendarTool = Bun.which("systemd-analyze");
  test.skipIf(!calendarTool)("the printed timer's OnCalendar= fires on the translated schedule (systemd-analyze calendar)", async () => {
    const lines = renderScheduleLines({ projectRoot: "/srv/project", name: "every4h", cron: "0 */4 * * *", invocation: FAKE_INVOCATION });
    const value = /^OnCalendar=(.+)$/m.exec(lines.systemdTimer)?.[1];
    expect(value).toBeDefined();
    const proc = Bun.spawn([calendarTool!, "calendar", "--iterations=6", "--base-time=2026-09-23 00:30:00", value!], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const hours = [...out.matchAll(/(?:Next elapse|Iteration #\d+): \w{3} 2026-09-23 (\d{2}):00:00/g)].map((m) => m[1]);
    expect(hours).toEqual(["04", "08", "12", "16", "20"]);
  });

  test("a project root or name containing a single quote is still shell-safe", () => {
    const lines = renderScheduleLines({
      projectRoot: "/srv/it's-a-project",
      name: "nightly",
      cron: "0 2 * * *",
      invocation: FAKE_INVOCATION,
    });
    expect(lines.cronCommand).toContain(`'/srv/it'\\''s-a-project'`);
  });

  // Review finding 2 (T15): the systemd block used to interpolate
  // projectRoot/logDir/execPath/scriptPath/name RAW into WorkingDirectory=,
  // ExecStartPre= and ExecStart=, and the printed cron line was not escaped
  // for cron's own `%`-as-newline rule independently of shell quoting.
  describe("review finding 2: a project path containing a space", () => {
    const lines = renderScheduleLines({
      projectRoot: "/srv/my project",
      name: "nightly",
      cron: "0 2 * * *",
      invocation: FAKE_INVOCATION,
    });

    test("systemd ExecStartPre quotes the space-containing token so it is not split into two argv words", () => {
      // The interpreter/script paths carry no space in this fixture, so they
      // stay unquoted (unchanged rendering); only `name` here is untouched by
      // the space (it's the project root that has one) — this asserts
      // ExecStartPre, which is word-split/list-typed and DOES carry logDir.
      expect(lines.systemdService).toContain('ExecStartPre=-/bin/mkdir -p "/srv/my project/.metaproject/data/trigger"');
    });

    // Review finding (T16): `WorkingDirectory=` takes the rest of the line
    // VERBATIM — systemd does not run syntax(7)'s quote-removal on it (it is
    // a single-value directive, not word-split/list-typed like `Exec*=`). A
    // literal `"` there is not stripped as quoting; systemd reads it as part
    // of the path, decides the value is not absolute, and refuses the whole
    // unit. So this must stay UNQUOTED even though it contains a space.
    test("systemd WorkingDirectory is left unquoted (systemd does not unquote it — quoting it breaks unit load)", () => {
      expect(lines.systemdService).toContain("WorkingDirectory=/srv/my project");
      expect(lines.systemdService).not.toContain('WorkingDirectory="/srv/my project"');
    });

    // Review finding (T16): same reasoning as WorkingDirectory= — `append:path`
    // is a single verbatim value; systemd's `append:` prefix parser fails on
    // a leading `"`, and the unit silently falls back to the journal instead
    // of appending to the log path we promise.
    test("systemd StandardOutput/StandardError are left unquoted (append: prefix parsing fails on a leading quote)", () => {
      expect(lines.systemdService).toContain("StandardOutput=append:/srv/my project/.metaproject/data/trigger/nightly.schedule.log");
      expect(lines.systemdService).toContain("StandardError=append:/srv/my project/.metaproject/data/trigger/nightly.schedule.log");
      expect(lines.systemdService).not.toContain('StandardOutput="append:');
      expect(lines.systemdService).not.toContain('StandardError="append:');
    });

    test("systemd ExecStart quotes a space-containing interpreter/script path", () => {
      // flow 319: a bun interpreter here (not node — a node one gets no
      // SAFE_BUN_SPAWN_ARGS, see the dedicated interpreter-detection tests
      // below), so the flags this test is actually about (quoting) are present.
      const spaced = renderScheduleLines({
        projectRoot: "/srv/project",
        name: "nightly",
        cron: "0 2 * * *",
        invocation: { execPath: "/opt/my bun/bin/bun", scriptPath: "/opt/keryx dist/cli.js" },
      });
      expect(spaced.systemdService).toContain(
        'ExecStart="/opt/my bun/bin/bun" --no-env-file --config=/dev/null "/opt/keryx dist/cli.js" trigger run nightly',
      );
    });

    test("cron line is unaffected by shell quoting alone: the cronCommand itself already single-quotes the space", () => {
      expect(lines.cronCommand).toContain(`'/srv/my project'`);
    });
  });

  describe("review finding 2: a project path containing a literal `%`", () => {
    const lines = renderScheduleLines({
      projectRoot: "/srv/100%-done",
      name: "nightly",
      cron: "0 2 * * *",
      invocation: FAKE_INVOCATION,
    });

    test("systemd doubles a literal `%` in Description=, WorkingDirectory=, ExecStartPre= and ExecStart=", () => {
      // No whitespace here (only a `%`), so no quoting is needed or added —
      // only the `%%` doubling changes versus the unescaped input.
      expect(lines.systemdService).toContain('Description=keryx trigger "nightly" (/srv/100%%-done)');
      expect(lines.systemdService).toContain("WorkingDirectory=/srv/100%%-done");
      expect(lines.systemdService).toContain("ExecStartPre=-/bin/mkdir -p /srv/100%%-done/.metaproject/data/trigger");
    });

    test("systemd doubles a literal `%` carried by the trigger name in ExecStart=", () => {
      const named = renderScheduleLines({
        projectRoot: "/srv/project",
        name: "100%-nightly",
        cron: "0 2 * * *",
        invocation: FAKE_INVOCATION,
      });
      expect(named.systemdService).toContain("trigger run 100%%-nightly");
    });

    test("the printed cron line escapes `%` (cron reads an unescaped `%` as a newline before `/bin/sh` runs), independently of the standalone cronCommand", () => {
      const named = renderScheduleLines({
        projectRoot: "/srv/project",
        name: "100%-nightly",
        cron: "0 2 * * *",
        invocation: FAKE_INVOCATION,
      });
      // The crontab-ready line has every `%` backslash-escaped...
      expect(named.cronLine).toContain("100\\%-nightly");
      expect(named.cronLine).not.toMatch(/(?<!\\)%/);
      // ...but the standalone `cronCommand` (fed straight to `/bin/sh -c` by
      // the AC6 e2e test, bypassing crontab's own preprocessing) is NOT
      // escaped — a backslash there would be a literal extra character in
      // the shell's argv.
      expect(named.cronCommand).toContain("100%-nightly");
      expect(named.cronCommand).not.toContain("100\\%-nightly");
    });
  });

  // Review finding (T16): the T15 fix over-applied `systemdQuote` to
  // `WorkingDirectory=`/`StandardOutput=`/`StandardError=`, which systemd
  // does NOT unquote — string-matching assertions alone let that regression
  // through once before (the T15 tests above pinned the buggy quoted form as
  // expected). This test closes that gap structurally: it feeds the
  // generated unit to the REAL `systemd-analyze verify` rather than asserting
  // on the string. A quoted `WorkingDirectory=` makes systemd read the value
  // as not-absolute and refuse the whole unit, which `verify` reports as a
  // failure — so a future re-introduction of this bug fails the test even if
  // nobody thinks to update a string assertion for it.
  describe("review finding (T16): systemd-analyze verify on a project path containing a space", () => {
    const systemdAnalyzePath = Bun.which("systemd-analyze");
    const skipReason = systemdAnalyzePath
      ? ""
      : "systemd-analyze not found on PATH (only available on a systemd Linux host)";

    test.skipIf(!systemdAnalyzePath)(
      skipReason
        ? `the generated .service unit verifies cleanly [SKIPPED: ${skipReason}]`
        : "the generated .service unit verifies cleanly",
      async () => {
        // `systemd-analyze verify` resolves ExecStart='s binary on disk (it is
        // not just a syntax check) — FAKE_INVOCATION's fabricated
        // `/opt/node/bin/node` does not exist on this machine, which verify
        // correctly flags. `/bin/true` is present on every POSIX box this
        // test runs on and is executable, which is all verify checks for it.
        const lines = renderScheduleLines({
          projectRoot: "/srv/my project",
          name: "nightly",
          cron: "0 2 * * *",
          invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
        });
        const dir = await mkdtemp(path.join(tmpdir(), "keryx-schedule-unit-verify-"));
        // systemd-analyze verify requires a recognized unit suffix on the path.
        const unitPath = path.join(dir, "keryx-trigger-nightly.service");
        try {
          await writeFile(unitPath, lines.systemdService, "utf8");
          const proc = Bun.spawn([systemdAnalyzePath!, "verify", unitPath], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          if (exitCode !== 0) {
            throw new Error(
              `systemd-analyze verify rejected the generated unit (exit ${exitCode})\n` +
                `unit:\n${lines.systemdService}\nstdout: ${stdout}\nstderr: ${stderr}`,
            );
          }
          expect(exitCode).toBe(0);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  });
});

// Flow 300 review F2: a `bun build --compile` binary reports its entry as
// `/$bunfs/root/<name>` (Windows: `B:\~BUN\root\<name>`). That path exists
// only inside the binary; passing it as an argument shifted every one after it.
describe("resolveKeryxInvocation on a compiled binary", () => {
  test("a /$bunfs/ entry is the binary alone — no script argument", () => {
    const invocation = resolveKeryxInvocation("/$bunfs/root/keryx", "/usr/local/bin/keryx");
    expect(invocation).toEqual({ execPath: "/usr/local/bin/keryx" });
    expect(invocationArgv(invocation)).toEqual(["/usr/local/bin/keryx"]);
  });

  test("a Windows ~BUN entry is the binary alone too", () => {
    expect(invocationArgv(resolveKeryxInvocation("B:\\~BUN\\root\\keryx.exe", "C:\\keryx\\keryx.exe"))).toEqual(["C:\\keryx\\keryx.exe"]);
  });

  test("a real script entry keeps [interpreter, ...safe flags, absolute script] — R2-02: every self-spawn carries SAFE_BUN_SPAWN_ARGS", () => {
    expect(invocationArgv(resolveKeryxInvocation("dist/cli.js", "/opt/bun/bin/bun"))).toEqual([
      "/opt/bun/bin/bun",
      "--no-env-file",
      "--config=/dev/null",
      path.resolve("dist/cli.js"),
    ]);
  });

  test("the printed cron line and systemd ExecStart run the binary directly, arguments unshifted", () => {
    const lines = renderScheduleLines({
      projectRoot: "/srv/project",
      name: "nightly",
      cron: "0 2 * * *",
      invocation: resolveKeryxInvocation("/$bunfs/root/keryx", "/usr/local/bin/keryx"),
    });
    expect(lines.cronCommand).toContain("'/usr/local/bin/keryx' trigger run 'nightly'");
    expect(lines.cronCommand).not.toContain("$bunfs");
    expect(lines.systemdService).toContain("ExecStart=/usr/local/bin/keryx trigger run nightly");
    expect(lines.systemdService).not.toContain("$bunfs");
  });
});

// Flow 319 (CI, R1): SAFE_BUN_SPAWN_ARGS are Bun-only flags. Node refuses to
// start with them, so `invocationArgv` must insert them ONLY for a Bun
// interpreter — decided by `isBunExecPath`, exercised here directly.
describe("invocationArgv: SAFE_BUN_SPAWN_ARGS only for a Bun interpreter", () => {
  test("a node interpreter gets [execPath, scriptPath] — no safe flags", () => {
    expect(invocationArgv({ execPath: "/opt/node/bin/node", scriptPath: "/opt/keryx/cli.js" })).toEqual([
      "/opt/node/bin/node",
      "/opt/keryx/cli.js",
    ]);
  });

  test("a bun interpreter gets the safe flags inserted between execPath and scriptPath", () => {
    expect(invocationArgv({ execPath: "/opt/bun/bin/bun", scriptPath: "/opt/keryx/cli.js" })).toEqual([
      "/opt/bun/bin/bun",
      "--no-env-file",
      "--config=/dev/null",
      "/opt/keryx/cli.js",
    ]);
  });

  test("bunx and the .exe Windows spellings of both are recognized by basename", () => {
    for (const execPath of ["/usr/local/bin/bunx", "C:\\bun\\bun.exe", "C:\\bun\\bunx.exe"]) {
      expect(invocationArgv({ execPath, scriptPath: "/opt/keryx/cli.js" })).toEqual([
        execPath,
        "--no-env-file",
        "--config=/dev/null",
        "/opt/keryx/cli.js",
      ]);
    }
  });

  test("node.exe (Windows) is still recognized as node, not bun — no flags", () => {
    expect(invocationArgv({ execPath: "C:\\node\\node.exe", scriptPath: "C:\\keryx\\cli.js" })).toEqual(["C:\\node\\node.exe", "C:\\keryx\\cli.js"]);
  });

  test("isBunExecPath: a non-bun-named execPath is still recognized when it IS this (bun-run) test process's own execPath", () => {
    // `bun test` runs this file under Bun itself, so process.execPath is a
    // real bun binary, whatever it happens to be named — proves the
    // "this process's own execPath, under Bun" fallback, independent of the
    // basename check above.
    expect(isBunExecPath(process.execPath)).toBe(true);
  });

  test("isBunExecPath: an unrelated path that is neither bun-named nor this process's own execPath is not bun", () => {
    expect(isBunExecPath("/opt/some-other-interpreter")).toBe(false);
  });
});
