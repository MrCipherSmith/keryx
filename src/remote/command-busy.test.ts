// Flow 387, AC9: the commands the shell refuses while it is busy are refused from the topic with the
// same reason; a command that runs long shows a running status; a command over its limit is
// stopped and reported.

import { describe, expect, it } from "bun:test";
import { BUSY_DEFERRED_COMMANDS, BUSY_REASON } from "./command-gateway";
import { commandHarness, waitFor } from "./command.test-helpers";

describe("commands the shell defers while busy (AC9)", () => {
  it("lists the commands the shell refuses while busy", () => {
    for (const name of ["new", "resume", "sessions", "compact", "model"]) {
      expect(BUSY_DEFERRED_COMMANDS).toContain(name);
    }
  });

  for (const line of ["/new", "/resume", "/sessions", "/compact", "/model"]) {
    it(`${line} is refused with the shell's reason while a turn runs`, async () => {
      const h = commandHarness({ busy: true });
      await h.bridge.enable();
      await h.say(line);
      await h.bridge.idle();
      const reply = h.client().replies[0] ?? "";
      expect(reply).toContain(`/${line.slice(1)} was not run`);
      expect(reply).toContain(BUSY_REASON);
      expect(h.ran).toEqual([]);
      expect(h.client().choices).toEqual([]);
    });
  }

  it("uses the reason the shell itself gives when it supplies one", async () => {
    const h = commandHarness({ busy: true, busyRefusal: (line) => (line.startsWith("/new") ? "main is busy: command deferred" : undefined) });
    await h.bridge.enable();
    await h.say("/new");
    await h.bridge.idle();
    expect(h.client().replies[0]).toContain("main is busy: command deferred");
    expect(h.ran).toEqual([]);
  });

  it("runs a command the shell does not defer while it is busy", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    expect(h.ran).toEqual(["/status"]);
  });

  it("runs the same command once the shell is idle again", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/compact");
    await h.bridge.idle();
    expect(h.ran).toEqual([]);
    h.state.busy = false;
    await h.say("/compact");
    await h.bridge.idle();
    expect(h.ran).toEqual(["/compact"]);
  });
});

describe("a command that runs long (AC9)", () => {
  it("says it is still running, then gives the output", async () => {
    let release: (() => void) | undefined;
    const h = commandHarness({
      runningNoticeMs: 5,
      runCommand: () =>
        new Promise((resolve) => {
          release = () => resolve({ output: "all healthy", ok: true });
        }),
    });
    await h.bridge.enable();
    await h.say("/doctor");
    await waitFor(() => h.client().replies.some((reply) => reply.includes("Still running /doctor")), "the running notice");
    expect(h.client().replies.length).toBe(1);
    release?.();
    await h.bridge.idle();
    expect(h.client().replies.at(-1)).toContain("all healthy");
  });

  it("shows no running notice for a command that is quick", async () => {
    const h = commandHarness({ runningNoticeMs: 200 });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 230));
    expect(h.client().replies.filter((reply) => reply.includes("Still running"))).toEqual([]);
  });

  it("stops a command that passes its limit and reports it", async () => {
    const h = commandHarness({
      runningNoticeMs: 1_000,
      commandLimitMs: 15,
      runCommand: () => new Promise(() => undefined),
    });
    await h.bridge.enable();
    await h.say("/doctor");
    await h.bridge.idle();
    expect(h.calls).toContain("cancel");
    const reply = h.client().replies.at(-1) ?? "";
    expect(reply).toContain("Stopped /doctor");
    expect(reply).toContain("seconds");
  });

  it("goes on to the next command after one was stopped", async () => {
    let first = true;
    const h = commandHarness({
      commandLimitMs: 15,
      runCommand: (line) => {
        if (first) {
          first = false;
          return new Promise(() => undefined);
        }
        return Promise.resolve({ output: `ran ${line}`, ok: true });
      },
    });
    await h.bridge.enable();
    await h.say("/doctor");
    await h.say("/status");
    await h.bridge.idle();
    expect(h.client().replies.at(-1)).toContain("ran /status");
  });
});
