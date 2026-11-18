import { describe, expect, test } from "bun:test";
import { nextStepHint, stateActions, type StateActionId } from "./model";

const on = (status: string, blocked = false, criteria = 2): Record<StateActionId | string, boolean> =>
  Object.fromEntries(stateActions({ status, blocked }, criteria).map((a) => [a.id, a.enabled]));

describe("flow state buttons follow keryx's transitions", () => {
  test("initializing: freeze is the step, start is off and says to freeze first", () => {
    expect(on("initializing")).toEqual({ freeze: true, start: false, block: true, next: true });
    const start = stateActions({ status: "initializing", blocked: false }, 2).find((a) => a.id === "start")!;
    expect(start.hint).toMatch(/Freeze the criteria first/);
    expect(nextStepHint({ status: "initializing", blocked: false }, 2)).toMatch(/freeze the criteria/);
  });

  test("initializing with no criteria: freeze is off and says to write them", () => {
    const freeze = stateActions({ status: "initializing", blocked: false }, 0).find((a) => a.id === "freeze")!;
    expect(freeze.enabled).toBe(false);
    expect(freeze.hint).toMatch(/criterion/);
    expect(nextStepHint({ status: "initializing", blocked: false }, 0)).toMatch(/write the acceptance criteria/);
  });

  test("ready: start is on, freeze reads as done", () => {
    expect(on("ready")).toEqual({ freeze: false, start: true, block: true, next: true });
    expect(stateActions({ status: "ready", blocked: false }, 2)[0]!.label).toBe("Criteria frozen");
  });

  test("in progress and later: start is off", () => {
    for (const status of ["in-progress", "implemented", "completing"]) {
      expect(on(status).start).toBe(false);
      expect(nextStepHint({ status, blocked: false }, 2)).toBeNull();
    }
  });

  test("blocked: only unblock and next; done: nothing", () => {
    expect(on("ready", true)).toEqual({ freeze: false, start: false, unblock: true, next: true });
    expect(on("done")).toEqual({ freeze: false, start: false, block: false, next: false });
  });

  test("the four slots always show, so the next step stays visible", () => {
    for (const status of ["initializing", "ready", "in-progress", "done"]) {
      expect(stateActions({ status, blocked: false }, 1)).toHaveLength(4);
    }
  });
});
