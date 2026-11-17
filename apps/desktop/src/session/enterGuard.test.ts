import { describe, expect, test } from "bun:test";
import { ASK_CONTROLS, askEnter, ENTER_GUARD_MS, enterKeyOf, PERMISSION_CONTROLS, permissionEnter, type EnterKey } from "./enterGuard";

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
  const allow = { optionId: "allow" };
  const perm = (over: Partial<EnterKey & { allow: typeof allow | undefined; unread: boolean }> = {}) =>
    permissionEnter({ ...key(), allow, unread: false, ...over });

  test("approves the allow option on a fresh Enter when everything has been seen", () => {
    expect(perm()).toEqual({ verdict: "submit", option: allow });
  });

  test("does not approve while a box is partly hidden", () => {
    expect(perm({ unread: true })).toEqual({ verdict: "swallow" });
  });

  test("never right after open, on repeat, on a control, or without an allow option", () => {
    expect(perm({ sinceOpenMs: 0 })).toEqual({ verdict: "pass" });
    expect(perm({ repeat: true })).toEqual({ verdict: "pass" });
    expect(perm({ onControl: true })).toEqual({ verdict: "pass" });
    expect(perm({ allow: undefined })).toEqual({ verdict: "pass" });
  });

  test("IME composition, a handled key and other keys pass", () => {
    expect(perm({ isComposing: true })).toEqual({ verdict: "pass" });
    expect(perm({ defaultPrevented: true })).toEqual({ verdict: "pass" });
    expect(perm({ key: "a" })).toEqual({ verdict: "pass" });
  });
});

describe("enterKeyOf", () => {
  const target = (matches: string[]) => ({ closest: (sel: string) => (matches.includes(sel) ? {} : null) });

  test("reads the event, the time since open and the dialog's own control set", () => {
    const e = { key: "Enter", repeat: false, defaultPrevented: false, nativeEvent: { isComposing: true }, target: target([PERMISSION_CONTROLS]) };
    expect(enterKeyOf(e, 100, PERMISSION_CONTROLS, 600)).toEqual({
      key: "Enter",
      repeat: false,
      isComposing: true,
      defaultPrevented: false,
      sinceOpenMs: 500,
      onControl: true,
    });
    expect(enterKeyOf(e, 100, ASK_CONTROLS, 600).onControl).toBeFalse();
  });

  test("a target without closest is not a control", () => {
    const e = { key: "Enter", repeat: false, defaultPrevented: false, target: null };
    expect(enterKeyOf(e, 0, ASK_CONTROLS, 1).onControl).toBeFalse();
  });
});
