// Flow 520 AC4: on_head_move has ask/follow/ignore, defaults by run source, and unreadable stored values read as the default.

import { describe, expect, test } from "bun:test";
import { defaultOnHeadMove, headMoveResponse, ON_HEAD_MOVE, parseOnHeadMove } from "./head-move";

describe("on_head_move values", () => {
  test("has exactly ask, follow and ignore", () => {
    expect([...ON_HEAD_MOVE]).toEqual(["ask", "follow", "ignore"]);
  });

  test("manual and existing reviews default to ask, rule-triggered to follow", () => {
    expect(defaultOnHeadMove("manual")).toBe("ask");
    expect(defaultOnHeadMove("existing")).toBe("ask");
    expect(defaultOnHeadMove("scheduled")).toBe("follow");
  });

  test("a stored valid value is kept whatever the source", () => {
    expect(parseOnHeadMove("ignore", "scheduled")).toBe("ignore");
    expect(parseOnHeadMove("follow", "manual")).toBe("follow");
    expect(parseOnHeadMove("ask", "scheduled")).toBe("ask");
  });

  test("missing, null or unknown reads as the source default", () => {
    for (const bad of [undefined, null, "", "FOLLOW", "stop", 1, {}]) {
      expect(parseOnHeadMove(bad, "manual")).toBe("ask");
      expect(parseOnHeadMove(bad, "scheduled")).toBe("follow");
    }
  });
});

describe("headMoveResponse", () => {
  test("ask during a round offers update-after-finish and stop-and-restart", () => {
    expect(headMoveResponse("ask", "running")).toEqual({
      kind: "offer",
      actions: ["update-after-finish", "stop-and-restart"],
    });
  });

  test("ask after a round offers a single update", () => {
    expect(headMoveResponse("ask", "finished")).toEqual({ kind: "offer", actions: ["update"] });
  });

  test("follow defers the update until the running round finishes, then queues it now", () => {
    expect(headMoveResponse("follow", "running")).toEqual({ kind: "queue-update", when: "after-finish" });
    expect(headMoveResponse("follow", "finished")).toEqual({ kind: "queue-update", when: "now" });
  });

  test("ignore does nothing in either phase", () => {
    expect(headMoveResponse("ignore", "running")).toEqual({ kind: "none" });
    expect(headMoveResponse("ignore", "finished")).toEqual({ kind: "none" });
  });
});
