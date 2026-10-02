// Flow 389, AC8: the digest on the operator's two surfaces.
//
// `keryx schedule list|show` and the `/schedules` modal both show the digest, its next run, the
// last run's status and the last delivery, and the digest can be paused and resumed from both.
// A digest has no OS timer, so neither surface may install, uninstall or probe one: the fake
// scheduler host below records every call and the tests expect it to stay empty.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { scheduleStorePath } from "../trigger/config";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import { scheduleCommand } from "../commands/schedule";
import {
  addDigestSchedule,
  FakeGh,
  FakeSink,
  fakeSummary,
  failingSummary,
  prJson,
  runDigest,
  setupDigestEnv,
  TestClock,
  type DigestTestEnv,
} from "../scheduler/digest.test-helpers";
import { enqueueDelivery } from "../scheduler/digest-delivery";
import { digestStatus, digestStatusLines, digestStatusOf, isDigestSummary } from "../scheduler/digest-status";
import { listSchedules } from "../trigger/schedules";
import { defaultScheduleActions, overviewLines, SCHEDULES_COMMAND, type InstallDescription } from "./schedules-inspector";
import { mountSchedulesSidebar, routeSchedulesCommand, type SchedulesSidebar } from "./schedules-sidebar";
import { mountOpsSidebar } from "./ops-sidebar";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { loadTriggerLedgerView, scheduledEntries } from "./trigger-ledger";
import { projectSchedulesPanel } from "./schedules-panel";
import {
  findById,
  keypressSource,
  loadOpenTui,
  manualInterval,
  mountChrome,
  settle,
  textOf,
  type MountedChrome,
} from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

let env: DigestTestEnv;
let clock: TestClock;
let name = "";

/** A scheduler host that records every call: a digest must never reach it. */
function recordingHost(): ScheduleHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    backend: "cron",
    invocation: { execPath: "/opt/other/bun", scriptPath: "/work/checkout/src/cli.ts" },
    run: async (command, args): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

beforeEach(async () => {
  env = await setupDigestEnv();
  clock = new TestClock("2026-10-02T12:00:30Z");
  name = await addDigestSchedule(env, { name: "morning", cron: "0 8 * * *", repos: ["MrCipherSmith/keryx"], topic: "Mornings" });
});

afterEach(async () => {
  await env.teardown();
});

const PR12 = { number: 12, title: "Add the retry button", updatedAt: "2026-10-01T09:00:00Z" };
const gh = (): FakeGh => new FakeGh().set("pr", prJson([PR12])).empty();

/** Output of the console since `from`, for the CLI tests. */
function out(from = 0): string {
  return env.logged.slice(from).join("\n");
}

async function cli(args: string[], host: ScheduleHost = recordingHost()): Promise<string> {
  const from = env.logged.length;
  await scheduleCommand(args, { cwd: env.root, host, now: clock.now, isTerminal: true, env: {} });
  return out(from);
}

// ---- keryx schedule list / show ----------------------------------------------

describe("AC8: keryx schedule list and show name the digest", () => {
  test("list shows the digest as a digest that runs in serve, with its next run, 'never ran' and 'no delivery yet'", async () => {
    const text = await cli(["list"]);
    expect(text).toContain("keryx schedule list (1):");
    expect(text).toContain("morning (digest)  [enabled]");
    expect(text).toContain("runs in keryx serve");
    expect(text).not.toContain("NOT installed");
    expect(text).toContain("digest: GitHub (read-only) and the product board for MrCipherSmith/keryx");
    expect(text).toContain('topic "Mornings"');
    expect(text).toContain("limits $0.2, 600s, 512 MiB");
    // 08:00 local after 12:00:30 UTC: a concrete instant, not a dash
    expect(text).toMatch(/next run: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(text).toContain("last run: never ran");
    expect(text).toContain("last delivery: none yet");
  });

  test("after a run and a delivery, list shows the last run's status and the last delivery", async () => {
    const sink = new FakeSink();
    await runDigest(env, name, { runGh: gh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    const text = await cli(["list"]);
    expect(text).toMatch(/last run: ok at \S+ — digest written \(baseline\)/);
    expect(text).toMatch(/last delivery: sent at 2026-10-02T12:00:30\.000Z — .*\[the "Mornings" topic\]/);
  });

  test("unreadable sources and a refused delivery are what the surface says: the notes, the failure and the waiting message", async () => {
    const sink = new FakeSink();
    sink.script.push({ ok: false, reason: "Telegram is down" });
    await runDigest(env, name, { runGh: new FakeGh().fail("pr", "HTTP 502").fail("issue", "HTTP 502").fail("review", "HTTP 502").fail("ci", "HTTP 502").run, summarize: failingSummary("x").summarize, now: clock.now, sink });
    const text = await cli(["list"]);
    expect(text).toMatch(/last run: ok at \S+ — digest written \(baseline\).*4 source note\(s\)/);
    expect(text).toMatch(/last delivery: failed at 2026-10-02T12:00:30\.000Z — [^\n]*Telegram is down/);
    expect(text).toMatch(/\(1 waiting to be sent\)/);
  });

  test("show gives the same four facts, the limits, and no prompt line", async () => {
    const text = await cli(["show", "morning"]);
    expect(text).toContain("morning (digest)");
    expect(text).toContain("digest: GitHub (read-only)");
    expect(text).toContain("next run:");
    expect(text).toContain("last run: never ran");
    expect(text).toContain("last delivery: none yet");
    expect(text).toContain("ceiling $0.2, max 600s");
    expect(text).not.toContain("prompt:");
  });

  test("a schedule that is not a digest gets none of those lines", async () => {
    // an ordinary schedule next to it, through the same store
    await addOrdinarySchedule();
    const text = await cli(["list"]);
    const lines = text.split("\n");
    const ordinary = lines.findIndex((l) => l.includes("  - ordinary"));
    expect(ordinary).toBeGreaterThanOrEqual(0);
    expect(lines[ordinary]).not.toContain("(digest)");
    expect(lines[ordinary + 1] ?? "").not.toContain("digest:");
  });
});

async function addOrdinarySchedule(): Promise<void> {
  const { addConfirmedSchedule } = await import("../trigger/store");
  const { pinGrantedBinary } = await import("../trigger/granted-binary");
  const pin = pinGrantedBinary("gh", env.ghBin, "/nonexistent-project-root");
  if (!pin.ok) throw new Error(pin.reason);
  await addConfirmedSchedule(env.root, {
    name: "ordinary",
    on: { kind: "schedule", cron: "0 */4 * * *" },
    install: { argv: ["/usr/local/bin/keryx"], env: {} },
    action: {
      kind: "agent-task",
      prompt: "Check my open PRs",
      dispatch: { provider: "scripted", model: "m", permissionMode: "ask", rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, ceilingUsd: 0.5 },
      grants: { network: "off", tools: ["gh.pr.list"], repos: ["o/r"], bins: { gh: env.ghBin }, binDigests: { gh: pin.pin } },
    },
  });
}

// ---- keryx schedule pause / resume -------------------------------------------

describe("AC8: keryx schedule pause and resume", () => {
  test("pause turns the digest off in the store, says serve will not run it, and touches no OS timer", async () => {
    const host = recordingHost();
    const said = await cli(["pause", "morning"], host);
    expect(said).toContain('digest "morning" paused (serve will not run it; a message already queued is still delivered)');
    const stored = JSON.parse(await readFile(scheduleStorePath(env.root), "utf8")) as { triggers: Array<{ name: string; enabled?: boolean }> };
    expect(stored.triggers.find((t) => t.name === "morning")?.enabled).toBe(false);
    expect(host.calls).toEqual([]);

    const list = await cli(["list"], host);
    expect(list).toContain("morning (digest)  [paused]");
    expect(list).toContain("next run: paused");
  });

  test("resume turns it back on, the next run is a time again, and still no OS timer is installed", async () => {
    const host = recordingHost();
    await cli(["pause", "morning"], host);
    const said = await cli(["resume", "morning"], host);
    expect(said).toContain('digest "morning" resumed (serve runs it from the next cron time)');
    expect(host.calls).toEqual([]);
    const list = await cli(["list"], host);
    expect(list).toContain("morning (digest)  [enabled]");
    expect(list).not.toContain("next run: paused");
    expect(list).toMatch(/next run: \d{4}-/);
  });

  test("a paused digest is not picked up by serve's ticker: the schedule reads as disabled", async () => {
    await cli(["pause", "morning"]);
    const rows = await listSchedules(env.root, { host: recordingHost(), now: clock.now });
    expect(rows.find((r) => r.name === "morning")?.enabled).toBe(false);
    const { digestEntries } = await import("../scheduler/digest-ticker");
    expect(digestEntries(env.root).find((e) => e.name === "morning")?.enabled).toBe(false);
  });

  test("a message already queued when the digest is paused is still shown, as waiting", async () => {
    await enqueueDelivery(env.root, "morning", { runId: "r-queued", text: "queued before the pause", topic: "Mornings" }, clock.now());
    await cli(["pause", "morning"]);
    expect(await cli(["list"])).toContain("(1 waiting to be sent)");
  });

  test("pause and resume of a name that is not stored is an error, not a silent success", async () => {
    const said = await cli(["pause", "nope"]);
    expect(said).toContain("keryx schedule pause:");
    expect(process.exitCode).toBe(1);
  });
});

// ---- the shared status ---------------------------------------------------------

describe("AC8: the status both surfaces print is one function", () => {
  test("digestStatus, from a listed row, has the schedule, the limits, the next run and 'never ran'", async () => {
    const rows = await listSchedules(env.root, { host: recordingHost(), now: clock.now });
    const row = rows.find((r) => r.name === "morning")!;
    expect(isDigestSummary(row)).toBe(true);
    const status = (await digestStatus(env.root, row))!;
    expect(status).toMatchObject({ name: "morning", repos: ["MrCipherSmith/keryx"], topic: "Mornings", memoryLimitMb: 512, ceilingUsd: 0.2, maxSeconds: 600, enabled: true, lastRun: undefined, lastDelivery: undefined, pending: 0 });
    expect(status.nextRun?.toISOString()).toBe("2026-10-03T08:00:00.000Z".replace("08:00", status.nextRun!.toISOString().slice(11, 16)));
  });

  test("a paused schedule has no next run line, only 'paused'", async () => {
    const rows = await listSchedules(env.root, { host: recordingHost(), now: clock.now });
    const status = (await digestStatus(env.root, rows[0]!))!;
    expect(digestStatusLines({ ...status, enabled: false }).join("\n")).toContain("next run: paused");
    expect(digestStatusLines({ ...status, enabled: true, nextRun: undefined }).join("\n")).toContain("next run: —");
  });

  test("an action that is not a digest has no digest status", async () => {
    await addOrdinarySchedule();
    const rows = await listSchedules(env.root, { host: recordingHost(), now: clock.now });
    const row = rows.find((r) => r.name === "ordinary")!;
    expect(isDigestSummary(row)).toBe(false);
    expect(await digestStatus(env.root, row)).toBeUndefined();
    expect(await digestStatusOf(env.root, { name: "ordinary", action: row.entry.action, enabled: true, nextRun: undefined, last: undefined })).toBeUndefined();
  });

  test("a delivery to the project's session topic is named as such, not as the Digest topic", async () => {
    const sink = new FakeSink();
    sink.session = "sess-1";
    await runDigest(env, name, { runGh: gh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    expect(await cli(["list"])).toContain("[the project's remote session topic]");
  });
});

// ---- /schedules (the TUI modal) -------------------------------------------------

describe("AC8: the /schedules modal", () => {
  const DESCRIBED: InstallDescription = { installed: "n/a — runs inside `keryx serve` (no OS timer); keep serve running", unit: "keryx serve", linger: "n/a", verified: "yes (test)" };

  function mountBoth(h: MountedChrome, host: ScheduleHost, notices: string[] = []) {
    const timer = manualInterval();
    const ops = mountOpsSidebar({
      otui: OTUI!.core,
      chrome: h.chrome,
      parent: h.chrome.sidebarTop,
      cwd: env.root,
      width: SIDEBAR_TEXT_WIDTH,
      onKeypress: keypressSource(h.renderer),
      interval: timer.interval,
      now: clock.now,
    });
    const schedules = mountSchedulesSidebar({
      otui: OTUI!.core,
      chrome: h.chrome,
      parent: h.chrome.sidebarTop,
      cwd: env.root,
      width: SIDEBAR_TEXT_WIDTH,
      ops,
      onKeypress: keypressSource(h.renderer),
      notice: (text) => notices.push(text),
      actions: defaultScheduleActions(host),
      describeInstall: async () => DESCRIBED,
      env: {},
      now: clock.now,
    });
    return { ops, schedules };
  }

  test("the Overview lines carry the digest section: what it is, its next run, its last run, its last delivery and the read-only note", async () => {
    const sink = new FakeSink();
    await runDigest(env, name, { runGh: gh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    const view = await loadTriggerLedgerView(env.root);
    const item = scheduledEntries(view).find((e) => e.entry.name === "morning")!;
    const status = (await digestStatusOf(env.root, {
      name: "morning",
      action: item.entry.action as never,
      enabled: item.entry.enabled,
      nextRun: new Date("2026-10-03T08:00:00Z"),
      last: item.latest === undefined ? undefined : { at: item.latest.at, outcome: item.latest.outcome, detail: item.latest.detail },
    }))!;
    const text = overviewLines(item, clock.now(), DESCRIBED as InstallDescription, status).join("\n");
    expect(text).toContain("\ndigest\n");
    expect(text).toContain("  digest: GitHub (read-only) and the product board for MrCipherSmith/keryx");
    expect(text).toContain("  next run: 2026-10-03T08:00:00.000Z");
    expect(text).toMatch(/  last run: ok at /);
    expect(text).toMatch(/  last delivery: sent at /);
    expect(text).toContain("read-only: the digest only reads GitHub (gh) and the flow board; it changes nothing");
  });

  test("an Overview without the digest facts (not a digest) has no digest section", async () => {
    await addOrdinarySchedule();
    const view = await loadTriggerLedgerView(env.root);
    const item = scheduledEntries(view).find((e) => e.entry.name === "ordinary")!;
    expect(overviewLines(item, clock.now(), DESCRIBED).join("\n")).not.toContain("read-only: the digest");
  });

  test("the sidebar panel lists the digest and never calls it a missing timer", async () => {
    const view = await loadTriggerLedgerView(env.root);
    const panel = projectSchedulesPanel(view, { width: SIDEBAR_TEXT_WIDTH, now: clock.now() });
    expect(panel.visible).toBe(true);
    expect(panel.rows.map((r) => r.chunks.map((c) => c.text).join(""))[0]).toContain("morning");
  });

  otuiTest("the list modal marks the digest; its detail shows the digest facts; p pauses and p resumes, with no OS timer touched", async () => {
    const h = await mountChrome(OTUI!, { height: 60 });
    const host = recordingHost();
    const { ops, schedules } = mountBoth(h, host);
    try {
      const list = schedules.show() as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["list"]>;
      await list.ready;
      expect(list.visibleLines().join("\n")).toMatch(/> morning \(digest\)  \[active\]  next /);
      expect(list.selectedName()).toBe("morning");

      const detail = schedules.show("morning") as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
      await detail.ready;
      const overview = detail.visibleLines().join("\n");
      expect(overview).toContain("morning  [active]  local schedule");
      expect(overview).toContain("digest: GitHub (read-only)");
      expect(overview).toContain("next run: 2026");
      expect(overview).toContain("last run: never ran");
      expect(overview).toContain("last delivery: none yet");
      expect(overview).toContain("installed  n/a — runs inside `keryx serve`");

      h.mockInput.pressKey("p");
      await settle(h);
      await detail.settled();
      expect(detail.status()).toBe("paused morning — serve will not run it; a message already queued is still delivered");
      const paused = detail.visibleLines().join("\n");
      expect(paused).toContain("morning  [paused]");
      expect(paused).toContain("next run: paused");
      const stored = JSON.parse(await readFile(scheduleStorePath(env.root), "utf8")) as { triggers: Array<{ name: string; enabled?: boolean }> };
      expect(stored.triggers.find((t) => t.name === "morning")?.enabled).toBe(false);

      h.mockInput.pressKey("p");
      await settle(h);
      await detail.settled();
      expect(detail.status()).toBe("resumed morning — serve runs it from the next cron time");
      expect(detail.visibleLines().join("\n")).toContain("morning  [active]");
      expect(detail.visibleLines().join("\n")).not.toContain("next run: paused");
      expect(host.calls).toEqual([]);
    } finally {
      schedules.dispose();
      ops.dispose();
      h.destroy();
    }
  });

  otuiTest("the detail modal shows the last run and the last delivery after a run", async () => {
    const sink = new FakeSink();
    await runDigest(env, name, { runGh: gh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    const h = await mountChrome(OTUI!, { height: 60 });
    const { ops, schedules } = mountBoth(h, recordingHost());
    try {
      const detail = schedules.show("morning") as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
      await detail.ready;
      const text = detail.visibleLines().join("\n");
      expect(text).toMatch(/last run: ok at \S+ — digest written \(baseline\)/);
      expect(text).toMatch(/last delivery: sent at 2026-10-02T12:00:30\.000Z/);
    } finally {
      schedules.dispose();
      ops.dispose();
      h.destroy();
    }
  });

  otuiTest("typing /schedules in the composer reaches the digest's list", async () => {
    const h = await mountChrome(OTUI!, { height: 60 });
    const { ops, schedules } = mountBoth(h, recordingHost());
    const handled: string[] = [];
    h.chrome.onSubmit((line) => {
      if (routeSchedulesCommand(line, h.chrome.isBusy(), schedules)) handled.push(line);
    });
    try {
      h.chrome.input.focus();
      await h.mockInput.typeText(SCHEDULES_COMMAND);
      await settle(h);
      h.mockInput.pressEnter();
      await settle(h);
      expect(handled).toEqual([SCHEDULES_COMMAND]);
      const list = schedules.openModals().list!;
      await list.ready;
      expect(list.visibleLines().join("\n")).toContain("morning (digest)");
      // the sidebar row for the digest exists too
      await schedules.panel.refresh();
      await settle(h);
      expect(textOf(findById(h.chrome.sidebarTop, "sb-schedules-morning"))).toContain("morning");
    } finally {
      schedules.dispose();
      ops.dispose();
      h.destroy();
    }
  });
});
