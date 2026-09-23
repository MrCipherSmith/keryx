// Flow 300 review F13: theme listeners swallow ONLY the "already gone" case.

import { expect, test } from "bun:test";
import { guardedThemeRepaint } from "./theme-repaint";

test("a repaint that fails while the renderables are gone is ignored", () => {
  let gone = false;
  const listener = guardedThemeRepaint(
    "t",
    () => {
      gone = true; // destroyed mid-paint
      throw new Error("TextBuffer is destroyed");
    },
    () => gone,
  );
  expect(() => listener()).not.toThrow();
});

test("a repaint is skipped entirely once gone", () => {
  let painted = 0;
  const listener = guardedThemeRepaint(
    "t",
    () => {
      painted += 1;
    },
    () => true,
  );
  listener();
  expect(painted).toBe(0);
});

test("a REAL bug while the renderables are alive is rethrown, not swallowed", () => {
  const listener = guardedThemeRepaint(
    "t",
    () => {
      throw new Error("real bug");
    },
    () => false,
  );
  expect(() => listener()).toThrow("real bug");
});
