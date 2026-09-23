// keryx's project tools, slash commands and model switching over a REAL stdio
// pipe (flow 288, AC8).
//
// A spawned `keryx acp --fixture`, driven the way an editor drives it. The
// fixture provider replays turns in call order across the whole process and
// substitutes `{{model}}` with the model the turn's provider was built for —
// so the model a turn ACTUALLY ran is on the wire, in its text, and a command
// that wrongly reached the model would consume a scripted turn and shift every
// later answer. Every wait is on a frame; there is no timer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { AcpProcessClient, type WireMessage } from "./process-client.test-helpers";
import { ACP_PROTOCOL_VERSION } from "./protocol";

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-project-tools-")));
  projectDir = path.join(root, "project");
  dataDir = path.join(root, "data");
  // A project with a usable metaproject: `keryx shell` would offer it the
  // project tools, so an ACP session must too (AC1).
  mkdirSync(path.join(projectDir, ".metaproject"), { recursive: true });
  writeFileSync(path.join(projectDir, ".metaproject", "metaproject.json"), "{}", "utf8");
  writeFileSync(path.join(projectDir, "notes.txt"), "the needle is here\n", "utf8");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFixture(turns: readonly (readonly Record<string, unknown>[])[], models?: readonly string[]): string {
  const file = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ turns, ...(models !== undefined ? { models } : {}) }), "utf8");
  return file;
}

const say = (text: string): Record<string, unknown>[] => [{ kind: "text_delta", text }, { kind: "model_end" }];

async function openSession(client: AcpProcessClient): Promise<{ sessionId: string; result: Record<string, unknown> }> {
  const initId = client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
  await client.waitFor((m) => m.id === initId, "the initialize reply");
  const newId = client.request("session/new", { cwd: projectDir, mcpServers: [] });
  const created = await client.waitFor((m) => m.id === newId, "the session/new reply");
  const result = created.result ?? {};
  const sessionId = result["sessionId"];
  if (typeof sessionId !== "string") {
    throw new Error(`session/new returned no sessionId: ${JSON.stringify(created)}`);
  }
  return { sessionId, result };
}

/** Sends a prompt and waits for its reply; returns the agent text the turn streamed. */
async function prompt(client: AcpProcessClient, sessionId: string, text: string): Promise<{ reply: WireMessage; text: string }> {
  const before = client.messages().length;
  const id = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  const reply = await client.waitFor((m) => m.id === id, `the reply to "${text}"`);
  return { reply, text: agentTextSince(client, before) };
}

function agentTextSince(client: AcpProcessClient, index: number): string {
  return client
    .messages()
    .slice(index)
    .filter(
      (m) =>
        m.method === "session/update" &&
        (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "agent_message_chunk",
    )
    .map((m) => (m.params?.["update"] as { content?: { text?: string } }).content?.text ?? "")
    .join("");
}

function modelOption(configOptions: unknown): { currentValue: string; options: { value: string }[]; category: string; type: string } {
  const list = configOptions as { id: string; currentValue: string; options: { value: string }[]; category: string; type: string }[];
  const option = list.find((entry) => entry.id === "model");
  if (option === undefined) throw new Error(`no model option in ${JSON.stringify(configOptions)}`);
  return option;
}

describe("AC8 — project tools, commands and model switching over a real pipe", () => {
  test("the project tools are offered, and one is called in a turn", async () => {
    const client = new AcpProcessClient({
      fixture: writeFixture([
        [
          { kind: "tool_call_start", toolCallId: "s1", toolName: "search_code" },
          { kind: "tool_call_end", toolCallId: "s1", input: JSON.stringify({ pattern: "needle" }) },
          { kind: "model_end" },
        ],
        say("found it."),
      ]),
      cwd: projectDir,
      dataDir,
      homeRoot: root,
    });
    try {
      const { sessionId } = await openSession(client);

      // `/status` lists the tools the session's turns are offered.
      const status = await prompt(client, sessionId, "/status");
      expect(status.text).toContain("graph_find");
      expect(status.text).toContain("memory_search");
      expect(status.text).toContain("flow_status");
      expect(status.text).not.toContain("web_fetch");

      const turn = await prompt(client, sessionId, "where is the needle?");
      expect((turn.reply.result as { stopReason?: string }).stopReason).toBe("end_turn");
      const call = client
        .updates("tool_call")
        .map((m) => m.params?.["update"] as { toolCallId: string; name?: string; kind?: string })
        .find((update) => update.name === "search_code");
      expect(call?.kind).toBe("search");
      const closed = await client.waitFor(
        (m) =>
          (m.params?.["update"] as { sessionUpdate?: string; toolCallId?: string })?.sessionUpdate === "tool_call_update" &&
          (m.params?.["update"] as { toolCallId?: string })?.toolCallId === call?.toolCallId,
        "the search_code result",
      );
      const update = closed.params?.["update"] as { status?: string; rawOutput?: string };
      expect(update.status).toBe("completed");
      expect(String(update.rawOutput)).toContain("notes.txt");
      expect(turn.text).toContain("found it.");
    } finally {
      await client.kill();
    }
  }, 60_000);

  test("commands: one update after session/new, a / command never reaches the model, an unlisted one gets the list", async () => {
    const client = new AcpProcessClient({ fixture: writeFixture([say("model turn 1.")]), cwd: projectDir, dataDir, homeRoot: root });
    try {
      const { sessionId } = await openSession(client);
      const update = await client.waitFor(
        (m) => (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "available_commands_update",
        "available_commands_update",
      );
      expect(update.params?.["sessionId"]).toBe(sessionId);
      const commands = (update.params?.["update"] as { availableCommands: { name: string; description: string; input?: { hint: string } }[] })
        .availableCommands;
      expect(commands.map((command) => command.name)).toEqual(["help", "model", "reasoning", "status"]);
      expect(commands.find((command) => command.name === "model")?.input?.hint).toEqual(expect.any(String));

      const help = await prompt(client, sessionId, "/help");
      expect((help.reply.result as { stopReason?: string }).stopReason).toBe("end_turn");
      expect(help.text).toContain("/model");

      const unknown = await prompt(client, sessionId, "/workspace");
      expect(unknown.text).toContain("keryx does not handle /workspace");
      expect(unknown.text).toContain("/status");

      // Neither command consumed a scripted turn: the first real prompt gets turn 1.
      const real = await prompt(client, sessionId, "hello");
      expect(real.text).toBe("model turn 1.");
      expect(client.updates("available_commands_update")).toHaveLength(1);

      // session/load: the model option on the response, and one more commands update.
      const loadId = client.request("session/load", { sessionId, cwd: projectDir, mcpServers: [] });
      const loaded = await client.waitFor((m) => m.id === loadId, "the session/load reply");
      expect(modelOption(loaded.result?.["configOptions"]).currentValue).toBe("fixture/fixture-model");
      await client.waitFor(
        (m) =>
          (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "available_commands_update" &&
          client.updates("available_commands_update").length === 2,
        "the second available_commands_update",
      );
      const frames = client.messages();
      const second = client.updates("available_commands_update")[1]!;
      expect(frames.indexOf(second)).toBeGreaterThan(frames.findIndex((m) => m.id === loadId));
    } finally {
      await client.kill();
    }
  }, 60_000);

  test("model: configOptions on session/new, switched by set_config_option and /model from the next turn, never mid-turn", async () => {
    const client = new AcpProcessClient({
      fixture: writeFixture(
        [
          say("ran on {{model}}."), // prompt 1
          say("ran on {{model}}."), // prompt 2, after set_config_option -> fixture-b
          [
            // prompt 3: a gated call holds the turn open while the model is switched
            { kind: "tool_call_start", toolCallId: "x1", toolName: "shell_exec" },
            { kind: "tool_call_end", toolCallId: "x1", input: JSON.stringify({ command: "echo hi" }) },
            { kind: "model_end" },
          ],
          say("still on {{model}}."), // prompt 3, second round — same turn
          say("ran on {{model}}."), // prompt 4
          say("ran on {{model}}."), // prompt 5, after /model fixture-b
        ],
        ["fixture-a", "fixture-b"],
      ),
      cwd: projectDir,
      dataDir,
      homeRoot: root,
    });
    try {
      const { sessionId, result } = await openSession(client);
      const initial = modelOption(result["configOptions"]);
      expect(initial.category).toBe("model");
      expect(initial.type).toBe("select");
      expect(initial.currentValue).toBe("fixture/fixture-a");
      expect(initial.options.map((option) => option.value)).toEqual(["fixture/fixture-a", "fixture/fixture-b"]);

      expect((await prompt(client, sessionId, "one")).text).toBe("ran on fixture-a.");

      // session/set_config_option: the complete, updated list comes back.
      const setId = client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/fixture-b" });
      const set = await client.waitFor((m) => m.id === setId, "the set_config_option reply");
      expect(set.error).toBeUndefined();
      expect(modelOption(set.result?.["configOptions"]).currentValue).toBe("fixture/fixture-b");
      expect((await prompt(client, sessionId, "two")).text).toBe("ran on fixture-b.");

      // An unknown value is refused, with the reason and the choices.
      const badId = client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/nope" });
      const bad = await client.waitFor((m) => m.id === badId, "the refused set_config_option reply");
      expect(bad.error?.message).toContain('"fixture/nope" is not a model this session can run');
      expect(bad.error?.message).toContain("fixture/fixture-a");

      // A switch while a turn runs: the turn keeps the model it started with.
      const before = client.messages().length;
      const runningId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "three" }] });
      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
      const midId = client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/fixture-a" });
      const mid = await client.waitFor((m) => m.id === midId, "the mid-turn set_config_option reply");
      expect(modelOption(mid.result?.["configOptions"]).currentValue).toBe("fixture/fixture-a");
      client.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.rejectOnce } } });
      await client.waitFor((m) => m.id === runningId, "the running turn's reply");
      expect(agentTextSince(client, before)).toBe("still on fixture-b.");

      // ...and the next turn runs the model chosen meanwhile.
      expect((await prompt(client, sessionId, "four")).text).toBe("ran on fixture-a.");

      // /model <value>: switched, announced with config_option_update, not sent to the model.
      const switched = await prompt(client, sessionId, "/model fixture-b");
      expect(switched.text).toContain("fixture/fixture-b");
      const pushed = client.updates("config_option_update").at(-1);
      expect(modelOption((pushed?.params?.["update"] as { configOptions?: unknown }).configOptions).currentValue).toBe(
        "fixture/fixture-b",
      );
      expect((await prompt(client, sessionId, "five")).text).toBe("ran on fixture-b.");
    } finally {
      await client.kill();
    }
  }, 60_000);
});
