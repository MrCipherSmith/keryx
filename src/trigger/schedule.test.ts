// Flow 286 T10, AC6: `renderScheduleLines` / `resolveScheduleEntry` — the
// core-zone half of `keryx trigger schedule <name>`. The "the printed line
// is exercised by a test that runs it as the scheduler would" half of AC6 is
// proven at the command level, in `../commands/trigger-schedule.e2e.test.ts`
// (a real spawn, minimal PATH, no TTY) — this file covers the shape and the
// resolution logic.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderScheduleLines, resolveScheduleEntry, type KeryxInvocation } from "./schedule";
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
    expect(lines.systemdService).toContain("ExecStart=/opt/node/bin/node /opt/keryx/dist/cli.js trigger run nightly");
    expect(lines.systemdService).toContain("WorkingDirectory=/srv/project");
    expect(lines.systemdTimer).toContain('OnCalendar=');
    expect(lines.systemdTimer).toContain("0 2 * * *"); // the cron expression is at least surfaced for translation
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

    test("systemd ExecStart quotes the space-containing token so it is not split into two argv words", () => {
      // The interpreter/script paths carry no space in this fixture, so they
      // stay unquoted (unchanged rendering); only `name` here is untouched by
      // the space (it's the project root that has one) — this asserts
      // WorkingDirectory/ExecStartPre, which DO carry projectRoot/logDir.
      expect(lines.systemdService).toContain('WorkingDirectory="/srv/my project"');
      expect(lines.systemdService).toContain('ExecStartPre=-/bin/mkdir -p "/srv/my project/.metaproject/data/trigger"');
    });

    test("systemd ExecStart quotes a space-containing interpreter/script path", () => {
      const spaced = renderScheduleLines({
        projectRoot: "/srv/project",
        name: "nightly",
        cron: "0 2 * * *",
        invocation: { execPath: "/opt/my node/bin/node", scriptPath: "/opt/keryx dist/cli.js" },
      });
      expect(spaced.systemdService).toContain('ExecStart="/opt/my node/bin/node" "/opt/keryx dist/cli.js" trigger run nightly');
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
});
