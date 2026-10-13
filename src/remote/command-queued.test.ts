// Flow 419, AC4: /route, /external and /model from the topic take effect when main is idle and are queued, with a
// notice in the topic, when main is busy. Nothing is refused for being busy, and nothing waits on the command line.

import { describe, expect, it } from "bun:test";
import { classifyRemoteCommand, QUEUED_WHEN_BUSY_COMMANDS, REMOTE_COMMANDS, REMOTE_REFUSED, remoteMenu } from "./command-gateway";
import { commandHarness, waitFor } from "./command.test-helpers";

describe("the gateway (AC4)", () => {
  it("no longer refuses /route, and puts it on the menu", () => {
    expect(REMOTE_REFUSED.route).toBeUndefined();
    expect(REMOTE_COMMANDS.some((spec) => spec.name === "route")).toBe(true);
    expect(remoteMenu().some((entry) => entry.command === "route")).toBe(true);
  });

  it("/route shows at once, /route on and off ask first, anything else is refused", () => {
    expect(classifyRemoteCommand("/route")).toEqual({ kind: "run", command: "route", line: "/route" });
    for (const arg of ["on", "off"]) {
      const decision = classifyRemoteCommand(`/route ${arg}`);
      expect(decision.kind).toBe("confirm");
      if (decision.kind === "confirm") expect(decision.line).toBe(`/route ${arg}`);
    }
    expect(classifyRemoteCommand("/route sideways").kind).toBe("refuse");
  });

  it("names the commands that wait for an idle main", () => {
    expect([...QUEUED_WHEN_BUSY_COMMANDS].sort()).toEqual(["external", "external-agents", "model", "route"]);
  });
});

describe("main idle", () => {
  it("/route on runs after Yes", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/route on");
    await waitFor(() => h.client().choices.length === 1, "the question");
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    expect(h.ran).toEqual(["/route on"]);
    expect(h.client().replies.some((reply) => reply.includes("queued"))).toBe(false);
  });
});

describe("main busy", () => {
  it("/route on is queued with a notice, then runs when main goes idle", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/route on");
    await waitFor(() => h.client().choices.length === 1, "the question");
    h.client().choices[0]?.answer(0);
    await waitFor(() => h.client().replies.some((reply) => reply.includes("/route on is queued: main is busy")), "the queued notice");
    expect(h.ran).toEqual([]);
    expect(h.client().replies.join("\n")).not.toContain("was not run");

    h.state.busy = false;
    await h.bridge.idle();
    expect(h.ran).toEqual(["/route on"]);
    expect(h.client().replies.at(-1)).toContain("ran /route on");
  });

  it("bare /external and /route are queued too, and both run", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/external");
    await h.say("/route");
    await waitFor(() => h.client().replies.filter((reply) => reply.includes("is queued")).length === 2, "both notices");
    expect(h.ran).toEqual([]);
    h.state.busy = false;
    await h.bridge.idle();
    expect([...h.ran].sort()).toEqual(["/external", "/route"]);
  });

  it("a status question is not stuck behind a queued command", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/external");
    await waitFor(() => h.client().replies.some((reply) => reply.includes("is queued")), "the notice");
    await h.say("/status");
    await waitFor(() => h.ran.includes("/status"), "the status to run");
    expect(h.ran).toEqual(["/status"]);
    h.state.busy = false;
    await h.bridge.idle();
  });

  it("/model shows its buttons while busy and the switch waits for an idle main", async () => {
    const switched: string[] = [];
    const h = commandHarness({
      busy: true,
      listModels: async () => ({
        provider: "acme",
        models: [
          { id: "m0", label: "Model 0", current: true },
          { id: "m1", label: "Model 1" },
        ],
      }),
      switchModel: async (id) => {
        switched.push(id);
        return { output: `Model: ${id}`, ok: true };
      },
    });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(1);
    await waitFor(() => h.client().replies.some((reply) => reply.includes("is queued: main is busy")), "the queued notice");
    expect(switched).toEqual([]);
    h.state.busy = false;
    await h.bridge.idle();
    expect(switched).toEqual(["m1"]);
    expect(h.client().replies.at(-1)).toContain("Model: m1");
  });

  it("a command held too long is dropped and the topic is told", async () => {
    const h = commandHarness({ busy: true, queuedCommandLimitMs: 30 });
    await h.bridge.enable();
    await h.say("/external");
    await h.bridge.idle();
    expect(h.ran).toEqual([]);
    expect(h.client().replies.at(-1)).toContain("main stayed busy");
  });

  it("a command held when remote control goes off is dropped quietly", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/external");
    await waitFor(() => h.client().replies.some((reply) => reply.includes("is queued")), "the notice");
    await h.bridge.disable();
    await h.bridge.idle();
    h.state.busy = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.ran).toEqual([]);
  });
});
