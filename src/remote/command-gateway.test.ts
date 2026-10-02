// Flow 387, AC1 and AC8: a "/" line from the topic goes to a gateway with an explicit allowlist.
// Anything else answers "not available remotely" with the reason, and nothing runs.

import { describe, expect, it } from "bun:test";
import { classifyRemoteCommand, menuNamesAreValid, REMOTE_COMMANDS, REMOTE_REFUSED, remoteMenu } from "./command-gateway";
import { commandHarness, waitFor } from "./command.test-helpers";

const ALLOWED_TEXT = ["/help", "/status", "/doctor", "/new", "/compact", "/think", "/goal", "/queue", "/reasoning", "/theme dark", "/schedule", "/rewind"];

/** AC8: each of these is refused remotely, and each has its own test below. */
const REFUSED_LINES: Array<[string, string]> = [
  ["/exit", "exit"],
  ["/quit", "quit"],
  ["/channels", "channels"],
  ["/provider", "provider"],
  ["/search-provider", "search-provider"],
  ["/search-connect", "search-connect"],
  ["/remote-control off", "remote-control"],
  ["/integrate", "integrate"],
  ["/copy", "copy"],
  ["/game", "game"],
  ["/setup", "setup"],
  ["/mcp trust", "mcp"],
  ["/guard", "guard"],
  ["/route", "route"],
  ["/editguard", "editguard"],
];

describe("the allowlist (AC1)", () => {
  it("lets each text command through to the shell", () => {
    for (const line of ALLOWED_TEXT) {
      const decision = classifyRemoteCommand(line);
      expect(decision.kind === "run" || decision.kind === "builtin").toBe(true);
    }
  });

  it("keeps the arguments the sender typed", () => {
    expect(classifyRemoteCommand("/theme dark")).toEqual({ kind: "run", command: "theme", line: "/theme dark" });
    expect(classifyRemoteCommand("/compact the parser work")).toEqual({ kind: "run", command: "compact", line: "/compact the parser work" });
  });

  it("accepts the menu spelling and a bot suffix", () => {
    expect(classifyRemoteCommand("/Status@keryx_bot")).toEqual({ kind: "run", command: "status", line: "/status" });
    expect(classifyRemoteCommand("/external_agents").kind).toBe("run");
  });

  it("refuses a command that is on no list, with a reason, and marks it unknown", () => {
    const decision = classifyRemoteCommand("/definitely-not-a-command");
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.known).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(10);
    }
  });

  it("refuses a bare slash", () => {
    expect(classifyRemoteCommand("/").kind).toBe("refuse");
  });

  it("never lists a refused command as allowed", () => {
    const allowed = new Set(REMOTE_COMMANDS.map((spec) => spec.name));
    for (const name of Object.keys(REMOTE_REFUSED)) {
      expect(allowed.has(name)).toBe(false);
    }
  });

  it("has menu names Telegram accepts", () => {
    expect(menuNamesAreValid()).toBe(true);
    for (const entry of remoteMenu()) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("commands refused remotely (AC8)", () => {
  for (const [line, name] of REFUSED_LINES) {
    it(`${line} is refused with a reason`, () => {
      const decision = classifyRemoteCommand(line);
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.command).toBe(name);
        expect(decision.reason.length).toBeGreaterThan(5);
      }
    });

    it(`${line} runs nothing and tells the topic why`, async () => {
      const h = commandHarness();
      await h.bridge.enable();
      await h.say(line);
      const reply = h.client().replies[0] ?? "";
      expect(reply).toContain(`Not available remotely: /${name}`);
      expect(reply.length).toBeGreaterThan(`Not available remotely: /${name}.`.length);
      await h.bridge.idle();
      expect(h.ran).toEqual([]);
      expect(h.calls.filter((call) => call.startsWith("run:") || call.startsWith("queue:"))).toEqual([]);
      expect(h.client().choices).toEqual([]);
    });
  }

  it("answers an unknown command with the same refusal and runs nothing", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/definitely-not-a-command now");
    expect(h.client().replies[0]).toContain("Not available remotely: /definitely-not-a-command");
    expect(h.ran).toEqual([]);
  });

  it("records the refusal in the bridge's recent events", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say("/exit");
    await waitFor(() => h.bridge.status().events.some((event) => event.kind === "command" && event.text.startsWith("refused /exit")), "the refusal event");
  });
});
