import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { browserOpenPlan, openVerificationUrl } from "./open-url";

test("linux without a display does not plan a browser (headless SSH)", () => {
  expect(browserOpenPlan("https://auth.x.ai/verify", "linux", {})).toBeUndefined();
  expect(browserOpenPlan("https://auth.x.ai/verify", "linux", { DISPLAY: "" })).toBeUndefined();
});

test("linux with DISPLAY or WAYLAND_DISPLAY uses xdg-open", () => {
  expect(browserOpenPlan("https://auth.x.ai/verify", "linux", { DISPLAY: ":0" })).toEqual({
    cmd: "xdg-open",
    args: ["https://auth.x.ai/verify"],
  });
  expect(browserOpenPlan("https://auth.x.ai/verify", "linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({
    cmd: "xdg-open",
    args: ["https://auth.x.ai/verify"],
  });
});

test("darwin and win32 always plan a platform opener", () => {
  expect(browserOpenPlan("https://auth.x.ai/verify", "darwin", {})).toEqual({
    cmd: "open",
    args: ["https://auth.x.ai/verify"],
  });
  expect(browserOpenPlan("https://auth.x.ai/verify", "win32", {})).toEqual({
    cmd: "cmd",
    args: ["/c", "start", "", "https://auth.x.ai/verify"],
  });
});

test("openVerificationUrl does not throw when spawn emits ENOENT", () => {
  const listeners: Array<(err: Error) => void> = [];
  let spawned = 0;
  openVerificationUrl("https://auth.x.ai/verify", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    spawn: () => {
      spawned += 1;
      return {
        on: (_event, listener) => {
          listeners.push(listener);
        },
        unref: () => {},
      };
    },
  });
  expect(spawned).toBe(1);
  expect(listeners).toHaveLength(1);
  expect(() => listeners[0]?.(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }))).not.toThrow();
});

test("openVerificationUrl does not spawn on headless linux", () => {
  let spawned = 0;
  openVerificationUrl("https://auth.x.ai/verify", {
    platform: "linux",
    env: {},
    spawn: () => {
      spawned += 1;
      return { on: () => {}, unref: () => {} };
    },
  });
  expect(spawned).toBe(0);
});

test("a missing opener does not become an uncaughtException", async () => {
  const uncaught: Error[] = [];
  const onUncaught = (err: Error) => {
    uncaught.push(err);
  };
  process.on("uncaughtException", onUncaught);
  try {
    openVerificationUrl("https://auth.x.ai/verify", {
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawn: (_cmd, args, options) => spawn("/keryx-no-such-opener", [...args], options),
    });
    await Bun.sleep(80);
    expect(uncaught).toEqual([]);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});
