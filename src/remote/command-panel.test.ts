// Flow 387, AC13 (the shell half): everything the topic asks for lands in the bridge's event list as a
// "command" event, which the /remote-control Commands tab shows. That includes refused commands and
// confirmations nobody has answered yet.

import { describe, expect, it } from "bun:test";
import { formatRemoteCommandLines } from "../tui/remote-control-surface";
import { commandHarness, waitFor } from "./command.test-helpers";

function commandTexts(h: ReturnType<typeof commandHarness>): string[] {
  return h.bridge
    .status()
    .events.filter((event) => event.kind === "command")
    .map((event) => event.text);
}

describe("remote commands reach the panel (AC13)", () => {
  it("a command that ran is recorded as started and done", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    const texts = commandTexts(h);
    expect(texts.some((text) => text.includes("/status started"))).toBe(true);
    expect(texts.some((text) => text.includes("/status done"))).toBe(true);
  });

  it("a refused command is recorded with the reason", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/guard");
    await h.bridge.idle();
    expect(commandTexts(h).some((text) => text.startsWith("refused /guard"))).toBe(true);
  });

  it("a confirmation nobody has answered is visible, then the outcome follows", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/mode trust");
    await waitFor(() => h.client().choices.length === 1, "the question");
    expect(commandTexts(h)).toContain("/mode waiting for a press in the topic");
    expect(commandTexts(h).some((text) => text.includes("declined") || text.includes("confirmed"))).toBe(false);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
    expect(commandTexts(h).some((text) => text.includes("not confirmed in time"))).toBe(true);
  });

  it("the Commands tab text is built from those events", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/guard");
    await h.say("/mode trust");
    await waitFor(() => h.client().choices.length === 1, "the question");
    const lines = formatRemoteCommandLines(h.bridge.status());
    expect(lines.some((line) => line.includes("refused /guard"))).toBe(true);
    expect(lines.some((line) => line.includes("/mode waiting for a press in the topic"))).toBe(true);
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
  });

  it("a plain line is not a command event", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("fix the build");
    await h.bridge.idle();
    expect(commandTexts(h)).toEqual([]);
  });
});
