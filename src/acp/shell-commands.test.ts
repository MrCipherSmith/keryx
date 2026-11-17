// `_keryx/command` and the served command table of `keryx acp --profile shell`
// (Keryx Desktop Client M2a, specification §3.9.1/§3.9.2/§3.9.6, AC13).
//
// The table is checked against `AGENT_SLASH_COMMANDS` so a command added there without a
// row fails here. The wire tests drive the real server over the in-process harness:
// a representative command per runner family, the busy rules while a turn waits on a
// permission, `/compact` and `/rewind` writing the session store exactly as the shell does,
// and the refusals (unknown, client-handled, view not served yet).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_SLASH_COMMANDS } from "../commands/agent-commands";
import { loadShellConfig } from "../lib/shell-config";
import { listSessions } from "../session";
import { ACP_SLASH_COMMANDS, ACP_TUI_ONLY_COMMANDS } from "./commands";
import { JSON_RPC_ERROR_CODES } from "./jsonrpc";
import { ACP_CLIENT_METHODS } from "./protocol";
import { KERYX_ACP_EXTENSION_METHODS } from "./profile";
import { ACP_SHELL_COMMAND_TABLE, busyRefusalText, findShellCommand, shellAvailableCommands, viewNotServedText } from "./shell-commands";
import { shellCommandHelpText } from "./shell-command-runners";
import { driveTurn, isUpdate, shellHarness, textRound, toolRound, updateOf, updates, type ShellHarness } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;
const COMMAND = KERYX_ACP_EXTENSION_METHODS.command;

interface CommandReply {
  readonly text: string;
  readonly effects: string[] | undefined;
  readonly refused: boolean;
  readonly raw: Record<string, unknown>;
}

/** Sends `_keryx/command` and returns its decoded result. */
async function command(h: ShellHarness, sessionId: string, name: string, args?: string): Promise<CommandReply> {
  const id = h.request(COMMAND, { sessionId, name, ...(args !== undefined ? { args } : {}) });
  const reply = await h.waitFor((f) => f.id === id);
  if (reply.result === undefined) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
  const keryx = ((reply.result["_meta"] as { keryx?: { effects?: string[]; refused?: boolean } } | undefined)?.keryx ?? {}) as {
    effects?: string[];
    refused?: boolean;
  };
  return { text: reply.result["text"] as string, effects: keryx.effects, refused: keryx.refused === true, raw: reply.result };
}

async function commandError(h: ShellHarness, sessionId: string, name: string, args?: string) {
  const id = h.request(COMMAND, { sessionId, name, ...(args !== undefined ? { args } : {}) });
  const reply = await h.waitFor((f) => f.id === id);
  if (reply.error === undefined) throw new Error(`${name}: expected an error, got ${JSON.stringify(reply.result)}`);
  return reply.error;
}

const configDirs: string[] = [];
function tempConfigDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-acp-cmd-config-"));
  configDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of configDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the served table", () => {
  const registry = AGENT_SLASH_COMMANDS.filter((entry) => entry.modes.includes("agent")).map((entry) => entry.name.slice(1));
  const rowNames = ACP_SHELL_COMMAND_TABLE.map((row) => row.name);

  test("every agent-mode command is a row or explicitly not advertised — adding one to the registry without either fails here", () => {
    const unaccounted = registry.filter((name) => !rowNames.includes(name) && !ACP_TUI_ONLY_COMMANDS.includes(name));
    expect(unaccounted).toEqual([]);
  });

  test("a row is a real agent-mode command, never a not-advertised one, and no command is twice in the table", () => {
    expect(rowNames.filter((name) => !registry.includes(name))).toEqual([]);
    expect(rowNames.filter((name) => ACP_TUI_ONLY_COMMANDS.includes(name))).toEqual([]);
    expect(new Set(rowNames).size).toBe(rowNames.length);
  });

  test("chat-only commands never reach the table", () => {
    const chatOnly = AGENT_SLASH_COMMANDS.filter((entry) => !entry.modes.includes("agent")).map((entry) => entry.name.slice(1));
    expect(chatOnly).toContain("models");
    expect(rowNames.filter((name) => chatOnly.includes(name))).toEqual([]);
  });

  test("client commands and dialogs are named by the specification; every text row has a runner", () => {
    expect(ACP_SHELL_COMMAND_TABLE.filter((row) => row.surface === "client").map((row) => row.name).sort()).toEqual(
      ["clear", "interrupt", "new", "queue", "resume", "sessions"],
    );
    expect(ACP_SHELL_COMMAND_TABLE.filter((row) => row.surface === "dialog").map((row) => row.name).sort()).toEqual(["connect", "search-provider"]);
    expect(ACP_SHELL_COMMAND_TABLE.filter((row) => row.surface === "text" && row.runner === "none").map((row) => row.name)).toEqual([]);
    for (const name of ["routing", "ci", "conform", "task", "review", "product", "governance", "triggers", "schedule", "schedules", "autoreview", "jevprofile", "ac", "workspace", "bus", "guard", "editguard", "projectctx"]) {
      expect(findShellCommand(name)?.surface).toBe("view");
    }
  });

  test("busy follows busy-dispatch.ts: what the shell runs while busy runs, what it queues or refuses is refused", () => {
    for (const name of ["help", "status", "flows", "mode", "plan", "demote", "bus", "reviews", "remote-control", "history", "channels", "intake", "remote-policy", "approvals", "permissions", "external-diff", "diag", "interrupt", "queue", "delegate"]) {
      expect(findShellCommand(name)?.busy).toBe("run");
    }
    for (const name of ["new", "clear", "resume", "sessions", "rewind", "compact", "model", "reasoning", "doctor", "tasks", "trail", "notes", "goal", "route", "external"]) {
      expect(findShellCommand(name)?.busy).toBe("refuse");
    }
  });

  test("a refused command uses the shell's own wording: the session-replacing ones say so, the rest are deferred", () => {
    expect(busyRefusalText("rewind")).toContain("would replace the session under the running turn");
    expect(busyRefusalText("doctor")).toBe("main is busy: command deferred");
  });

  test("the not-yet-served view answer lives in one place", () => {
    expect(viewNotServedText("routing")).toBe("routing is not served yet");
  });

  test("/help lists every served command", () => {
    const help = shellCommandHelpText();
    for (const row of ACP_SHELL_COMMAND_TABLE) expect(help).toContain(`/${row.name}`);
  });

  test("available commands carry _meta.keryx = { group, surface, busy } and the editor shape otherwise", () => {
    const advertised = shellAvailableCommands();
    expect(advertised.map((entry) => entry.name)).toEqual(rowNames);
    for (const entry of advertised) {
      expect(Object.keys(entry._meta.keryx).sort()).toEqual(["busy", "group", "surface"]);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.name.startsWith("/")).toBe(false);
    }
  });
});

describe("available_commands_update", () => {
  test("the shell profile advertises the table with _meta.keryx; the editor profile stays its four, unchanged", async () => {
    const shell = shellHarness();
    try {
      await shell.initialize();
      await shell.newSession();
      const update = updateOf(await shell.waitFor(isUpdate("available_commands_update")));
      const commands = update["availableCommands"] as { name: string; _meta?: { keryx?: { group: string; surface: string; busy: string } } }[];
      expect(commands.map((entry) => entry.name)).toEqual(ACP_SHELL_COMMAND_TABLE.map((row) => row.name));
      expect(commands.find((entry) => entry.name === "doctor")?._meta?.keryx).toMatchObject({ surface: "text", busy: "refuse" });
      expect(commands.find((entry) => entry.name === "new")?._meta?.keryx?.surface).toBe("client");
      expect(commands.find((entry) => entry.name === "connect")?._meta?.keryx?.surface).toBe("dialog");
      expect(commands.find((entry) => entry.name === "routing")?._meta?.keryx?.surface).toBe("view");
      expect(commands.every((entry) => typeof entry._meta?.keryx?.group === "string")).toBe(true);
    } finally {
      await shell.end();
    }
    const editor = shellHarness({ profile: "editor" });
    try {
      await editor.initialize();
      await editor.newSession();
      const update = updateOf(await editor.waitFor(isUpdate("available_commands_update")));
      const commands = update["availableCommands"] as { name: string; _meta?: unknown }[];
      expect(commands.map((entry) => entry.name)).toEqual(ACP_SLASH_COMMANDS.map((entry) => entry.name));
      expect(commands.some((entry) => entry._meta !== undefined)).toBe(false);
    } finally {
      await editor.end();
    }
  }, TIMEOUT_MS);

  test("the editor profile does not serve _keryx/command at all", async () => {
    const editor = shellHarness({ profile: "editor" });
    try {
      await editor.initialize();
      const { sessionId } = await editor.newSession();
      const id = editor.request(COMMAND, { sessionId, name: "help" });
      expect((await editor.waitFor((f) => f.id === id)).error?.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
    } finally {
      await editor.end();
    }
  }, TIMEOUT_MS);
});

describe("_keryx/command over the wire", () => {
  test("text runners answer what the shell would print, with effects only where state changed", async () => {
    const configDir = tempConfigDir();
    const h = shellHarness({ serverOptions: { shellConfigDir: configDir } });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();

      const help = await command(h, sessionId, "help");
      expect(help.refused).toBe(false);
      expect(help.text).toContain("/doctor");
      expect(help.effects).toEqual([]);

      // Leading slash and case are tolerated; the server family answers mode with its effect.
      const mode = await command(h, sessionId, "/Mode", "trust");
      expect(mode.text).toContain("Permission mode: trust");
      expect(mode.effects).toEqual(["mode"]);
      expect(updateOf(await h.waitFor(isUpdate("current_mode_update")))["currentModeId"]).toBe("trust");
      expect((await command(h, sessionId, "mode")).effects).toEqual([]);

      const reasoning = await command(h, sessionId, "reasoning", "high");
      expect(reasoning.effects).toEqual(["config"]);

      const plan = await command(h, sessionId, "plan", "on");
      expect(plan.text).toContain("Read-only mode: on");
      expect(plan.effects).toEqual(["plan"]);
      expect((await command(h, sessionId, "plan")).text).toContain("Read-only mode: on");
      expect((await command(h, sessionId, "plan", "off")).text).toContain("Read-only mode: off");

      const flows = await command(h, sessionId, "flows");
      expect(flows.text).toContain("Flows");
      expect((await command(h, sessionId, "flows", "999")).text).toContain("No flow matching '999'.");

      expect((await command(h, sessionId, "setup")).text.length).toBeGreaterThan(0);
      expect((await command(h, sessionId, "external-diff")).text).toContain("No write runs are waiting for review.");
      expect((await command(h, sessionId, "reviews")).text).toContain("No managed pull request reviews yet");
      expect((await command(h, sessionId, "diag")).text.length).toBeGreaterThan(0);
      expect((await command(h, sessionId, "remote-control", "status")).text).toContain("Remote control: off");
      expect((await command(h, sessionId, "tasks")).text.length).toBeGreaterThan(0);
      expect((await command(h, sessionId, "demote")).text).toContain("usage:");
      expect((await command(h, sessionId, "mcp", "trust list")).text).toContain("No MCP tools are trusted in this session.");
      expect((await command(h, sessionId, "review", "layers")).refused).toBe(false);
      expect((await command(h, sessionId, "search-connect", "no-such-provider")).text).toBe("Unknown provider 'no-such-provider'.");
      expect((await command(h, sessionId, "search-connect", "no-such-provider")).refused).toBe(true);

      const settings = await command(h, sessionId, "settings");
      expect(settings.text).toContain("Permission mode");

      // User-global settings write to the config directory the server was given, and say so in effects.
      const route = await command(h, sessionId, "route", "on");
      expect(route.text).toBe("Route: on\n");
      expect(route.effects).toEqual(["config"]);
      expect(loadShellConfig(configDir).routingClassifier?.enabled).toBe(true);
      expect((await command(h, sessionId, "route")).text).toBe("Route: on\n");
      expect((await command(h, sessionId, "guard", "on")).effects).toEqual(["config"]);
      expect(loadShellConfig(configDir).turnGuard?.enabled).toBe(true);
      expect((await command(h, sessionId, "guard", "maybe")).text).toContain("Unknown /guard argument 'maybe'");
      const rendering = await command(h, sessionId, "rendering", "plain");
      expect(rendering.effects).toEqual(["config"]);
      expect((await command(h, sessionId, "rendering")).text).toContain("plain");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("commands that need a terminal, a bus or the turn slot are refused with a reason, not faked", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      for (const [name, args, reason] of [
        ["goal", "ship it", "starts an agent turn"],
        ["delegate", "claude fix", "no external-run port"],
        ["bus", "send @x hi", "agent bus is not joined"],
      ] as const) {
        const reply = await command(h, sessionId, name, args);
        expect(reply.refused).toBe(true);
        expect(reply.text).toContain(reason);
        expect(reply.effects).toBeUndefined();
      }
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a view command answers 'not served yet' (T10b replaces it), bare or with arguments it has no text form for", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      for (const [name, args] of [["routing", undefined], ["governance", undefined], ["bus", undefined], ["guard", undefined], ["projectctx", undefined], ["mcp", undefined], ["review", undefined]] as const) {
        const reply = await command(h, sessionId, name, args);
        expect(reply.text).toBe(viewNotServedText(name));
        expect(reply.refused).toBe(true);
      }
      // The text forms of a view command still run.
      expect((await command(h, sessionId, "guard", "off")).refused).toBe(false);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("an unknown or not-advertised command is -32602 naming it; so is a client-handled one", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const unknown = await commandError(h, sessionId, "no-such-command");
      expect(unknown.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
      expect(unknown.message).toContain("/no-such-command");
      for (const name of ["think", "expand", "copy", "theme", "game", "exit", "quit", "integrate", "models"]) {
        expect((await commandError(h, sessionId, name)).code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
      }
      for (const name of ["new", "clear", "resume", "sessions", "interrupt", "queue", "connect", "search-provider"]) {
        const error = await commandError(h, sessionId, name);
        expect(error.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
        expect(error.message).toContain("handled by the desktop client");
      }
      const id = h.request(COMMAND, { sessionId: "not-a-session", name: "help" });
      expect((await h.waitFor((f) => f.id === id)).error?.code).toBe(JSON_RPC_ERROR_CODES.resourceNotFound);
      const bad = h.request(COMMAND, { sessionId, name: "help", args: 3 });
      expect((await h.waitFor((f) => f.id === bad)).error?.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("it is not a turn: no prompt slot, no model call, nothing added to the history", async () => {
    // One scripted round only: a command that reached the model would run out of rounds.
    const h = shellHarness({ rounds: [textRound("the only answer")] });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      await driveTurn(h, sessionId, "hello");
      const before = (await command(h, sessionId, "history")).text;
      expect(before).toContain("the only answer");
      for (const name of ["help", "status", "flows", "plan", "settings"]) await command(h, sessionId, name);
      expect((await command(h, sessionId, "history")).text).toBe(before);
      // Commands answer in their reply, never as agent text of a turn.
      expect(updates(h.frames, "agent_message_chunk").filter((u) => (u.content?.text ?? "").includes("Commands keryx handles"))).toHaveLength(0);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("while a turn waits on a permission: commands the shell runs while busy run, the rest are refused with its wording", async () => {
    const h = shellHarness({ rounds: [toolRound("x1", "shell_exec", { command: "echo busy" }), textRound("done")] });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const promptId = h.prompt(sessionId, "go");
      const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);

      // Runs: /mode, /help, /plan are busy "run".
      expect((await command(h, sessionId, "mode", "trust")).effects).toEqual(["mode"]);
      expect((await command(h, sessionId, "help")).refused).toBe(false);
      expect((await command(h, sessionId, "plan")).refused).toBe(false);

      // Refused, with the wording the shell uses: deferred, or "would replace the session".
      const doctor = await command(h, sessionId, "doctor");
      expect(doctor).toMatchObject({ refused: true, text: busyRefusalText("doctor") });
      expect((await command(h, sessionId, "compact")).text).toBe(busyRefusalText("compact"));
      const rewind = await command(h, sessionId, "rewind");
      expect(rewind.refused).toBe(true);
      expect(rewind.text).toContain("would replace the session under the running turn");
      expect(rewind.effects).toBeUndefined();

      h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
      expect((await h.waitFor((f) => f.id === promptId)).result).toEqual({ stopReason: "end_turn" });
      // Idle again: the deferred command now runs.
      expect((await command(h, sessionId, "compact")).refused).toBe(false);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("/plan is read-only mode for the session's turns", () => {
  test("with /plan on, a write the mode would run unasked does not run; /plan off restores it", async () => {
    const h = shellHarness({
      storedMode: "trust",
      rounds: [
        toolRound("x1", "shell_exec", { command: "touch blocked-by-plan" }),
        textRound("first done"),
        toolRound("x2", "shell_exec", { command: "touch allowed-after-plan" }),
        textRound("second done"),
      ],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      await command(h, sessionId, "plan", "on");
      await driveTurn(h, sessionId, "write something", () => "reject_once");
      expect(existsSync(path.join(h.projectDir, "blocked-by-plan"))).toBe(false);
      await command(h, sessionId, "plan", "off");
      await driveTurn(h, sessionId, "write it now");
      expect(existsSync(path.join(h.projectDir, "allowed-after-plan"))).toBe(true);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("transcript commands persist as the shell does", () => {
  const turns = (count: number) => Array.from({ length: count }, (_, index) => textRound(`answer ${index + 1}`));

  test("/compact rewrites the stored transcript, keeps the archive, and says transcript changed", async () => {
    const h = shellHarness({ rounds: turns(5) });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      // Nothing to compact in a short conversation: said, and nothing is claimed changed.
      const none = await command(h, sessionId, "compact");
      expect(none.text).toContain("Nothing to compact");
      expect(none.effects).toEqual([]);

      for (let index = 1; index <= 5; index += 1) await driveTurn(h, sessionId, `question ${index}`);
      const dataDir = path.join(h.projectDir, "data");
      const before = listSessions(h.projectDir, dataDir).find((entry) => entry.id === sessionId);
      expect(before?.compactCount ?? 0).toBe(0);

      const compacted = await command(h, sessionId, "compact", "keep the plan");
      expect(compacted.text).toMatch(/^Compacted −\d+ context msgs · archive \d+ · compact×1/);
      expect(compacted.effects).toEqual(["transcript"]);
      const after = listSessions(h.projectDir, dataDir).find((entry) => entry.id === sessionId);
      expect(after?.compactCount).toBe(1);
      expect(after?.archiveMessageCount).toBeGreaterThan(0);
      // The archive still holds what the context dropped.
      expect((await command(h, sessionId, "history")).text).toContain("question 1");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("/rewind lists, previews, and confirm cuts the conversation back and persists it; one confirm only", async () => {
    const h = shellHarness({
      storedMode: "trust",
      rounds: [textRound("first answer"), toolRound("x1", "shell_exec", { command: "echo changed > rewound.txt" }), textRound("second answer")],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      expect((await command(h, sessionId, "rewind")).text).toContain("No ");
      await driveTurn(h, sessionId, "first question");
      await driveTurn(h, sessionId, "second question");
      expect(existsSync(path.join(h.projectDir, "rewound.txt"))).toBe(true);

      const list = await command(h, sessionId, "rewind");
      expect(list.refused).toBe(false);
      expect(list.text).toContain("second question");
      expect((await command(h, sessionId, "rewind", "confirm")).text).toContain("Nothing to confirm");

      const preview = await command(h, sessionId, "rewind", "1 history");
      expect(preview.text).toContain("/rewind confirm");
      expect(preview.effects).toEqual([]);
      const dataDir = path.join(h.projectDir, "data");
      const sizeBefore = listSessions(h.projectDir, dataDir).find((entry) => entry.id === sessionId)?.messageCount ?? 0;

      const applied = await command(h, sessionId, "rewind", "confirm");
      expect(applied.refused).toBe(false);
      expect(applied.effects).toEqual(["transcript"]);
      const sizeAfter = listSessions(h.projectDir, dataDir).find((entry) => entry.id === sessionId)?.messageCount ?? 0;
      expect(sizeAfter).toBeLessThan(sizeBefore);
      // The conversation is cut: the second question is gone from the live history the next command reads.
      expect((await command(h, sessionId, "history")).text).not.toContain("second answer");
      expect((await command(h, sessionId, "rewind", "confirm")).text).toContain("Nothing to confirm");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("/rewind says so when KERYX_REWIND=off, and a pick that is not a snapshot is usage, not an action", async () => {
    const h = shellHarness({ rounds: turns(1) });
    const previous = process.env["KERYX_REWIND"];
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      expect((await command(h, sessionId, "rewind", "banana")).text).toContain("Usage: /rewind");
      process.env["KERYX_REWIND"] = "off";
      expect((await command(h, sessionId, "rewind")).text).toContain("Rewind is off");
    } finally {
      if (previous === undefined) delete process.env["KERYX_REWIND"];
      else process.env["KERYX_REWIND"] = previous;
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a transcript command is refused while another transcript command runs: it holds the session's slot", async () => {
    const h = shellHarness({ rounds: turns(1) });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const first = h.request(COMMAND, { sessionId, name: "rewind" });
      const prompt = h.prompt(sessionId, "race");
      const frames = await Promise.all([h.waitFor((f) => f.id === first), h.waitFor((f) => f.id === prompt)]);
      // Either the rewind finished before the prompt landed or the prompt was refused as busy: never both interleaved.
      const refusedPrompt = frames[1].error !== undefined;
      expect(refusedPrompt || frames[1].result !== undefined).toBe(true);
      expect(frames[0].result?.["text"]).toBeDefined();
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("the persisted file is untouched by commands that only read", async () => {
    const h = shellHarness({ rounds: turns(1) });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      await driveTurn(h, sessionId, "one");
      const dataDir = path.join(h.projectDir, "data");
      const summary = () => listSessions(h.projectDir, dataDir).find((entry) => entry.id === sessionId);
      const before = JSON.stringify(summary());
      for (const name of ["help", "status", "history", "flows", "plan", "trail", "notes"]) await command(h, sessionId, name);
      expect(JSON.stringify(summary())).toBe(before);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});
