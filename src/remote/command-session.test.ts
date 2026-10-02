// Flow 387, AC17: /new and /clear from the topic keep the same topic. One separator line goes in
// it, the history records the change, and /resume from the topic can return to an earlier session.

import { describe, expect, it } from "bun:test";
import { commandHarness, waitFor } from "./command.test-helpers";
import type { RemoteBridge } from "./shell-bridge";

/** The bridge under test, set once the harness has built it; the shell fakes reach it through this. */
interface BridgeRef {
  bridge?: RemoteBridge;
}

/**
 * A shell that swaps its session the way tui-shell does: leaving first, entering once the new
 * session is live, and only keeping the topic when a command from the topic asked for it.
 */
function swapping(ref: BridgeRef, kind: "new" | "resumed", seen: { kept: boolean[] }) {
  return async () => {
    const b = ref.bridge;
    if (b === undefined) {
      throw new Error("the bridge was not set");
    }
    seen.kept.push(b.keepingTopic);
    if (b.keepingTopic) {
      b.sessionLeaving();
    }
    if (b.keepingTopic) {
      b.sessionEntered(kind);
    }
    return { output: kind === "new" ? "Started a new session." : "Resumed abc", ok: true };
  };
}

describe("/new and /clear keep the topic (AC17)", () => {
  for (const line of ["/new", "/clear"]) {
    it(`${line} puts one separator line in the same topic and nothing else`, async () => {
      const seen = { kept: [] as boolean[] };
      const ref: BridgeRef = {};
      const h = commandHarness({ runCommand: swapping(ref, "new", seen) });
      ref.bridge = h.bridge;
      await h.bridge.enable();
      const topic = h.client();
      await h.say(line);
      await h.bridge.idle();
      await waitFor(() => topic.replies.length >= 1, "the separator");
      expect(topic.replies).toEqual(["--- new session ---"]);
      expect(seen.kept).toEqual([true]);
      expect(h.bridge.active).toBe(true);
      expect(h.client()).toBe(topic);
    });

    it(`${line} closes the old history interval and opens the new one on the same topic`, async () => {
      const seen = { kept: [] as boolean[] };
      const ref: BridgeRef = {};
      const h = commandHarness({ runCommand: swapping(ref, "new", seen) });
      ref.bridge = h.bridge;
      await h.bridge.enable();
      h.calls.length = 0;
      await h.say(line);
      await h.bridge.idle();
      expect(h.calls.filter((call) => call === "off" || call.startsWith("on:"))).toEqual(["off", "on:topic-a"]);
    });
  }

  it("does not delete or recreate the topic: the client stays open and is the same one", async () => {
    let closed = 0;
    const seen = { kept: [] as boolean[] };
    const ref: BridgeRef = {};
    const h = commandHarness({ runCommand: swapping(ref, "new", seen) });
    ref.bridge = h.bridge;
    await h.bridge.enable();
    const topic = h.client();
    const originalClose = topic.close.bind(topic);
    topic.close = async () => {
      closed += 1;
      await originalClose();
    };
    await h.say("/new");
    await h.bridge.idle();
    expect(closed).toBe(0);
    expect(h.client()).toBe(topic);
    expect(h.bridge.status().state).not.toBe("off");
  });

  it("records the change in the shell's remote status", async () => {
    const seen = { kept: [] as boolean[] };
    const ref: BridgeRef = {};
    const h = commandHarness({ runCommand: swapping(ref, "new", seen) });
    ref.bridge = h.bridge;
    await h.bridge.enable();
    await h.say("/new");
    await h.bridge.idle();
    const texts = h.bridge.status().events.map((event) => event.text);
    expect(texts).toContain("session changing; this topic stays bound");
    expect(texts).toContain("new session; same topic");
  });

  it("does not hold the topic for a session change typed in the shell", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    expect(h.bridge.keepingTopic).toBe(false);
  });

  it("stops holding the topic once the command is over", async () => {
    const seen = { kept: [] as boolean[] };
    const ref: BridgeRef = {};
    const h = commandHarness({ runCommand: swapping(ref, "new", seen) });
    ref.bridge = h.bridge;
    await h.bridge.enable();
    await h.say("/new");
    await h.bridge.idle();
    expect(h.bridge.keepingTopic).toBe(false);
  });

  it("answers with the command's output, and no separator, when the session did not change", async () => {
    const h = commandHarness({ runCommand: async () => ({ output: "Could not start a new session: locked", ok: false }) });
    await h.bridge.enable();
    await h.say("/new");
    await h.bridge.idle();
    expect(h.client().replies.length).toBe(1);
    expect(h.client().replies[0]).toContain("Could not start a new session");
    expect(h.client().replies[0]).not.toContain("--- new session ---");
    expect(h.bridge.keepingTopic).toBe(false);
  });

  it("does not follow the swap when remote control was turned off meanwhile", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.bridge.disable();
    h.bridge.sessionEntered("new");
    h.bridge.sessionLeaving();
    expect(h.bridge.keepingTopic).toBe(false);
  });

  it("is refused while the shell is busy, and the topic is left as it was", async () => {
    const h = commandHarness({ busy: true });
    await h.bridge.enable();
    await h.say("/new");
    await h.bridge.idle();
    expect(h.ran).toEqual([]);
    expect(h.client().replies[0]).toContain("/new was not run");
    expect(h.bridge.keepingTopic).toBe(false);
  });
});

describe("/resume from the topic can return to an earlier session (AC17)", () => {
  const SESSIONS = [
    { id: "s-now", label: "aaaa1111 · today", current: true },
    { id: "s-old", label: "bbbb2222 · yesterday" },
    { id: "s-older", label: "cccc3333 · last week" },
  ];

  it("offers the earlier sessions, not the current one, and returns to the one pressed", async () => {
    const resumed: string[] = [];
    const ref: BridgeRef = {};
    const h = commandHarness({
      listSessions: async () => SESSIONS,
      resumeSession: async (id) => {
        resumed.push(id);
        ref.bridge?.sessionLeaving();
        ref.bridge?.sessionEntered("resumed");
        return { output: "Resumed bbbb2222", ok: true };
      },
    });
    ref.bridge = h.bridge;
    await h.bridge.enable();
    h.calls.length = 0;
    await h.say("/resume");
    await waitFor(() => h.client().choices.length === 1, "the session picker");
    expect(h.client().choices[0]?.rows).toEqual([["bbbb2222 · yesterday"], ["cccc3333 · last week"]]);
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    expect(resumed).toEqual(["s-old"]);
    expect(h.client().replies).toEqual(["--- resumed session ---"]);
    expect(h.calls.filter((call) => call === "off" || call.startsWith("on:"))).toEqual(["off", "on:topic-a"]);
    expect(h.bridge.active).toBe(true);
  });

  it("changes nothing when the picker is not answered", async () => {
    const resumed: string[] = [];
    const h = commandHarness({
      listSessions: async () => SESSIONS,
      resumeSession: async (id) => {
        resumed.push(id);
        return { output: "", ok: true };
      },
    });
    await h.bridge.enable();
    await h.say("/resume");
    await waitFor(() => h.client().choices.length === 1, "the session picker");
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
    expect(resumed).toEqual([]);
    expect(h.client().replies).toEqual([]);
  });

  it("says so when there is no earlier session", async () => {
    const h = commandHarness({ listSessions: async () => [SESSIONS[0]!], resumeSession: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/resume");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("no earlier session");
  });

  it("answers with the shell's message when the resume did not happen", async () => {
    const h = commandHarness({
      listSessions: async () => SESSIONS,
      resumeSession: async () => ({ output: "Could not resume bbbb2222: held by another shell.", ok: false }),
    });
    await h.bridge.enable();
    await h.say("/resume");
    await waitFor(() => h.client().choices.length === 1, "the session picker");
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    expect(h.client().replies.length).toBe(1);
    expect(h.client().replies[0]).toContain("held by another shell");
    expect(h.client().replies[0]).not.toContain("--- resumed session ---");
  });

  it("lists the sessions as text without switching", async () => {
    const resumed: string[] = [];
    const h = commandHarness({
      listSessions: async () => SESSIONS,
      resumeSession: async (id) => {
        resumed.push(id);
        return { output: "", ok: true };
      },
    });
    await h.bridge.enable();
    await h.say("/sessions");
    await h.bridge.idle();
    expect(resumed).toEqual([]);
    expect(h.client().replies[0]).toContain("bbbb2222 · yesterday");
    expect(h.client().replies[0]).toContain("* aaaa1111 · today");
  });

  it("is refused while the shell is busy", async () => {
    const h = commandHarness({ busy: true, listSessions: async () => SESSIONS, resumeSession: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/resume");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("was not run");
  });
});
