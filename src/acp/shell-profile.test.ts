// `keryx acp --profile shell` (Keryx Desktop Client M1, specification §3 —
// AC1, AC4, AC5, AC6, AC7; AC3 is `shell-profile-modes.test.ts`).
//
// AC1  the roster is `buildInteractiveAgentTools`' output, with spawn_subagent
//      only when the host gave it one (a desktop session always has one)
// AC4  plan, usage_update, session_info_update and current_mode_update are sent
// AC5  `_keryx/ask_user` round trip; every non-answer is a declined question;
//      the tool is not offered to a client that did not advertise it
// AC6  initialize reports the real version and the profiles; `_keryx/info` answers
// AC7  an untrusted result, then a gated call, over the real pipe in this
//      profile: one ask under the id the client was shown; nothing runs on deny
//
// AC1/AC4/AC5 drive `runAcpServer` in-process with a scripted provider; AC6 and
// AC7 drive the real `keryx acp --profile shell` subprocess.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { buildInteractiveAgentTools } from "../commands/interactive-agent-tools";
import { createDefaultSearchProviderController } from "../harness/search";
import { createJobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { buildFqn } from "../mcp-servers/catalog";
import { ACP_TOOL_KIND_OTHER_EXCEPTIONS, toolKindFor } from "./agent-io";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { AcpProcessClient, type WireMessage } from "./process-client.test-helpers";
import { ACP_PROTOCOL_VERSION } from "./protocol";
import { ACP_SHELL_NO_SPAWN_DENIED_TOOLS, buildAcpShellSessionTools } from "./shell-roster";
import { callsOf, driveTurn, isUpdate, shellHarness, textRound, toolRound, updateOf, updates } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// AC1 — the roster
// ---------------------------------------------------------------------------

describe("AC1 — the shell profile's roster is keryx shell's factory", () => {
  const spawnStub: InteractiveTool = {
    definition: { name: "spawn_subagent", description: "stub", inputSchema: { type: "object" }, risk: "delegate" },
    invoke: async () => ({ output: "", isError: true }),
  };
  const emptyMcp = { catalog: () => ({ entries: [], skipped: [] }), servers: () => [] };

  function rosters(withAskUser: boolean, withSpawn = false): { acp: InteractiveTool[]; factory: InteractiveTool[] } {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-shell-roster-")));
    mkdirSync(path.join(root, ".metaproject"));
    writeFileSync(path.join(root, ".metaproject", "metaproject.json"), "{}", "utf8");
    const shared = {
      searchController: createDefaultSearchProviderController(),
      jobRegistry: createJobRegistry({ cwd: root }),
      getSessionDir: () => undefined,
      mcp: emptyMcp,
    };
    const askUser = async (): Promise<string> => "a";
    const acp = buildAcpShellSessionTools({
      root,
      clientCapabilities: undefined,
      readViaClient: async () => undefined,
      ...shared,
      ...(withAskUser ? { askUser } : {}),
      ...(withSpawn ? { spawnTool: spawnStub } : {}),
    });
    const factory = buildInteractiveAgentTools({
      cwd: root,
      metaprojectPort: createMetaprojectAdapter(root),
      spawnTool: spawnStub,
      askUser,
      ...shared,
    });
    return { acp, factory };
  }

  const names = (tools: readonly InteractiveTool[]): string[] => tools.map((tool) => tool.definition.name).sort();

  test("with ask_user advertised and no spawn tool: every factory tool but spawn_subagent, with identical definitions", () => {
    const { acp, factory } = rosters(true);
    const expected = factory.filter((tool) => !ACP_SHELL_NO_SPAWN_DENIED_TOOLS.includes(tool.definition.name));
    expect(names(acp)).toEqual(names(expected));
    const byName = (tools: readonly InteractiveTool[]) => Object.fromEntries(tools.map((tool) => [tool.definition.name, tool.definition]));
    expect(byName(acp)).toEqual(byName(expected));
    // The tools the PRD names as what the editor profile lacked are here.
    for (const name of ["web_fetch", "web_search", "ask_user", "plan_set", "shell_task_output", "search_tool", "use_tool"]) {
      expect(names(acp)).toContain(name);
    }
  });

  test("without ask_user advertised: ask_user is denied too; spawn, bus and scheduling tools never appear", () => {
    const { acp, factory } = rosters(false);
    const expected = factory.filter((tool) => ![...ACP_SHELL_NO_SPAWN_DENIED_TOOLS, "ask_user"].includes(tool.definition.name));
    expect(names(acp)).toEqual(names(expected));
    expect(names(acp).filter((name) => name === "spawn_subagent" || name.startsWith("bus_") || name.startsWith("schedule_"))).toEqual([]);
  });

  test("with a spawn tool: the roster is the whole factory, spawn_subagent included", () => {
    const { acp, factory } = rosters(true, true);
    expect(names(acp)).toEqual(names(factory));
    expect(acp.find((tool) => tool.definition.name === "spawn_subagent")).toBe(spawnStub);
  });

  test("every shell-profile tool renders with a real ACP kind", () => {
    const unmapped = names(rosters(true).acp).filter(
      (name) => toolKindFor(name) === "other" && !ACP_TOOL_KIND_OTHER_EXCEPTIONS.has(name),
    );
    expect(unmapped).toEqual([]);
  });

  test("over the wire, /status lists the same roster the session's turns run with — spawn_subagent included", async () => {
    const h = shellHarness({ clientCapabilities: { _meta: { keryx: { askUser: true } } } });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const id = h.prompt(sessionId, "/status");
      await h.waitFor((f) => f.id === id);
      const status = updates(h.frames, "agent_message_chunk").map((u) => u.content?.text ?? "").join("");
      expect(status).toContain("Permission mode: ask");
      // Regression (flow 495 report): without spawn_subagent, every orchestrator skill a
      // top-level desktop session loads answers `STATUS: BLOCKED nested_dispatch_unavailable`.
      for (const name of ["web_fetch", "ask_user", "plan_set", "shell_task_output", "spawn_subagent"]) expect(status).toContain(name);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("spawn_subagent in a top-level desktop session (flow 495 report)", () => {
  test("a turn dispatches a child on the session's provider and gets its result back", async () => {
    const h = shellHarness({
      clientCapabilities: { _meta: { keryx: { askUser: true } } },
      rounds: [
        toolRound("s1", "spawn_subagent", { task: "Say which file holds the answer.", mode: "read_only", label: "probe" }),
        textRound("child: the answer is in README.md"),
        textRound("parent done"),
      ],
      // A provider keryx knows: routing refuses a child on an unknown one ("test").
      serverOptions: { providerId: "ollama", modelId: "fake" },
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { reply } = await driveTurn(h, sessionId, "delegate it");
      expect(reply.result?.["stopReason"]).toBe("end_turn");
      const spawn = callsOf(h.frames, "spawn_subagent");
      expect(spawn.announced.length).toBe(1);
      const closing = spawn.updates.find((u) => u.status === "completed" || u.status === "failed");
      const output = JSON.stringify(closing?.rawOutput ?? closing ?? "");
      expect(output).not.toContain("not available");
      expect(closing?.status).toBe("completed");
      expect(output).toContain("README.md");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// AC4 — the shell profile's session updates
// ---------------------------------------------------------------------------

describe("AC4 — plan, usage_update, session_info_update, current_mode_update", () => {
  test("a turn that publishes a plan sends the plan, usage after every model call, and the new title", async () => {
    const h = shellHarness({
      rounds: [
        toolRound(
          "p1",
          "plan_set",
          {
            expectedRevision: 0,
            items: [
              { id: "a", title: "Read the code", status: "completed" },
              { id: "b", title: "Write the fix", status: "in_progress" },
              { id: "c", title: "Run the tests", status: "pending" },
            ],
          },
          { inputTokens: 100, outputTokens: 10 },
        ),
        textRound("planned", { inputTokens: 150, outputTokens: 5 }),
      ],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const { reply } = await driveTurn(h, sessionId, "Fix the flaky login test");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      const plans = updates(h.frames, "plan");
      expect(plans).toHaveLength(1);
      expect((plans[0]?.["entries"] as { content: string; status: string; priority: string }[]).map(({ content, status, priority }) => ({ content, status, priority }))).toEqual([
        { content: "Read the code", status: "completed", priority: "medium" },
        { content: "Write the fix", status: "in_progress", priority: "medium" },
        { content: "Run the tests", status: "pending", priority: "medium" },
      ]);

      const usage = updates(h.frames, "usage_update");
      expect(usage).toHaveLength(2);
      expect(usage[0]?.["used"]).toBe(110);
      expect(typeof usage[0]?.["size"]).toBe("number");
      expect(usage[1]?._meta?.keryx).toEqual({
        call: { inputTokens: 150, outputTokens: 5 },
        turn: { inputTokens: 250, outputTokens: 15 },
        session: { inputTokens: 250, outputTokens: 15 },
      });

      const titles = updates(h.frames, "session_info_update").map((u) => u["title"]);
      expect(titles[0]).toBe("New session");
      expect(String(titles.at(-1))).toContain("Fix the flaky login test");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("session/load re-sends the stored plan; session totals carry across turns", async () => {
    const h = shellHarness({
      rounds: [
        toolRound("p1", "plan_set", { expectedRevision: 0, items: [{ id: "a", title: "Only step", status: "pending" }] }, { inputTokens: 10, outputTokens: 1 }),
        textRound("one", { inputTokens: 20, outputTokens: 2 }),
        textRound("two", { inputTokens: 30, outputTokens: 3 }),
      ],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      await driveTurn(h, sessionId, "first");
      await driveTurn(h, sessionId, "second");
      expect(updates(h.frames, "usage_update").at(-1)?._meta?.keryx?.["session"]).toEqual({ inputTokens: 60, outputTokens: 6 });

      const before = updates(h.frames, "plan").length;
      const loadId = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [] });
      await h.waitFor((f) => f.id === loadId);
      const resent = await h.waitFor((f) => isUpdate("plan")(f) && h.frames.indexOf(f) > h.frames.findIndex((g) => g.id === loadId));
      expect(updates(h.frames, "plan").length).toBe(before + 1);
      expect((updateOf(resent)["entries"] as { content: string }[])[0]?.content).toBe("Only step");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("current_mode_update follows session/set_mode", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      h.request("session/set_mode", { sessionId, modeId: "trust" });
      expect(updateOf(await h.waitFor(isUpdate("current_mode_update")))["currentModeId"]).toBe("trust");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("the editor profile sends none of them", async () => {
    const h = shellHarness({
      profile: "editor",
      rounds: [textRound("hi", { inputTokens: 1, outputTokens: 1 })],
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      await driveTurn(h, sessionId, "hello");
      for (const kind of ["plan", "usage_update", "session_info_update", "current_mode_update"]) {
        expect(updates(h.frames, kind)).toEqual([]);
      }
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// AC5 — `_keryx/ask_user`
// ---------------------------------------------------------------------------

describe("AC5 — _keryx/ask_user", () => {
  const ASK = {
    question: "Which colour?",
    options: [
      { id: "r", label: "Red", description: "warm" },
      { id: "b", label: "Blue", description: "cool", recommended: true },
    ],
    recommendationReason: "calm",
  };
  const ASK_CAPS = { _meta: { keryx: { askUser: true } } };

  async function askOnce(answer: (h: ReturnType<typeof shellHarness>, ask: { id?: unknown }) => void): Promise<{ ask: WireMessage; output: string; h: ReturnType<typeof shellHarness> }> {
    const h = shellHarness({ clientCapabilities: ASK_CAPS, rounds: [toolRound("q1", "ask_user", ASK), textRound("ok")] });
    await h.initialize();
    const { sessionId } = await h.newSession();
    const promptId = h.prompt(sessionId, "ask me");
    const ask = await h.waitFor((f) => f.method === "_keryx/ask_user");
    answer(h, ask);
    await h.waitFor((f) => f.id === promptId);
    const closed = callsOf(h.frames, "ask_user").updates.at(-1);
    return { ask: ask as WireMessage, output: String(closed?.rawOutput), h };
  }

  test("the request carries the spec's shape, and an answered label picks that option", async () => {
    const { ask, output, h } = await askOnce((h, a) => h.respond(a.id as string, { result: { outcome: "answered", answers: ["Blue"] } }));
    try {
      expect(ask.params).toMatchObject({
        question: "Which colour?",
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cool" },
        ],
        multiSelect: false,
      });
      expect(typeof ask.params?.["sessionId"]).toBe("string");
      expect(output).toContain('User selected id="b"');
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("free text that is no label is the person's own answer", async () => {
    const { output, h } = await askOnce((h, a) => h.respond(a.id as string, { result: { outcome: "answered", answers: ["Green, please"] } }));
    try {
      expect(output).toContain("OWN answer");
      expect(output).toContain("Green, please");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("cancelled is a declined question", async () => {
    const { output, h } = await askOnce((h, a) => h.respond(a.id as string, { result: { outcome: "cancelled" } }));
    try {
      expect(output).toContain("cancelled");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a transport error is a declined question", async () => {
    const { output, h } = await askOnce((h, a) => h.respond(a.id as string, { error: { code: -32601, message: "no such method" } }));
    try {
      expect(output).toContain("cancelled");
      expect(h.stderr.join("\n")).toContain("_keryx/ask_user");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("session/cancel settles a pending question as declined", async () => {
    const h = shellHarness({ clientCapabilities: ASK_CAPS, rounds: [toolRound("q1", "ask_user", ASK), textRound("ok")] });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const promptId = h.prompt(sessionId, "ask me");
      await h.waitFor((f) => f.method === "_keryx/ask_user");
      h.notify("session/cancel", { sessionId });
      expect((await h.waitFor((f) => f.id === promptId)).result).toEqual({ stopReason: "cancelled" });
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("without the capability the tool is not offered and nothing is ever sent", async () => {
    const h = shellHarness({ rounds: [toolRound("q1", "ask_user", ASK), textRound("ok")] });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      await driveTurn(h, sessionId, "ask me");
      expect(h.frames.some((f) => f.method === "_keryx/ask_user")).toBe(false);
      // The model asked for a tool it was not given: the call fails, nobody is asked.
      expect(callsOf(h.frames, "ask_user").updates.at(-1)?.status).toBe("failed");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// AC6 / AC7 — the real subprocess
// ---------------------------------------------------------------------------

const ECHO_SERVER = path.join(import.meta.dir, "..", "..", "fixtures", "mcp-servers", "echo-server.ts");
const ECHO_FQN = buildFqn("echo", "echo");

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-shell-profile-")));
  projectDir = path.join(root, "project");
  dataDir = path.join(root, "data");
  for (const dir of [projectDir, dataDir, path.join(root, "home")]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Everything the subprocess could read or write outside the sandbox — keryx's own MCP config included — points back into it. */
function sandboxEnv(): Record<string, string> {
  const home = path.join(root, "home");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  };
}

function writeFixture(rounds: readonly (readonly Record<string, unknown>[])[]): string {
  const file = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ turns: rounds }), "utf8");
  return file;
}

function client(profile: string | undefined, fixture?: string): AcpProcessClient {
  return new AcpProcessClient({
    fixture: fixture ?? writeFixture([]),
    cwd: projectDir,
    dataDir,
    homeRoot: root,
    env: sandboxEnv(),
    ...(profile !== undefined ? { extraArgs: ["--profile", profile] } : {}),
  });
}

async function initialize(c: AcpProcessClient, clientCapabilities: Record<string, unknown> = {}): Promise<WireMessage> {
  const id = c.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities });
  return c.waitFor((m) => m.id === id, "the initialize reply");
}

describe("AC6 — initialize reports the real version and the profiles; _keryx/info answers", () => {
  test("shell profile: agentInfo.version is the package version, _meta.keryx names profile, profiles and extensions", async () => {
    const c = client("shell");
    try {
      const reply = await initialize(c);
      const result = reply.result as { agentInfo: { version: string }; _meta: { keryx: Record<string, unknown> } };
      expect(result.agentInfo.version).toBe(packageJson.version);
      expect(result._meta.keryx).toEqual({
        profile: "shell",
        profiles: ["editor", "shell"],
        extensions: [
          "_keryx/info",
          "_keryx/ask_user",
          "_keryx/session_released",
          "_keryx/session_shown",
          "_keryx/session_flags",
          "_keryx/session_trash",
        ],
        liveSessions: true,
      });
      const infoId = c.request("_keryx/info", {});
      const info = await c.waitFor((m) => m.id === infoId, "the _keryx/info reply");
      expect(info.result).toEqual({ version: packageJson.version, ...result._meta.keryx });
    } finally {
      await c.kill();
    }
  }, TIMEOUT_MS);

  test("editor profile (the default): initialize has no _meta, and _keryx/info still answers", async () => {
    const c = client(undefined);
    try {
      const reply = await initialize(c);
      expect(reply.result?.["_meta"]).toBeUndefined();
      expect((reply.result?.["agentInfo"] as { version: string }).version).toBe(packageJson.version);
      const infoId = c.request("_keryx/info", {});
      const info = await c.waitFor((m) => m.id === infoId, "the _keryx/info reply");
      expect(info.result).toEqual({
        version: packageJson.version,
        profile: "editor",
        profiles: ["editor", "shell"],
        extensions: ["_keryx/info"],
      });
    } finally {
      await c.kill();
    }
  }, TIMEOUT_MS);

  test("an unknown profile is a usage error: exit 2, named on stderr, nothing on stdout", async () => {
    const c = client("desktop");
    try {
      expect(await c.exited()).toBe(2);
      await c.stderrClosed();
      expect(c.stderrText()).toContain('unknown --profile "desktop"');
      expect(c.messages()).toEqual([]);
    } finally {
      await c.kill();
    }
  }, TIMEOUT_MS);
});

describe("AC7 — an untrusted result, then a gated call, in the shell profile over the real pipe", () => {
  // `use_tool`'s result is `untrusted: true` — the same flag `web_fetch` and
  // `web_search` set — which latches the turn's taint gate: the next gated call
  // asks with `untrustedOrigin`, BEFORE it is announced by the batch loop. The
  // client MCP server reaches the turn through the shell profile's merged
  // keryx + client MCP binding.
  const echoEntry = (): Record<string, unknown> => ({ name: "echo", command: process.execPath, args: [ECHO_SERVER], env: [] });
  const rounds = (marker: string) => [
    toolRound("u1", "use_tool", { tool_name: ECHO_FQN, tool_input: { text: "tainting" } }),
    toolRound("x1", "shell_exec", { command: `touch ${marker}` }),
    textRound("done."),
  ];

  async function run(marker: string, mode: string, decide: (ask: WireMessage) => string) {
    const c = client("shell", writeFixture(rounds(marker)));
    await initialize(c);
    const newId = c.request("session/new", { cwd: projectDir, mcpServers: [echoEntry()] });
    const created = await c.waitFor((m) => m.id === newId, "the session/new reply");
    const sessionId = created.result?.["sessionId"] as string;
    if (mode !== "ask") {
      const setId = c.request("session/set_mode", { sessionId, modeId: mode });
      await c.waitFor((m) => m.id === setId, "the session/set_mode reply");
    }
    const promptId = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    const answered = new Set<unknown>();
    const asks: WireMessage[] = [];
    for (;;) {
      const next = await c.waitFor(
        (m) => (m.id === promptId && m.method === undefined) || (m.method === "session/request_permission" && !answered.has(m.id)),
        "a permission ask or the prompt reply",
      );
      if (next.method === undefined) break;
      answered.add(next.id);
      asks.push(next);
      c.send({ id: next.id, result: { outcome: { outcome: "selected", optionId: decide(next) } } });
    }
    const shellAnnounced = c
      .updates("tool_call")
      .map((m) => m.params?.["update"] as { name?: string; toolCallId?: string })
      .filter((u) => u.name === "shell_exec");
    const shellAsks = asks.filter((ask) => (ask.params?.["toolCall"] as { name?: string }).name === "shell_exec");
    return { c, shellAnnounced, shellAsks };
  }

  test("trust mode does not lift the floor: the call is asked once, on its announced id, without allow_always; deny runs nothing", async () => {
    const marker = path.join(projectDir, "must-not-exist");
    const { c, shellAnnounced, shellAsks } = await run(marker, "trust", (ask) =>
      (ask.params?.["toolCall"] as { name?: string }).name === "shell_exec" ? ACP_PERMISSION_OPTION_IDS.rejectOnce : ACP_PERMISSION_OPTION_IDS.allowOnce,
    );
    try {
      expect(shellAnnounced).toHaveLength(1);
      expect(shellAsks).toHaveLength(1);
      expect((shellAsks[0]?.params?.["toolCall"] as { toolCallId?: string }).toolCallId).toBe(shellAnnounced[0]?.toolCallId);
      const optionIds = ((shellAsks[0]?.params?.["options"] ?? []) as { optionId: string }[]).map((o) => o.optionId);
      expect(optionIds).not.toContain(ACP_PERMISSION_OPTION_IDS.allowAlways);
      // The ask says why it is asked (security-code-w7 SEC-W7R3-001).
      const toolCallMeta = (shellAsks[0]?.params?.["toolCall"] as { _meta?: { keryx?: { reasons?: Record<string, unknown> } } })._meta;
      expect(toolCallMeta?.keryx?.reasons?.["untrustedOrigin"]).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await c.kill();
    }
  }, TIMEOUT_MS);

  test("on allow the same single id runs and is closed", async () => {
    const marker = path.join(projectDir, "ran-after-mcp");
    const { c, shellAnnounced, shellAsks } = await run(marker, "ask", () => ACP_PERMISSION_OPTION_IDS.allowOnce);
    try {
      expect(shellAnnounced).toHaveLength(1);
      expect(shellAsks).toHaveLength(1);
      const closed = c
        .updates("tool_call_update")
        .map((m) => m.params?.["update"] as { toolCallId?: string; status?: string })
        .filter((u) => u.toolCallId === shellAnnounced[0]?.toolCallId && u.status === "completed");
      expect(closed).toHaveLength(1);
      expect(existsSync(marker)).toBe(true);
    } finally {
      await c.kill();
    }
  }, TIMEOUT_MS);
});
