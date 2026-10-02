// Flow 396 (AC10, AC11): `/stop` ends a run Telegram started, and only that; a run has no time limit unless
// `runTimeoutMs` says so; the refusal for `/interrupt` points at `/stop`.

import { describe, expect, test } from "bun:test";
import { classifyRemoteCommand, remoteHelpText, remoteMenu } from "./command-gateway";
import { commandHarness, waitFor } from "./command.test-helpers";
import { TG_SOURCE } from "./shell-bridge";

/** A shell with a Telegram-started turn running. */
async function runningTelegramTurn(options: Parameters<typeof commandHarness>[0] = {}) {
  const h = commandHarness(options);
  await h.bridge.enable("topic-a");
  h.say("do the thing");
  h.state.busy = true;
  h.bridge.turnStarted(TG_SOURCE);
  return h;
}

describe("/stop", () => {
  test("is on the menu and in /help", () => {
    expect(remoteMenu().some((entry) => entry.command === "stop")).toBe(true);
    expect(remoteHelpText()).toContain("/stop");
    expect(classifyRemoteCommand("/stop").kind).toBe("builtin");
  });

  test("cancels a run Telegram started and the topic hears 'Stopped by you.' when it ends", async () => {
    const h = await runningTelegramTurn();
    h.say("/stop");
    await h.bridge.idle();
    expect(h.calls.filter((c) => c === "cancel")).toHaveLength(1);
    await h.bridge.turnSettled({ failed: true });
    expect(h.client().replies.at(-1)).toBe("Stopped by you.");
    expect(h.client().replies).not.toContain("The run failed. The details are in the shell.");
  });

  test("a second /stop does not cancel twice", async () => {
    const h = await runningTelegramTurn();
    h.say("/stop");
    h.say("/stop");
    await h.bridge.idle();
    expect(h.calls.filter((c) => c === "cancel")).toHaveLength(1);
  });

  test("does not touch a run the operator started in the shell, and says why", async () => {
    const h = commandHarness();
    await h.bridge.enable("topic-a");
    h.state.busy = true;
    h.bridge.turnStarted(undefined);
    h.say("/stop");
    await waitFor(() => h.client().replies.length > 0, "a reply");
    expect(h.calls).not.toContain("cancel");
    expect(h.client().replies[0]).toContain("started in the shell");
  });

  test("with nothing running it says so and cancels nothing", async () => {
    const h = commandHarness();
    await h.bridge.enable("topic-a");
    h.say("/stop");
    await waitFor(() => h.client().replies.length > 0, "a reply");
    expect(h.calls).not.toContain("cancel");
    expect(h.client().replies[0]).toContain("no run started from Telegram");
  });

  test("a stop while an approval is waiting ends the wait at once as a deny", async () => {
    let seenSignal: AbortSignal | undefined;
    const h = await runningTelegramTurn({
      askApproval: (_prompt, _timeoutMs, options) =>
        new Promise((resolve) => {
          seenSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => resolve({ decision: "deny" }), { once: true });
        }),
    });
    const waiting = h.bridge.askApproval("Approve shell_exec?\nls");
    await waitFor(() => seenSignal !== undefined, "the approval to be asked");
    h.say("/stop");
    const answer = await waiting;
    expect(answer.decision).toBe("deny");
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe("the run limit (AC11)", () => {
  test("no runTimeoutMs means no timer: the run is never cancelled by the bridge", async () => {
    const h = await runningTelegramTurn({ runTimeoutMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.calls).not.toContain("cancel");
  });

  test("an explicit runTimeoutMs still stops the run and the message names the key", async () => {
    const h = await runningTelegramTurn({ runTimeoutMs: 20 });
    await waitFor(() => h.calls.includes("cancel"), "the time limit");
    await h.bridge.turnSettled({ failed: true });
    expect(h.client().replies.at(-1)).toContain("runTimeoutMs");
  });
});

describe("refusals (AC10)", () => {
  test("/interrupt points at /stop", () => {
    const decision = classifyRemoteCommand("/interrupt");
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toContain("/stop");
  });

  test("/permissions and /remote-policy are never run from the topic", () => {
    for (const line of ["/permissions", "/permissions remove 1", "/remote-policy mode trust", "/remote_policy"]) {
      expect(classifyRemoteCommand(line).kind).toBe("refuse");
    }
  });
});
