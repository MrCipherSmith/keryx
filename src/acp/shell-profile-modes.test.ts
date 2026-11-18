// `keryx acp --profile shell` permission modes (Keryx Desktop Client M1,
// specification §3.4 — AC3).
//
// Modes are advertised on session/new and session/load, start from the
// project's stored default, switch through session/set_mode and /mode, and
// change the gate exactly as the shell's `resolveApprovalDecision` does:
// `ask` asks, `trust` runs non-destructive calls unasked and still asks for a
// destructive one (never offering allow_always), `auto` runs everything but a
// credential-touching call unasked. Every unasked call is marked
// `_meta.keryx.autoApproved` on the id the client was shown.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { isDestructiveCommand } from "../lib/command-risk";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { callsOf, driveTurn, isUpdate, shellHarness, textRound, toolRound, updateOf, updates } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;

/**
 * Destructive by keryx's own classifier, and harmless here: the session's
 * project is not a git repository, so running it (in `auto`) only fails.
 */
const DESTRUCTIVE = "git push --force origin main";

test("the destructive fixture command is destructive by the shell's classifier", () => {
  expect(isDestructiveCommand(DESTRUCTIVE)).toBe(true);
});

describe("AC3 — modes are advertised", () => {
  test("session/new carries ask/trust/auto with names and descriptions, starting at ask", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { result } = await h.newSession();
      const modes = result["modes"] as { currentModeId: string; availableModes: { id: string; name: string; description: string }[] };
      expect(modes.currentModeId).toBe("ask");
      expect(modes.availableModes.map((mode) => mode.id)).toEqual(["ask", "trust", "auto"]);
      for (const mode of modes.availableModes) {
        expect(mode.name.length).toBeGreaterThan(0);
        expect(mode.description.length).toBeGreaterThan(0);
      }
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("the project's stored default is the initial mode, on session/new and on session/load", async () => {
    const h = shellHarness({ storedMode: "trust" });
    try {
      await h.initialize();
      const { sessionId, result } = await h.newSession();
      expect((result["modes"] as { currentModeId: string }).currentModeId).toBe("trust");
      const loadId = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [] });
      const loaded = await h.waitFor((f) => f.id === loadId);
      expect((loaded.result?.["modes"] as { currentModeId: string }).currentModeId).toBe("trust");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("the editor profile is unchanged: no modes, and session/set_mode is still refused with -32601", async () => {
    const h = shellHarness({ profile: "editor" });
    try {
      await h.initialize();
      const { sessionId, result } = await h.newSession();
      expect(result["modes"]).toBeUndefined();
      const id = h.request("session/set_mode", { sessionId, modeId: "trust" });
      const reply = await h.waitFor((f) => f.id === id);
      expect(reply.error?.code).toBe(-32601);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("AC3 — session/set_mode and /mode", () => {
  test("set_mode switches, answers {}, and emits current_mode_update after the reply; bad input is refused", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const id = h.request("session/set_mode", { sessionId, modeId: "auto" });
      const reply = await h.waitFor((f) => f.id === id);
      expect(reply.result).toEqual({});
      const update = await h.waitFor(isUpdate("current_mode_update"));
      expect(updateOf(update)["currentModeId"]).toBe("auto");
      expect(h.frames.indexOf(update)).toBeGreaterThan(h.frames.indexOf(reply));

      const bad = h.request("session/set_mode", { sessionId, modeId: "yolo" });
      expect((await h.waitFor((f) => f.id === bad)).error?.code).toBe(-32602);
      const unknown = h.request("session/set_mode", { sessionId: "no-such-session", modeId: "ask" });
      expect((await h.waitFor((f) => f.id === unknown)).error).toBeDefined();
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("/mode shows and sets the mode, is advertised, and emits current_mode_update", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const commands = await h.waitFor(isUpdate("available_commands_update"));
      const names = (updateOf(commands)["availableCommands"] as { name: string }[]).map((command) => command.name);
      // The shell profile advertises the whole served table (shell-commands.test.ts pins it); these five stay first-class.
      for (const name of ["help", "model", "reasoning", "status", "mode"]) expect(names).toContain(name);

      const set = h.prompt(sessionId, "/mode trust");
      expect((await h.waitFor((f) => f.id === set)).result).toEqual({ stopReason: "end_turn" });
      expect(updateOf(await h.waitFor(isUpdate("current_mode_update")))["currentModeId"]).toBe("trust");

      const show = h.prompt(sessionId, "/mode");
      await h.waitFor((f) => f.id === show);
      const texts = updates(h.frames, "agent_message_chunk").map((u) => u.content?.text ?? "");
      expect(texts.some((text) => text.includes("Permission mode: trust"))).toBe(true);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("AC3 — the gate follows the mode", () => {
  test("ask: a shell command is asked, under the id the client was shown", async () => {
    const marker = "ran-in-ask";
    const h = shellHarness({ rounds: [toolRound("x1", "shell_exec", { command: `touch ${marker}` }), textRound("done")] });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { asks } = await driveTurn(h, sessionId, "go");
      const shell = callsOf(h.frames, "shell_exec");
      expect(asks).toHaveLength(1);
      expect((asks[0]?.params as { toolCall?: { toolCallId?: string } }).toolCall?.toolCallId).toBe(shell.announced[0]?.toolCallId);
      expect(shell.updates.some((u) => u._meta?.keryx?.["autoApproved"] === true)).toBe(false);
      expect(existsSync(path.join(h.projectDir, marker))).toBe(true);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("trust: a non-destructive command runs unasked and is marked autoApproved on its own id", async () => {
    const marker = "ran-in-trust";
    const h = shellHarness({
      storedMode: "trust",
      rounds: [toolRound("x1", "shell_exec", { command: `touch ${marker}` }), textRound("done")],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { reply, asks } = await driveTurn(h, sessionId, "go");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
      expect(asks).toHaveLength(0);
      const shell = callsOf(h.frames, "shell_exec");
      expect(shell.announced).toHaveLength(1);
      const marked = shell.updates.filter((u) => u._meta?.keryx?.["autoApproved"] === true);
      expect(marked).toHaveLength(1);
      expect(marked[0]?.toolCallId).toBe(shell.announced[0]?.toolCallId);
      expect(shell.updates.at(-1)?.status).toBe("completed");
      expect(existsSync(path.join(h.projectDir, marker))).toBe(true);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("trust: a destructive command is still asked, without allow_always, and does not run on reject", async () => {
    const h = shellHarness({
      storedMode: "trust",
      rounds: [toolRound("x1", "shell_exec", { command: DESTRUCTIVE }), textRound("done")],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { asks } = await driveTurn(h, sessionId, "go", () => ACP_PERMISSION_OPTION_IDS.rejectOnce);
      expect(asks).toHaveLength(1);
      const optionIds = ((asks[0]?.params as { options?: { optionId: string }[] }).options ?? []).map((o) => o.optionId);
      expect(optionIds).not.toContain(ACP_PERMISSION_OPTION_IDS.allowAlways);
      const shell = callsOf(h.frames, "shell_exec");
      expect(shell.updates.some((u) => u._meta?.keryx?.["autoApproved"] === true)).toBe(false);
      expect(shell.updates.at(-1)?.status).toBe("failed");
      expect(String(shell.updates.at(-1)?.rawOutput)).toContain("not approved");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("auto: a destructive command runs unasked; a credential-touching one is still asked", async () => {
    const h = shellHarness({
      storedMode: "auto",
      rounds: [
        toolRound("x1", "shell_exec", { command: DESTRUCTIVE }),
        toolRound("x2", "shell_exec", { command: "cat auth.json" }),
        textRound("done"),
      ],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { asks } = await driveTurn(h, sessionId, "go", () => ACP_PERMISSION_OPTION_IDS.rejectOnce);
      expect(asks).toHaveLength(1);
      expect(JSON.stringify((asks[0]?.params as { toolCall?: { rawInput?: unknown } }).toolCall?.rawInput)).toContain("auth.json");
      const marked = callsOf(h.frames, "shell_exec").updates.filter((u) => u._meta?.keryx?.["autoApproved"] === true);
      expect(marked).toHaveLength(1);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("set_mode mid-session changes the next call's gate", async () => {
    const h = shellHarness({
      rounds: [
        toolRound("x1", "shell_exec", { command: "touch first" }),
        textRound("one"),
        toolRound("x2", "shell_exec", { command: "touch second" }),
        textRound("two"),
      ],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      expect((await driveTurn(h, sessionId, "first")).asks).toHaveLength(1);
      const id = h.request("session/set_mode", { sessionId, modeId: "trust" });
      await h.waitFor((f) => f.id === id);
      expect((await driveTurn(h, sessionId, "second")).asks).toHaveLength(0);
      expect(existsSync(path.join(h.projectDir, "second"))).toBe(true);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("auto mode tells the client when it answered ask_user itself", () => {
  const ASK = { question: "Which scope?", options: [{ id: "full", label: "Full", recommended: true }, { id: "small", label: "Small" }] };
  const CAPS = { _meta: { keryx: { askUser: true } } };

  test("auto: an agent_message_chunk notice carries _meta.keryx.selfAnsweredQuestion and the client is never asked", async () => {
    const h = shellHarness({
      storedMode: "auto",
      clientCapabilities: CAPS,
      rounds: [toolRound("q1", "ask_user", ASK), textRound("done")],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { reply } = await driveTurn(h, sessionId, "go");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
      expect(h.frames.some((f) => f.method === "_keryx/ask_user")).toBe(false);
      const notices = updates(h.frames, "agent_message_chunk").filter((u) => u._meta?.keryx?.["selfAnsweredQuestion"] === true);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.content?.text).toBe("Auto mode answered: Which scope? → Full\n");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("ask: the client is asked and no self-answer notice is emitted", async () => {
    const h = shellHarness({
      clientCapabilities: CAPS,
      rounds: [toolRound("q1", "ask_user", ASK), textRound("done")],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const id = h.prompt(sessionId, "go");
      const asked = await h.waitFor((f) => f.method === "_keryx/ask_user");
      h.respond(asked.id, { result: { outcome: { outcome: "selected", optionId: "small" } } });
      await h.waitFor((f) => f.id === id && f.method === undefined);
      const notices = updates(h.frames, "agent_message_chunk").filter((u) => u._meta?.keryx?.["selfAnsweredQuestion"] === true);
      expect(notices).toHaveLength(0);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});
