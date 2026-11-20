import { expect, test } from "bun:test";
import { BUSY_DELAYS, busyDelay, busyMessage, isBusy } from "./busy";

test("a busy refusal is recognised as a plain string (Tauri) and as an Error (dev bridge)", () => {
  expect(isBusy("busy: Chat attachments are busy; try again")).toBe(true);
  expect(isBusy(new Error("busy: too many repository lookups; try again"))).toBe(true);
  expect(busyMessage("busy: try later")).toBe("try later");
  expect(busyMessage(new Error("BUSY:  spaced"))).toBe("spaced");
});

test("only the busy: prefix counts, not any mention of busy", () => {
  expect(isBusy("EBUSY: resource busy or locked")).toBe(false);
  expect(isBusy(new Error("Could not read busy-state.png"))).toBe(false);
  expect(isBusy("the host is busy")).toBe(false);
  expect(isBusy(undefined)).toBe(false);
  expect(isBusy({ message: "busy: nope" })).toBe(false);
  expect(busyMessage("ENOENT")).toBeNull();
});

test("busyDelay spreads each step by about 20% and ends with the ladder", () => {
  expect(busyDelay(0, () => 0)).toBe(Math.round(BUSY_DELAYS[0] * 0.8));
  expect(busyDelay(0, () => 1)).toBe(Math.round(BUSY_DELAYS[0] * 1.2));
  expect(busyDelay(BUSY_DELAYS.length)).toBeUndefined();
});

test("the backoff ladder is bounded and increasing", () => {
  expect(BUSY_DELAYS.length > 0).toBe(true);
  for (let i = 1; i < BUSY_DELAYS.length; i++) expect((BUSY_DELAYS[i] ?? 0) > (BUSY_DELAYS[i - 1] ?? 0)).toBe(true);
});
