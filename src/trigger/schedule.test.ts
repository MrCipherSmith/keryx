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
});
