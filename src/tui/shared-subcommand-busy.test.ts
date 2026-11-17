// Busy classification of the shared text subcommands (Keryx Desktop Client M2a, D-10): the class follows
// the command, never its argument, so a subcommand form is classified like its bare command.

import { expect, test } from "bun:test";
import { classifyBusyDispatch } from "./busy-dispatch";

const base = { isSessionInfo: false, isFlows: false, isWorkspace: false, isReview: false, isMcp: false, isMcpConsumer: false };
const classify = (line: string, commandName: string, flags: Partial<typeof base> = {}) => classifyBusyDispatch({ line, commandName, ...base, ...flags });

test("the commands whose modals open while busy classify the same with a subcommand", () => {
  expect(classify("/schedules pause nightly", "/schedules")).toBe(classify("/schedules", "/schedules"));
  expect(classify("/schedules pause nightly", "/schedules")).toBe("schedules");
  expect(classify("/triggers run on-push", "/triggers")).toBe("triggers");
  expect(classify("/governance close 12", "/governance")).toBe("governance");
  expect(classify("/review accept ws p", "/review", { isReview: true })).toBe("review");
});

test("the commands that wait for the turn's end are queued with a subcommand, as bare", () => {
  for (const [line, name] of [
    ["/routing set coding baseline", "/routing"],
    ["/routing trust", "/routing"],
    ["/jevprofile apply", "/jevprofile"],
    ["/ac recheck 12", "/ac"],
    ["/ci triage 9", "/ci"],
    ["/conform run a b", "/conform"],
    ["/task fix it", "/task"],
  ] as const) {
    expect(classify(line, name), line).toBe("deferred");
    expect(classify(name, name), name).toBe("deferred");
  }
});
