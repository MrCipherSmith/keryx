import { test, expect } from "bun:test";
import { assertTransition, canTransition } from "./machine";

test("allows the canonical lifecycle path", () => {
  expect(canTransition("initializing", "ready")).toBe(true);
  expect(canTransition("ready", "in-progress")).toBe(true);
  expect(canTransition("in-progress", "implemented")).toBe(true);
  expect(canTransition("implemented", "completing")).toBe(true);
  expect(canTransition("completing", "done")).toBe(true);
  expect(canTransition("completing", "in-progress")).toBe(true); // failed gates
});

test("rejects shortcuts and backward jumps", () => {
  expect(canTransition("initializing", "done")).toBe(false);
  expect(canTransition("ready", "implemented")).toBe(false);
  expect(canTransition("in-progress", "done")).toBe(false);
  expect(canTransition("done", "in-progress")).toBe(false);
  expect(() => assertTransition("ready", "done")).toThrow(/Invalid flow transition/);
});

test("blocked is reachable from anywhere except done", () => {
  expect(canTransition("initializing", "blocked")).toBe(true);
  expect(canTransition("completing", "blocked")).toBe(true);
  expect(canTransition("done", "blocked")).toBe(false);
  expect(canTransition("blocked", "blocked")).toBe(false);
});
