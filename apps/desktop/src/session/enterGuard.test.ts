import { describe, expect, test } from "bun:test";
import { askEnter, ENTER_GUARD_MS, permissionEnter, type EnterKey } from "./enterGuard";

const key = (over: Partial<EnterKey> = {}): EnterKey => ({
  key: "Enter",
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  sinceOpenMs: ENTER_GUARD_MS + 1,
  onControl: false,
  ...over,
});

describe("askEnter", () => {
  test("a fresh Enter on the dialog submits", () => {
    expect(askEnter(key())).toBe("submit");
  });

  test("right after open, or on key repeat, Enter is swallowed", () => {
    expect(askEnter(key({ sinceOpenMs: 10 }))).toBe("swallow");
    expect(askEnter(key({ repeat: true }))).toBe("swallow");
  });

  test("a button or link acts on its own Enter", () => {
    expect(askEnter(key({ onControl: true }))).toBe("pass");
  });

  test("IME composition and other keys pass", () => {
    expect(askEnter(key({ isComposing: true }))).toBe("pass");
    expect(askEnter(key({ key: "a" }))).toBe("pass");
    expect(askEnter(key({ defaultPrevented: true }))).toBe("pass");
  });
});

describe("permissionEnter", () => {
  const perm = (over: Partial<EnterKey & { canAllow: boolean; unread: boolean }> = {}) =>
    permissionEnter({ ...key(), canAllow: true, unread: false, ...over });

  test("approves on a fresh Enter when everything has been seen", () => {
    expect(perm()).toBe("submit");
  });

  test("does not approve while an argument box is partly hidden", () => {
    expect(perm({ unread: true })).toBe("swallow");
  });

  test("never right after open, on repeat, on a control, or without an allow option", () => {
    expect(perm({ sinceOpenMs: 0 })).toBe("pass");
    expect(perm({ repeat: true })).toBe("pass");
    expect(perm({ onControl: true })).toBe("pass");
    expect(perm({ canAllow: false })).toBe("pass");
  });
});
