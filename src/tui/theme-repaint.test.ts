// Flow 300 review F13: theme listeners swallow ONLY the "already gone" case.

import { expect, test } from "bun:test";
import { applyThemeId, getThemeId, onThemeChange } from "./theme";
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

test("review N4: applyThemeId runs EVERY listener even when one throws — one buggy panel never aborts /theme", () => {
  const before = getThemeId();
  const seen: string[] = [];
  const offA = onThemeChange(() => seen.push("a"));
  const offBad = onThemeChange(
    guardedThemeRepaint(
      "bad",
      () => {
        throw new Error("real bug");
      },
      () => false,
    ),
  );
  const offC = onThemeChange(() => seen.push("c"));
  try {
    expect(() => applyThemeId("groknight")).not.toThrow();
    expect(seen).toEqual(["a", "c"]);
    expect(getThemeId()).toBe("groknight");
  } finally {
    offA();
    offBad();
    offC();
    applyThemeId(before);
  }
});
