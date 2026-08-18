import { expect, test } from "bun:test";
import { clampQueueNavIndex, stepQueueNavAction, stepQueueNavIndex } from "./queue-nav";

test("stepQueueNavIndex moves up/down and wraps at both ends", () => {
  expect(stepQueueNavIndex(1, 3, "up")).toBe(0);
  expect(stepQueueNavIndex(0, 3, "up")).toBe(2); // wraps to the tail
  expect(stepQueueNavIndex(1, 3, "down")).toBe(2);
  expect(stepQueueNavIndex(2, 3, "down")).toBe(0); // wraps to the head
});

test("stepQueueNavIndex is always 0 for an empty queue", () => {
  expect(stepQueueNavIndex(0, 0, "up")).toBe(0);
  expect(stepQueueNavIndex(5, 0, "down")).toBe(0);
});

test("clampQueueNavIndex keeps the selection inside a shrunk range", () => {
  expect(clampQueueNavIndex(2, 3)).toBe(2); // already in range: unchanged
  expect(clampQueueNavIndex(5, 3)).toBe(2); // was pointing past the new end
  expect(clampQueueNavIndex(-1, 3)).toBe(0);
  expect(clampQueueNavIndex(0, 0)).toBe(0); // empty queue
});

test("stepQueueNavAction cycles force -> edit -> delete -> force and back", () => {
  expect(stepQueueNavAction("force", "right")).toBe("edit");
  expect(stepQueueNavAction("edit", "right")).toBe("delete");
  expect(stepQueueNavAction("delete", "right")).toBe("force"); // wraps
  expect(stepQueueNavAction("force", "left")).toBe("delete"); // wraps the other way
  expect(stepQueueNavAction("edit", "left")).toBe("force");
});
