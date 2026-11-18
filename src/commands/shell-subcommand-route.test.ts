// The terminal's routing of the shared text subcommands (Keryx Desktop Client M2a, D-10): which
// lines are recognized, which ask first, and that nothing destructive runs on a "no".

import { describe, expect, test } from "bun:test";
import { matchSharedSubcommand, routeSharedSubcommandLine, runSharedSubcommand, sharedSubcommandCommands, type SharedSubcommandActions } from "./shell-subcommand-route";
import type { ActionResult } from "./shell-subcommands";

/** Every action records its call and answers ok; nothing touches disk. */
function recorder(): { actions: SharedSubcommandActions; calls: string[] } {
  const calls: string[] = [];
  const answer = (name: string) => async (...args: unknown[]): Promise<ActionResult> => {
    calls.push(`${name}(${args.filter((arg) => typeof arg === "string").join("|")})`);
    return { ok: true, text: `${name} done\n` };
  };
  const actions = {
    routingSet: answer("routingSet"),
    routingTrust: (...args: unknown[]) => {
      calls.push(`routingTrust(${args.length})`);
      return { ok: true, text: "routingTrust done\n" };
    },
    jevProfileSet: answer("jevProfileSet"),
    jevProfileApply: answer("jevProfileApply"),
    reviewDecide: answer("reviewDecide"),
    triggerRunNow: answer("triggerRunNow"),
    schedulePause: answer("schedulePause"),
    scheduleResume: answer("scheduleResume"),
    scheduleDelete: answer("scheduleDelete"),
    scheduleRuns: answer("scheduleRuns"),
    scheduleRunLog: answer("scheduleRunLog"),
    governanceRun: answer("governanceRun"),
    governanceCheck: answer("governanceCheck"),
    governanceClose: answer("governanceClose"),
    acRecheck: answer("acRecheck"),
    ciTriage: answer("ciTriage"),
    conformRun: answer("conformRun"),
    taskSubmit: answer("taskSubmit"),
  } as unknown as SharedSubcommandActions;
  return { actions, calls };
}

const cwd = "/nowhere";

describe("which lines are shared subcommands", () => {
  test("a bare command is not matched: it keeps opening its modal", () => {
    const { actions } = recorder();
    for (const command of sharedSubcommandCommands()) {
      expect(matchSharedSubcommand(command, { cwd, actions })).toBeUndefined();
    }
  });

  test("a name or an unknown word after a command is not matched", () => {
    const { actions } = recorder();
    for (const line of ["/schedules nightly", "/triggers nightly", "/routing frobnicate", "/review layers", "/review parity", "/conform now", "/governance report", "/ac"]) {
      expect(matchSharedSubcommand(line, { cwd, actions })).toBeUndefined();
    }
  });

  test("text that is not a command, or a command with no shared form, is not matched", () => {
    const { actions } = recorder();
    expect(matchSharedSubcommand("schedules pause nightly", { cwd, actions })).toBeUndefined();
    expect(matchSharedSubcommand("", { cwd, actions })).toBeUndefined();
    expect(matchSharedSubcommand("/model pause x", { cwd, actions })).toBeUndefined();
    expect(matchSharedSubcommand("/decisions arms", { cwd, actions })).toBeUndefined();
  });

  test("every form the desktop sends is matched, with the same arguments", async () => {
    const { actions, calls } = recorder();
    const forms: ReadonlyArray<readonly [string, string]> = [
      ["/schedules pause nightly", "schedulePause(/nowhere|nightly)"],
      ["/schedules resume nightly", "scheduleResume(/nowhere|nightly)"],
      ["/schedules delete nightly", "scheduleDelete(/nowhere|nightly)"],
      ["/schedules run nightly", "triggerRunNow(/nowhere|nightly)"],
      ["/schedules runs nightly", "scheduleRuns(/nowhere|nightly)"],
      ["/schedules run-log nightly r1", "scheduleRunLog(/nowhere|nightly r1)"],
      ["/triggers run on-push", "triggerRunNow(/nowhere|on-push)"],
      ["/routing set coding anthropic/sonnet", "routingSet(coding anthropic/sonnet)"],
      ["/jevprofile set risk on", "jevProfileSet(/nowhere|risk on)"],
      ["/jevprofile apply", "jevProfileApply(/nowhere)"],
      ["/review accept ws-1 p-2", "reviewDecide(/nowhere|accept|ws-1 p-2)"],
      ["/review accept-ack ws-1 p-2", "reviewDecide(/nowhere|accept-ack|ws-1 p-2)"],
      ["/review decline ws-1 p-2", "reviewDecide(/nowhere|decline|ws-1 p-2)"],
      ["/ac recheck 12", "acRecheck(/nowhere|12)"],
      ["/ci triage 99 build", "ciTriage(/nowhere|99 build)"],
      ["/conform run spec docs/spec.md", "conformRun(/nowhere|spec docs/spec.md)"],
      ["/governance run", "governanceRun(/nowhere)"],
      ["/governance check 12", "governanceCheck(/nowhere|12)"],
      ["/governance close 12", "governanceClose(/nowhere|12)"],
      ["/task fix the login bug || it works; tests pass", "taskSubmit(/nowhere|fix the login bug || it works; tests pass)"],
    ];
    for (const [line, expected] of forms) {
      calls.length = 0;
      const match = matchSharedSubcommand(line, { cwd, actions });
      expect(match, line).toBeDefined();
      await match?.run();
      expect(calls, line).toEqual([expected]);
    }
  });

  test("the command word is case-insensitive and extra spaces are fine", () => {
    const { actions } = recorder();
    expect(matchSharedSubcommand("  /Schedules   PAUSE   nightly ", { cwd, actions })?.verb).toBe("pause");
  });
});

describe("which forms ask first", () => {
  const asking = [
    "/schedules run nightly",
    "/schedules delete nightly",
    "/triggers run on-push",
    "/jevprofile apply",
    "/review accept ws-1 p-2",
    "/review accept-ack ws-1 p-2",
    "/review decline ws-1 p-2",
    "/ac recheck 12",
    "/ci triage 99",
    "/conform run spec docs/spec.md",
    "/governance close 12",
    "/routing trust",
    "/task fix something",
  ];
  const unasked = ["/schedules pause nightly", "/schedules resume nightly", "/routing set coding baseline", "/jevprofile set risk off", "/governance run", "/governance check 12"];

  test("deleting, running, applying, accepting, declining, closing, trusting and starting a task ask", () => {
    const { actions } = recorder();
    for (const line of asking) {
      expect(matchSharedSubcommand(line, { cwd, actions })?.confirm, line).toBeDefined();
    }
  });

  test("the reversible and read-only ones run unasked", () => {
    const { actions } = recorder();
    for (const line of unasked) {
      expect(matchSharedSubcommand(line, { cwd, actions })?.confirm, line).toBeUndefined();
    }
  });

  test("a form missing its argument answers its usage line instead of asking", () => {
    const { actions } = recorder();
    for (const line of ["/schedules delete", "/review accept", "/ac recheck", "/governance close"]) {
      expect(matchSharedSubcommand(line, { cwd, actions })?.confirm, line).toBeUndefined();
    }
  });

  test("the question names what it is about", async () => {
    const { actions } = recorder();
    expect(await matchSharedSubcommand("/schedules delete nightly", { cwd, actions })?.confirm?.()).toContain("Delete schedule nightly");
    expect(await matchSharedSubcommand("/review accept ws-1 p-2", { cwd, actions })?.confirm?.()).toContain("p-2");
    expect(await matchSharedSubcommand("/governance close 12", { cwd, actions })?.confirm?.()).toContain("flow 12");
  });
});

describe("runSharedSubcommand", () => {
  test("a yes runs the action and prints its text", async () => {
    const { actions, calls } = recorder();
    const match = matchSharedSubcommand("/schedules delete nightly", { cwd, actions });
    const printed: string[] = [];
    const asked: string[] = [];
    const result = await runSharedSubcommand(match as NonNullable<typeof match>, {
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
      print: (text) => printed.push(text),
    });
    expect(asked).toHaveLength(1);
    expect(calls).toEqual(["scheduleDelete(/nowhere|nightly)"]);
    expect(printed).toEqual(["scheduleDelete done\n"]);
    expect(result?.ok).toBe(true);
  });

  test("a no never runs a destructive action, and says nothing changed", async () => {
    const { actions, calls } = recorder();
    for (const line of ["/schedules delete nightly", "/schedules run nightly", "/jevprofile apply", "/review accept ws p", "/governance close 3", "/task fix it", "/ci triage 1", "/conform run a b", "/ac recheck 3", "/triggers run x"]) {
      const printed: string[] = [];
      const match = matchSharedSubcommand(line, { cwd, actions });
      const result = await runSharedSubcommand(match as NonNullable<typeof match>, { confirm: async () => false, print: (text) => printed.push(text) });
      expect(result, line).toBeUndefined();
      expect(printed.join(""), line).toContain("cancelled, nothing changed");
    }
    expect(calls).toEqual([]);
  });

  test("an unasked form runs without consulting the confirm surface", async () => {
    const { actions, calls } = recorder();
    const match = matchSharedSubcommand("/schedules pause nightly", { cwd, actions });
    await runSharedSubcommand(match as NonNullable<typeof match>, {
      confirm: async () => {
        throw new Error("must not ask");
      },
      print: () => {},
    });
    expect(calls).toEqual(["schedulePause(/nowhere|nightly)"]);
  });

  test("an action that throws is printed, not thrown", async () => {
    const { actions } = recorder();
    const broken: SharedSubcommandActions = {
      ...actions,
      schedulePause: async () => {
        throw new Error("disk on fire");
      },
    };
    const match = matchSharedSubcommand("/schedules pause nightly", { cwd, actions: broken });
    const printed: string[] = [];
    await runSharedSubcommand(match as NonNullable<typeof match>, { confirm: async () => true, print: (text) => printed.push(text) });
    expect(printed.join("")).toContain("disk on fire");
  });

  test("a refusal from the action is printed as it is", async () => {
    const { actions } = recorder();
    const refusing: SharedSubcommandActions = { ...actions, routingSet: async () => ({ ok: false, text: "Usage: /routing set <category> <provider/model | baseline>\n" }) };
    const match = matchSharedSubcommand("/routing set", { cwd, actions: refusing });
    const printed: string[] = [];
    const result = await runSharedSubcommand(match as NonNullable<typeof match>, { confirm: async () => true, print: (text) => printed.push(text) });
    expect(result?.ok).toBe(false);
    expect(printed.join("")).toContain("Usage: /routing set");
  });
});

describe("routeSharedSubcommandLine (what the full-screen shell calls)", () => {
  test("a bare command is not routed, so the modal opens as before", () => {
    const { actions } = recorder();
    const surface = { confirm: async () => true, print: () => {} };
    for (const line of ["/schedules", "/routing", "/review", "/task", "/ac", "/ci", "/conform", "/jevprofile", "/triggers", "/governance"]) {
      expect(routeSharedSubcommandLine(line, { cwd, actions }, surface), line).toBeUndefined();
    }
  });

  test("a destructive form asks through the surface and runs only on yes", async () => {
    const { actions, calls } = recorder();
    const questions: string[] = [];
    await routeSharedSubcommandLine("/schedules delete nightly", { cwd, actions }, { confirm: async (q) => (questions.push(q), false), print: () => {} });
    expect(questions).toHaveLength(1);
    expect(calls).toEqual([]);
    await routeSharedSubcommandLine("/schedules delete nightly", { cwd, actions }, { confirm: async (q) => (questions.push(q), true), print: () => {} });
    expect(calls).toEqual(["scheduleDelete(/nowhere|nightly)"]);
  });
});
