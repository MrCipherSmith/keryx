import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { CTRL_C_EXIT_WINDOW_MS, createCtrlCPolicy, isCtrlC } from "./ctrl-c-policy";
import { createForegroundOperationOwner } from "./foreground-operation";

const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

test("Ctrl+C during a running turn only cancels it, however many times it is pressed", () => {
  const policy = createCtrlCPolicy({ now: clock().now });
  expect(policy.press(true)).toBe("cancel-turn");
  expect(policy.press(true)).toBe("cancel-turn");
});

test("Ctrl+C at an idle prompt arms the exit; the shell stays open", () => {
  expect(createCtrlCPolicy({ now: clock().now }).press(false)).toBe("arm-exit");
});

test("a second Ctrl+C inside the window at an idle prompt exits", () => {
  const c = clock();
  const policy = createCtrlCPolicy({ now: c.now });
  expect(policy.press(false)).toBe("arm-exit");
  c.advance(CTRL_C_EXIT_WINDOW_MS);
  expect(policy.press(false)).toBe("exit");
});

test("a second Ctrl+C after the window has lapsed only re-arms", () => {
  const c = clock();
  const policy = createCtrlCPolicy({ now: c.now });
  expect(policy.press(false)).toBe("arm-exit");
  c.advance(CTRL_C_EXIT_WINDOW_MS + 1);
  expect(policy.press(false)).toBe("arm-exit");
  c.advance(10);
  expect(policy.press(false)).toBe("exit");
});

test("cancelling a turn disarms a pending exit: press, cancel, press does not quit", () => {
  const c = clock();
  const policy = createCtrlCPolicy({ now: c.now });
  expect(policy.press(false)).toBe("arm-exit");
  expect(policy.press(true)).toBe("cancel-turn");
  c.advance(100);
  expect(policy.press(false)).toBe("arm-exit");
});

test("the exit is consumed: a third press starts a new window", () => {
  const c = clock();
  const policy = createCtrlCPolicy({ now: c.now });
  policy.press(false);
  expect(policy.press(false)).toBe("exit");
  expect(policy.press(false)).toBe("arm-exit");
});

test("isCtrlC matches only ctrl+c", () => {
  expect(isCtrlC({ name: "c", ctrl: true })).toBe(true);
  expect(isCtrlC({ name: "c", ctrl: false })).toBe(false);
  expect(isCtrlC({ name: "d", ctrl: true })).toBe(false);
});

test("busy -> cancel: a Ctrl+C press aborts the running foreground operation and the turn is cancelled, not closed", () => {
  const owner = createForegroundOperationOwner();
  const policy = createCtrlCPolicy({ now: clock().now });
  const token = owner.begin();
  const running = () => owner.isActive && !owner.signal.aborted;

  expect(policy.press(running())).toBe("cancel-turn");
  owner.cancel("interrupted by Ctrl+C");
  expect(owner.signal.aborted).toBe(true);
  expect(owner.isDisposed).toBe(false);

  // Still unwinding: the next press counts as idle, so a wedged turn cannot trap the user.
  expect(policy.press(running())).toBe("arm-exit");
  owner.settle(token);
  expect(policy.press(running())).toBe("exit");
});

test("tui-shell wires Ctrl+C: the renderer hands it over, a running turn is cancelled, the hint is shown", () => {
  const source = readFileSync(new URL("./tui-shell.ts", import.meta.url), "utf8");
  expect(source).toContain("onCtrlC: () => (ctrlCPress ??");
  const start = source.indexOf("ctrlCPress = () => {");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n    };", start));
  expect(body).toContain("ctrlCPolicy.press(foregroundOperation.isActive");
  expect(body).toContain('foregroundOperation.cancel("interrupted by Ctrl+C")');
  expect(body).toContain("chrome.showToast(CTRL_C_EXIT_HINT)");
  expect(body).toContain("r.destroy()");
  expect(source).not.toContain("Ctrl+C to exit");
});
