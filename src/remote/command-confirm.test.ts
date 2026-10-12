// Flow 387, AC6 and AC7: commands that raise trust or send work outside run only after a Yes press.
// No, or no press in time, leaves everything as it was.

import { describe, expect, it } from "bun:test";
import { commandHarness, waitFor } from "./command.test-helpers";

async function ask(line: string, options: Parameters<typeof commandHarness>[0] = {}) {
  const h = commandHarness(options);
  await h.bridge.enable();
  await h.say(line);
  await waitFor(() => h.client().choices.length === 1, `the question for ${line}`);
  return h;
}

describe("mode and plan need a Yes press (AC6)", () => {
  for (const line of ["/mode trust", "/mode auto", "/plan off"]) {
    it(`${line} asks first and runs nothing until Yes`, async () => {
      const h = await ask(line);
      const choice = h.client().choices[0];
      expect(choice?.rows).toEqual([["Yes", "No"]]);
      expect(h.ran).toEqual([]);
      choice?.answer(0);
      await h.bridge.idle();
      expect(h.ran).toEqual([line]);
      expect(h.client().replies.length).toBe(1);
    });

    it(`${line} changes nothing on No`, async () => {
      const h = await ask(line);
      h.client().choices[0]?.answer(1);
      await h.bridge.idle();
      expect(h.ran).toEqual([]);
      expect(h.client().replies).toEqual([]);
      expect(h.bridge.status().events.some((event) => event.text.includes("declined in the topic; nothing changed"))).toBe(true);
    });

    it(`${line} changes nothing when nobody presses in time`, async () => {
      const h = await ask(line);
      h.client().choices[0]?.answer(undefined);
      await h.bridge.idle();
      expect(h.ran).toEqual([]);
      expect(h.client().replies).toEqual([]);
      expect(h.bridge.status().events.some((event) => event.text.includes("not confirmed in time; nothing changed"))).toBe(true);
    });
  }

  it("asks with the expiry the bridge is configured with", async () => {
    const h = await ask("/mode trust", { choiceTimeoutMs: 1234 });
    expect(h.client().choices[0]?.timeoutMs).toBe(1234);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("says what is being asked in the question", async () => {
    const h = await ask("/mode trust");
    expect(h.client().choices[0]?.text).toContain("trust");
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
  });

  it("runs the lower-risk forms without a question", async () => {
    for (const line of ["/mode", "/mode ask", "/plan on", "/plan"]) {
      const h = commandHarness();
      await h.bridge.enable();
      await h.say(line);
      await h.bridge.idle();
      expect(h.client().choices).toEqual([]);
      expect(h.ran).toEqual([line]);
    }
  });

  it("refuses a mode the shell does not have, without a question", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/mode yolo");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.client().replies[0]).toContain("Not available remotely");
  });

  it("does not let an answer to one question run another line", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/mode trust");
    await h.say("/mode auto");
    await waitFor(() => h.client().choices.length === 2, "both questions");
    h.client().choices[1]?.answer(0);
    await waitFor(() => h.ran.length === 1, "the confirmed line to run");
    expect(h.ran).toEqual(["/mode auto"]);
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
    expect(h.ran).toEqual(["/mode auto"]);
  });
});

describe("delegate and external need a Yes press that names the agent (AC7)", () => {
  it("/delegate names the agent and says it is external and paid", async () => {
    const h = await ask("/delegate claude fix the flaky test");
    const choice = h.client().choices[0];
    expect(choice?.text).toContain("claude");
    expect(choice?.text).toMatch(/external/i);
    expect(choice?.text).toMatch(/paid/i);
    expect(choice?.text).toContain("fix the flaky test");
    expect(choice?.rows).toEqual([["Yes, send to claude (paid)", "No"]]);
    expect(h.ran).toEqual([]);
    choice?.answer(undefined);
    await h.bridge.idle();
  });

  it("/delegate runs the typed line after Yes, and only then", async () => {
    const h = await ask("/delegate Codex review the diff");
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    expect(h.ran).toEqual(["/delegate Codex review the diff"]);
  });

  it("/delegate marks a long task as shortened in the question and says how long it is", async () => {
    const task = "x".repeat(450);
    const h = await ask(`/delegate claude ${task}`);
    const text = h.client().choices[0]?.text ?? "";
    expect(text).toContain("shortened");
    expect(text).toContain("450 characters");
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    expect(h.ran).toEqual([`/delegate claude ${task}`]);
  });

  it("/delegate shows a short task whole, with no truncation mark", async () => {
    const h = await ask("/delegate claude fix it");
    expect(h.client().choices[0]?.text).not.toContain("shortened");
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("/delegate does nothing on No or on silence", async () => {
    const no = await ask("/delegate claude fix it");
    no.client().choices[0]?.answer(1);
    await no.bridge.idle();
    expect(no.ran).toEqual([]);
    const silent = await ask("/delegate claude fix it");
    silent.client().choices[0]?.answer(undefined);
    await silent.bridge.idle();
    expect(silent.ran).toEqual([]);
  });

  it("/delegate without a task is refused, with no question", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/delegate claude");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.client().replies[0]).toContain("Not available remotely");
  });

  for (const line of ["/external on", "/external off", "/external-agents on", "/external_agents off"]) {
    it(`${line} asks first, then runs`, async () => {
      const h = await ask(line);
      const choice = h.client().choices[0];
      expect(choice?.text).toMatch(/external/i);
      expect(h.ran).toEqual([]);
      choice?.answer(0);
      await h.bridge.idle();
      expect(h.ran).toEqual([line.replace("external_agents", "external-agents")]);
    });

    it(`${line} runs nothing on No`, async () => {
      const h = await ask(line);
      h.client().choices[0]?.answer(1);
      await h.bridge.idle();
      expect(h.ran).toEqual([]);
    });
  }

  it("the external agent runtime question says external agents are paid", async () => {
    const h = await ask("/external-agents on");
    expect(h.client().choices[0]?.text).toMatch(/paid/i);
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
  });

  it("shows the status forms without a question", async () => {
    for (const line of ["/external", "/external-agents"]) {
      const h = commandHarness();
      await h.bridge.enable();
      await h.say(line);
      await h.bridge.idle();
      expect(h.client().choices).toEqual([]);
      expect(h.ran).toEqual([line]);
    }
  });

  it("keeps the typed-hash apply step local", async () => {
    for (const line of ["/external apply a1b2c3", "/external-agents apply a1b2c3", "/external_agents apply a1b2c3"]) {
      const h = commandHarness();
      await h.bridge.enable();
      await h.say(line);
      await h.bridge.idle();
      expect(h.client().choices).toEqual([]);
      expect(h.ran).toEqual([]);
      expect(h.client().replies[0]).toContain("Not available remotely");
    }
  });
});

describe("a question keeps its command pending until it is answered (reaction)", () => {
  const states = (h: Awaited<ReturnType<typeof ask>>): string[] => h.client().reported.map(([, state]) => state);

  it("reports nothing while the question is open, then done once the confirmed command ran", async () => {
    const h = await ask("/mode trust");
    expect(states(h)).toEqual([]);
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states(h)).toEqual(["done"]);
  });

  it("reports failed when the confirmed command failed", async () => {
    const h = await ask("/mode trust", { runCommand: async () => ({ output: "no", ok: false }) });
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states(h)).toEqual(["failed"]);
  });

  it("reports done on No, and failed when the question expires", async () => {
    const no = await ask("/mode trust");
    no.client().choices[0]?.answer(1);
    await no.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states(no)).toEqual(["done"]);
    const late = await ask("/mode trust");
    late.client().choices[0]?.answer(undefined);
    await late.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states(late)).toEqual(["failed"]);
  });

  it("a picker stays pending until a session is chosen and resumed", async () => {
    const h = commandHarness({
      listSessions: async () => [{ id: "s-old", label: "old" }],
      resumeSession: async () => ({ output: "Resumed", ok: true }),
    });
    await h.bridge.enable();
    await h.say("/resume");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    expect(h.client().reported).toEqual([]);
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.client().reported.map(([, state]) => state)).toEqual(["done"]);
  });
});
