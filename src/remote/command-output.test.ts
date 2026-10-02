// Flow 387, AC2: the text commands run in the shell and their output comes back to the topic,
// redacted and rendered like a reply.

import { describe, expect, it } from "bun:test";
import { remoteMenu } from "./command-gateway";
import { commandHarness, SECRET, waitFor } from "./command.test-helpers";

const TEXT_COMMANDS = [
  "/status",
  "/doctor",
  "/compact",
  "/think hide",
  "/goal ship the release",
  "/queue",
  "/plan on",
  "/plan",
  "/reasoning",
  "/theme dark",
  "/jevrules",
  "/staledocs",
  "/opencomments",
  "/contract",
  "/triage",
  "/risk",
  "/scenarios",
];

describe("text commands return their output to the topic (AC2)", () => {
  for (const line of TEXT_COMMANDS) {
    it(`${line} runs in the shell and answers in the topic`, async () => {
      const h = commandHarness();
      await h.bridge.enable();
      await h.say(line);
      await h.bridge.idle();
      expect(h.ran).toEqual([line]);
      expect(h.client().replies.length).toBe(1);
      expect(h.client().replies[0]).toContain(`ran ${line}`);
    });
  }

  it("answers /help itself, from the same list the menu uses, without running anything", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/help");
    await h.bridge.idle();
    expect(h.ran).toEqual([]);
    const reply = h.client().replies[0] ?? "";
    for (const entry of remoteMenu()) {
      expect(reply).toContain(`/${entry.command}`);
    }
  });

  it("redacts a secret in the output before it reaches the topic", async () => {
    const h = commandHarness({ runCommand: async () => ({ output: `token is ${SECRET} ok`, ok: true }) });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    const reply = h.client().replies[0] ?? "";
    expect(reply).not.toContain(SECRET);
    expect(reply).not.toContain("AbCdEfGhIjKlMnOp");
  });

  it("says so when a command printed nothing", async () => {
    const h = commandHarness({ runCommand: async () => ({ output: "   \n", ok: true }) });
    await h.bridge.enable();
    await h.say("/queue");
    await h.bridge.idle();
    expect(h.client().replies[0]).toBe("/queue: done. It printed nothing.");
  });

  it("reports a failed command with its message", async () => {
    const h = commandHarness({ runCommand: async () => ({ output: "no such mode", ok: false }) });
    await h.bridge.enable();
    await h.say("/theme dark");
    await h.bridge.idle();
    const reply = h.client().replies[0] ?? "";
    expect(reply).toContain("/theme failed");
    expect(reply).toContain("no such mode");
  });

  it("reports a command that throws, without crashing the bridge", async () => {
    const h = commandHarness({
      runCommand: async () => {
        throw new Error("exploded");
      },
    });
    await h.bridge.enable();
    await h.say("/doctor");
    await h.bridge.idle();
    expect(h.client().replies[0]).toContain("exploded");
    await h.say("/status");
    await h.bridge.idle();
    expect(h.client().replies.length).toBe(2);
  });

  it("runs commands one at a time, in the order they arrived", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = commandHarness({
      runCommand: async (line) => {
        order.push(`start ${line}`);
        if (line === "/status") {
          await gate;
        }
        order.push(`end ${line}`);
        return { output: line, ok: true };
      },
    });
    await h.bridge.enable();
    await h.say("/status");
    await h.say("/queue");
    await waitFor(() => order.length > 0, "the first command to start");
    expect(order).toEqual(["start /status"]);
    release?.();
    await h.bridge.idle();
    expect(order).toEqual(["start /status", "end /status", "start /queue", "end /queue"]);
    expect(h.client().replies).toEqual(["/status", "/queue"]);
  });

  it("does not turn a command line into a chat message", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    expect(h.calls.filter((call) => call.startsWith("run:") || call.startsWith("queue:"))).toEqual([]);
  });
});
