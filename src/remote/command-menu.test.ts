// Flow 387, AC12: the bot's command menu lists exactly the commands the gateway allows, and /help
// in the topic lists the same set.

import { afterEach, describe, expect, it } from "bun:test";
import { classifyRemoteCommand, menuNamesAreValid, REMOTE_COMMANDS, REMOTE_REFUSED, remoteHelpText, remoteMenu } from "./command-gateway";
import { commandHarness } from "./command.test-helpers";
import type { RemoteEvent } from "./hub";
import { type Harness, makeHarness, until } from "./remote.test-helpers";
import { BotApiError } from "./types";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function helpNames(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\/(\S+) - /.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe("the command menu (AC12)", () => {
  it("is exactly the gateway's allowed commands after the hub starts", async () => {
    harness = makeHarness();
    const hub = harness.makeHub();
    await hub.start();
    const names = harness.api.myCommands.map((entry) => entry.command);
    expect(names).toEqual(REMOTE_COMMANDS.map((spec) => spec.name.replace(/-/g, "_")));
    expect(harness.api.myCommands).toEqual(remoteMenu());
  });

  it("is set once, for the group chat", async () => {
    harness = makeHarness();
    const hub = harness.makeHub();
    await hub.start();
    expect(harness.api.myCommandsCalls.length).toBe(1);
  });

  it("never lists a refused command", async () => {
    harness = makeHarness();
    const hub = harness.makeHub();
    await hub.start();
    const listed = new Set(harness.api.myCommands.map((entry) => entry.command.replace(/_/g, "-")));
    for (const name of Object.keys(REMOTE_REFUSED)) {
      expect(listed.has(name)).toBe(false);
    }
  });

  it("lists only commands the gateway knows, and the gateway does not call them unknown", () => {
    for (const entry of remoteMenu()) {
      const decision = classifyRemoteCommand(`/${entry.command}`);
      // These need an argument: bare, they are refused for it, not for being off the list.
      expect(decision.kind !== "refuse" || ["delegate", "theme", "think"].includes(decision.command)).toBe(true);
      if (decision.kind === "refuse") {
        expect(decision.known).toBe(true);
      }
    }
  });

  it("uses names Telegram accepts and descriptions within its limit", () => {
    expect(menuNamesAreValid()).toBe(true);
    for (const entry of remoteMenu()) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("records one event, and keeps going, when Telegram refuses the menu", async () => {
    const events: RemoteEvent[] = [];
    harness = makeHarness();
    harness.api.failNext("setMyCommands", new BotApiError("rejected", "Bad Request: nope", { status: 400 }));
    const hub = harness.makeHub({ onEvent: (event) => events.push(event) });
    await hub.start();
    await until(() => events.some((event) => event.type === "menu-failed"), "the menu-failed event");
    expect(events.filter((event) => event.type === "menu-failed").length).toBe(1);
    expect(harness.api.myCommands).toEqual([]);
  });
});

describe("/help in the topic (AC12)", () => {
  it("lists the same commands as the menu", () => {
    const fromHelp = helpNames(remoteHelpText());
    expect(fromHelp).toEqual(remoteMenu().map((entry) => entry.command));
  });

  it("is what the topic receives for /help", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/help");
    await h.bridge.idle();
    const reply = h.client().replies[0] ?? "";
    expect(helpNames(reply)).toEqual(remoteMenu().map((entry) => entry.command));
  });
});
