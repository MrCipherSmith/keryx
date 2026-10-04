// Flow 387, independent review: L-4 (a refused question is told, not called a timeout),
// L-5 (a model switch waits behind a command that is still running) and L-6 (a command that
// outlasts its limit reports how it ended).

import { describe, expect, it } from "bun:test";
import { commandHarness, waitFor } from "./command.test-helpers";

function gate() {
  let open!: (value: { output: string; ok: boolean }) => void;
  const done = new Promise<{ output: string; ok: boolean }>((resolve) => {
    open = resolve;
  });
  return { done, open };
}

const MODELS = {
  listModels: async () => ({ provider: "acme", models: [{ id: "m0", label: "Model 0", current: true }, { id: "m1", label: "Model 1" }] }),
};

describe("a question serve refused (L-4)", () => {
  it("/model tells the topic why nothing was asked, and records that cause, not a timeout", async () => {
    const reason = "Too many questions are waiting for this session.";
    const h = commandHarness({ ...MODELS, switchModel: async () => ({ output: "x", ok: true }), refuseChoice: reason });
    await h.bridge.enable();
    await h.say("/model");
    await h.bridge.idle();
    const replies = h.client().replies;
    expect(replies.some((reply) => reply.includes("/model was not asked") && reply.includes(reason))).toBe(true);
    const events = h.bridge.status().events.map((event) => event.text);
    expect(events.some((text) => text.includes("not asked") && text.includes(reason))).toBe(true);
    expect(events.some((text) => text.includes("not answered in time"))).toBe(false);
    expect(h.client().reported.at(-1)?.[1]).toBe("failed");
  });

  it("a Yes/No that serve refused runs nothing and says why", async () => {
    const h = commandHarness({ refuseChoice: "No stream is connected for this session; the prompt cannot be answered." });
    await h.bridge.enable();
    await h.say("/mode trust");
    await h.bridge.idle();
    expect(h.ran).toEqual([]);
    expect(h.client().replies.some((reply) => reply.includes("/mode was not asked") && reply.includes("No stream is connected"))).toBe(true);
    expect(h.bridge.status().events.some((event) => event.text.includes("not confirmed in time"))).toBe(false);
  });

  it("a question nobody answered in time is still just a timeout", async () => {
    const h = commandHarness({ ...MODELS, switchModel: async () => ({ output: "x", ok: true }) });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
    expect(h.bridge.status().events.some((event) => event.text.includes("not answered in time"))).toBe(true);
    expect(h.client().replies.some((reply) => reply.includes("was not asked"))).toBe(false);
  });
});

describe("a model switch and a running command (L-5)", () => {
  it("switchModel does not start while an earlier command is still executing", async () => {
    const status = gate();
    let statusRunning = false;
    const seenWhileSwitching: boolean[] = [];
    const h = commandHarness({
      ...MODELS,
      runCommand: async () => {
        statusRunning = true;
        const outcome = await status.done;
        statusRunning = false;
        return outcome;
      },
      switchModel: async () => {
        seenWhileSwitching.push(statusRunning);
        return { output: "Model: m1", ok: true };
      },
    });
    await h.bridge.enable();
    await h.say("/status");
    await waitFor(() => statusRunning, "the status command to be running");
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seenWhileSwitching).toEqual([]);
    status.open({ output: "status text", ok: true });
    await h.bridge.idle();
    expect(seenWhileSwitching).toEqual([false]);
  });
});

describe("a command that outlasts its limit (L-6)", () => {
  it("tells the topic how it ended when it finally ends, and the reaction follows", async () => {
    const slow = gate();
    const h = commandHarness({ commandLimitMs: 15, runCommand: () => slow.done });
    await h.bridge.enable();
    await h.say("/status");
    await waitFor(() => h.client().replies.some((reply) => reply.includes("Stopped waiting")), "the limit notice");
    expect(h.client().reported.at(-1)?.[1]).toBe("failed");
    slow.open({ output: "LATE-RESULT", ok: true });
    await waitFor(() => h.client().replies.some((reply) => reply.includes("LATE-RESULT")), "the late result");
    const late = h.client().replies.find((reply) => reply.includes("LATE-RESULT")) ?? "";
    expect(late).toContain("/status finished after the time limit");
    await waitFor(() => h.client().reported.at(-1)?.[1] === "done", "the reaction to turn done");
  });

  it("a command that fails late says so", async () => {
    const slow = gate();
    const h = commandHarness({ commandLimitMs: 15, runCommand: () => slow.done });
    await h.bridge.enable();
    await h.say("/doctor");
    await waitFor(() => h.client().replies.some((reply) => reply.includes("Stopped waiting")), "the limit notice");
    slow.open({ output: "disk is full", ok: false });
    await waitFor(() => h.client().replies.some((reply) => reply.includes("disk is full")), "the late failure");
    expect(h.client().replies.at(-1)).toContain("/doctor failed after the time limit");
    expect(h.client().reported.at(-1)?.[1]).toBe("failed");
  });

  it("a command that does finish in time gets no second message", async () => {
    const h = commandHarness({ commandLimitMs: 500 });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.client().replies.filter((reply) => reply.includes("after the time limit"))).toEqual([]);
  });
});
