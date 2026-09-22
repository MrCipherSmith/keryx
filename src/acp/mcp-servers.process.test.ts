// Client-supplied MCP servers over a REAL stdio pipe (flow 287, AC3–AC7), and
// provider resolution with no `--fixture` (AC1/AC2).
//
// The built CLI (`src/cli.ts acp`) is driven as Zed drives it: `session/new`
// carries the client's own `mcpServers`, one of which is a real stdio MCP
// server from this repository (`fixtures/mcp-servers/echo-server.ts`) that
// keryx spawns itself. No network: the model is the `--fixture` scripted
// provider, the MCP server is a local process, and the one http entry is
// refused before any socket.
//
// Every wait is on a wire event (a frame, the process exiting, stderr reaching
// EOF) — never a timer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFqn } from "../mcp-servers/catalog";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { AcpProcessClient, type WireMessage } from "./process-client.test-helpers";
import { ACP_PROTOCOL_VERSION } from "./protocol";

const TIMEOUT_MS = 60_000;
const ECHO_SERVER = path.join(import.meta.dir, "..", "..", "fixtures", "mcp-servers", "echo-server.ts");
const ECHO_FQN = buildFqn("echo", "echo");
/** What `executeCall` returns when the operator says no — the local denial, verbatim. */
const LOCAL_DENIAL = "command not approved by the user; not executed";

let root = "";
let projectDir = "";
let dataDir = "";
let pidFile = "";
let sentinel = "";
let headerSentinel = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-mcp-")));
  projectDir = path.join(root, "project");
  dataDir = path.join(root, "data");
  for (const dir of [projectDir, dataDir, path.join(root, "home")]) mkdirSync(dir, { recursive: true });
  pidFile = path.join(root, "echo-server.pid.json");
  const nonce = Math.random().toString(36).slice(2);
  sentinel = `ghp_KERYX_SENTINEL_${nonce}`;
  headerSentinel = `sk-KERYX-HEADER-SENTINEL-${nonce}`;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Everything the subprocess could write outside the sandbox is pointed back into it. */
function sandboxEnv(): Record<string, string> {
  const home = path.join(root, "home");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  };
}

type FixtureRound = readonly Record<string, unknown>[];

function toolRound(id: string, toolName: string, input: unknown): FixtureRound {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) },
    { kind: "model_end" },
  ];
}

function textRound(text: string): FixtureRound {
  return [{ kind: "text_delta", text }, { kind: "model_end" }];
}

function writeFixture(rounds: readonly FixtureRound[]): string {
  const file = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ turns: rounds }), "utf8");
  return file;
}

/** The echo server entry, exactly in the shape an ACP client sends it — its secret in `env`. */
function echoEntry(extraEnv: readonly { name: string; value: string }[] = []): Record<string, unknown> {
  return {
    name: "echo",
    command: process.execPath,
    args: [ECHO_SERVER],
    env: [
      { name: "ECHO_SERVER_PROBE", value: sentinel },
      { name: "ECHO_SERVER_PID_FILE", value: pidFile },
      ...extraEnv,
    ],
  };
}

async function initialize(client: AcpProcessClient): Promise<void> {
  const id = client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "mcp-servers-process-test", version: "0" },
  });
  const reply = await client.waitFor((m) => m.id === id, "the initialize reply");
  expect(reply.error).toBeUndefined();
}

async function newSession(client: AcpProcessClient, mcpServers: readonly unknown[]): Promise<string> {
  const id = client.request("session/new", { cwd: projectDir, mcpServers });
  const reply = await client.waitFor((m) => m.id === id, "the session/new reply");
  expect(reply.error).toBeUndefined();
  const sessionId = (reply.result as { sessionId?: string } | undefined)?.sessionId;
  if (typeof sessionId !== "string") throw new Error(`no sessionId: ${JSON.stringify(reply)}`);
  return sessionId;
}

/**
 * Runs one `session/prompt`, answering every `session/request_permission` it
 * raises with `decide(ask)`, until the prompt's own reply arrives.
 */
async function driveTurn(
  client: AcpProcessClient,
  sessionId: string,
  decide: (ask: WireMessage) => string,
): Promise<{ reply: WireMessage; asks: WireMessage[] }> {
  const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
  const answered = new Set<string | number>();
  const asks: WireMessage[] = [];
  for (;;) {
    const next = await client.waitFor(
      (m) =>
        (m.id === promptId && m.method === undefined) ||
        (m.method === "session/request_permission" && m.id !== undefined && m.id !== null && !answered.has(m.id)),
      "a permission ask or the session/prompt reply",
    );
    if (next.method === undefined) return { reply: next, asks };
    answered.add(next.id as string | number);
    asks.push(next);
    client.send({ id: next.id, result: { outcome: { outcome: "selected", optionId: decide(next) } } });
  }
}

type Update = { sessionUpdate?: string; toolCallId?: string; name?: string; status?: string; rawOutput?: unknown; content?: { text?: string } };
const updateOf = (m: WireMessage): Update => (m.params?.["update"] ?? {}) as Update;
const askedTool = (ask: WireMessage): { name?: string; toolCallId?: string } =>
  (ask.params?.["toolCall"] ?? {}) as { name?: string; toolCallId?: string };

/** Tool-call announcements and closing updates for one tool name. */
function callsOf(client: AcpProcessClient, name: string): { announced: Update[]; closed: Update[] } {
  const announced = client.updates("tool_call").map(updateOf).filter((u) => u.name === name);
  const ids = new Set(announced.map((u) => u.toolCallId));
  const closed = client.updates("tool_call_update").map(updateOf).filter((u) => ids.has(u.toolCallId));
  return { announced, closed };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...filesUnder(full));
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

describe("AC3/AC5/AC6/AC7 — a client's stdio MCP server, end to end over the real pipe", () => {
  test("started with its env, tool offered, asked, run on allow; failures reported by name; secrets nowhere; process gone after close", async () => {
    const fixture = writeFixture([
      toolRound("s1", "search_tool", { query: "echo" }),
      toolRound("u1", "use_tool", { tool_name: ECHO_FQN, tool_input: { text: "hello-from-mcp" } }),
      textRound("done."),
    ]);
    const client = new AcpProcessClient({ fixture, cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const sessionId = await newSession(client, [
        echoEntry(),
        // AC5: a server that cannot start — its env carries the secret too.
        { name: "broken", command: path.join(root, "no-such-server"), args: [], env: [{ name: "API_KEY", value: sentinel }] },
        // AC5: a transport keryx does not advertise — with a secret header.
        { type: "http", name: "remote", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: `Bearer ${headerSentinel}` }] },
      ]);

      // AC5: both problems reach the client, each by name with its reason.
      const reportFor = (name: string) =>
        client.waitFor(
          (m) =>
            m.method === "session/update" &&
            updateOf(m).sessionUpdate === "agent_message_chunk" &&
            (updateOf(m).content?.text ?? "").includes(`"${name}"`),
          `the start-up report for ${name}`,
        );
      expect(updateOf(await reportFor("remote")).content?.text).toContain("not started");
      expect(updateOf(await reportFor("broken")).content?.text).toContain("failed to start: ENOENT");

      const { reply, asks } = await driveTurn(client, sessionId, () => ACP_PERMISSION_OPTION_IDS.allowOnce);
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      // AC7: its tool is offered — search_tool finds it by keryx's qualified name.
      const search = callsOf(client, "search_tool");
      expect(search.closed).toHaveLength(1);
      expect(String(search.closed[0]?.rawOutput)).toContain(ECHO_FQN);

      // AC4/AC7: the call was ASKED, and every ask for it names the call the client was shown.
      const use = callsOf(client, "use_tool");
      expect(use.announced).toHaveLength(1);
      const useAsks = asks.filter((ask) => askedTool(ask).name === "use_tool");
      // Two: search_tool's result is third-party text (`untrusted`), so the
      // taint gate asks first, then use_tool's own `destructive` risk asks.
      expect(useAsks).toHaveLength(2);
      for (const ask of useAsks) expect(askedTool(ask).toolCallId).toBe(use.announced[0]?.toolCallId);
      // T13 finding 6: every `use_tool` call shares one title, so a client
      // remembering "always" by title would approve EVERY tool of every client
      // server. It is never offered: `use_tool` is `destructive`, which is
      // escalated (`permissionIsEscalated`).
      for (const ask of useAsks) {
        const optionIds = ((ask.params?.["options"] ?? []) as { optionId: string }[]).map((o) => o.optionId);
        expect(optionIds).not.toContain(ACP_PERMISSION_OPTION_IDS.allowAlways);
      }
      // …and on allow it ran, returning the server's answer.
      expect(use.closed).toHaveLength(1);
      expect(use.closed[0]?.status).toBe("completed");
      expect(String(use.closed[0]?.rawOutput)).toContain("hello-from-mcp");

      // AC3: started with its env — the child saw the value (hashed, never written in clear).
      const started = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; probeSha256: string };
      expect(started.probeSha256).toBe(createHash("sha256").update(sentinel).digest("hex"));
      expect(isAlive(started.pid)).toBe(true);

      // AC3: the client goes away; keryx stops the server before it exits.
      await client.end();
      expect(isAlive(started.pid)).toBe(false);

      // AC6: the secrets appear in no artifact — stdout frames, stderr, and
      // every file the run left anywhere in the sandbox (session records,
      // transcripts, logs, config).
      await client.stderrClosed();
      const stderr = client.stderrText();
      expect(stderr).toContain('"broken"');
      const artifacts: [string, string][] = [
        ["stdout", client.transcript()],
        ["stderr", stderr],
        ...filesUnder(root).map((file): [string, string] => [file, readFileSync(file, "utf8")]),
      ];
      expect(artifacts.length).toBeGreaterThan(3);
      // The session transcript is among them — the check is not vacuous.
      expect(artifacts.some(([, text]) => text.includes("hello-from-mcp") && text.includes(ECHO_FQN))).toBe(true);
      const leaks = artifacts
        .filter(([, text]) => text.includes(sentinel) || text.includes(headerSentinel))
        .map(([where]) => where);
      expect(leaks).toEqual([]);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("AC4: a denied call does not run and ends exactly as a local denial does", async () => {
    const fixture = writeFixture([
      toolRound("u1", "use_tool", { tool_name: ECHO_FQN, tool_input: { text: "must-not-run" } }),
      textRound("ok."),
    ]);
    const client = new AcpProcessClient({ fixture, cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const sessionId = await newSession(client, [echoEntry()]);
      const { reply, asks } = await driveTurn(client, sessionId, () => ACP_PERMISSION_OPTION_IDS.rejectOnce);
      expect(reply.result).toEqual({ stopReason: "end_turn" });
      expect(asks.map((ask) => askedTool(ask).name)).toEqual(["use_tool"]);
      const use = callsOf(client, "use_tool");
      expect(use.closed).toHaveLength(1);
      expect(use.closed[0]?.status).toBe("failed");
      expect(String(use.closed[0]?.rawOutput)).toBe(LOCAL_DENIAL);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("session/load starts the list it carries, and closing the connection stops it", async () => {
    const fixture = writeFixture([toolRound("s1", "search_tool", { query: "echo" }), textRound("found.")]);
    const client = new AcpProcessClient({ fixture, cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const sessionId = await newSession(client, []);
      const loadId = client.request("session/load", { sessionId, cwd: projectDir, mcpServers: [echoEntry()] });
      const loaded = await client.waitFor((m) => m.id === loadId, "the session/load reply");
      expect(loaded.error).toBeUndefined();

      await driveTurn(client, sessionId, () => ACP_PERMISSION_OPTION_IDS.allowOnce);
      expect(String(callsOf(client, "search_tool").closed[0]?.rawOutput)).toContain(ECHO_FQN);

      const { pid } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number };
      await client.end();
      expect(isAlive(pid)).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});

describe("untrusted MCP output, then a gated local call (approve-before-announce, now reachable over ACP)", () => {
  // `use_tool`'s result is `untrusted: true`, which latches the turn's taint
  // gate: the NEXT non-read call is asked BEFORE `onToolCall` announces it
  // (`commands/agent.ts`), then asked again by its own risk branch. Flow 285
  // made `agent-io.ts` announce such a call once and let the later
  // `onToolCall` adopt it; that path had no live caller over ACP until client
  // MCP servers existed. These pin it over the real pipe.
  const rounds = (marker: string): FixtureRound[] => [
    toolRound("u1", "use_tool", { tool_name: ECHO_FQN, tool_input: { text: "tainting" } }),
    toolRound("x1", "shell_exec", { command: `touch ${marker}` }),
    textRound("done."),
  ];

  test("on allow: ONE announcement for the gated call, every ask names it, its result closes it, and it ran", async () => {
    const marker = path.join(projectDir, "ran-after-mcp");
    const client = new AcpProcessClient({ fixture: writeFixture(rounds(marker)), cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const sessionId = await newSession(client, [echoEntry()]);
      const { reply, asks } = await driveTurn(client, sessionId, () => ACP_PERMISSION_OPTION_IDS.allowOnce);
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      const shell = callsOf(client, "shell_exec");
      expect(shell.announced).toHaveLength(1);
      const id = shell.announced[0]?.toolCallId;
      const shellAsks = asks.filter((ask) => askedTool(ask).name === "shell_exec");
      // Two asks — the taint gate's, then the shell risk branch's — both on the one id.
      expect(shellAsks).toHaveLength(2);
      for (const ask of shellAsks) expect(askedTool(ask).toolCallId).toBe(id);
      expect(shell.closed).toHaveLength(1);
      expect(shell.closed[0]?.toolCallId).toBe(id);
      expect(shell.closed[0]?.status).toBe("completed");
      expect(existsSync(marker)).toBe(true);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("on deny: the same single id is closed as failed, and the command did not run", async () => {
    const marker = path.join(projectDir, "must-not-exist");
    const client = new AcpProcessClient({ fixture: writeFixture(rounds(marker)), cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const sessionId = await newSession(client, [echoEntry()]);
      const { reply, asks } = await driveTurn(client, sessionId, (ask) =>
        askedTool(ask).name === "shell_exec" ? ACP_PERMISSION_OPTION_IDS.rejectOnce : ACP_PERMISSION_OPTION_IDS.allowOnce,
      );
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      const shell = callsOf(client, "shell_exec");
      expect(shell.announced).toHaveLength(1);
      const id = shell.announced[0]?.toolCallId;
      const shellAsks = asks.filter((ask) => askedTool(ask).name === "shell_exec");
      expect(shellAsks).toHaveLength(1);
      expect(askedTool(shellAsks[0]!).toolCallId).toBe(id);
      expect(shell.closed).toHaveLength(1);
      expect(shell.closed[0]?.toolCallId).toBe(id);
      expect(shell.closed[0]?.status).toBe("failed");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});

describe("AC1/AC2 — provider resolution with no --fixture", () => {
  test("nothing configured: initialize answers, session/new and session/load are refused naming the remedy, stderr says it once", async () => {
    const client = new AcpProcessClient({ cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const newId = client.request("session/new", { cwd: projectDir, mcpServers: [] });
      const refusedNew = await client.waitFor((m) => m.id === newId, "the session/new refusal");
      expect(refusedNew.result).toBeUndefined();
      expect(refusedNew.error?.message).toContain("no provider is configured");
      expect(refusedNew.error?.message).toContain("keryx shell");
      expect(refusedNew.error?.message).toContain("--provider <name> --model <model>");

      const loadId = client.request("session/load", { sessionId: "whatever", cwd: projectDir, mcpServers: [] });
      const refusedLoad = await client.waitFor((m) => m.id === loadId, "the session/load refusal");
      expect(refusedLoad.error?.message).toBe(refusedNew.error?.message);

      await client.end();
      await client.stderrClosed();
      const startupLines = client
        .stderrText()
        .split("\n")
        .filter((line) => line.startsWith("keryx acp: no provider is configured"));
      expect(startupLines).toHaveLength(1);
      // Stdout stayed frames-only throughout.
      for (const message of client.messages()) expect(message.jsonrpc).toBe("2.0");
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("keryx shell's saved selection is used with no flags: session/new is accepted", async () => {
    // `XDG_DATA_HOME` is `root`, so this IS the config keryx shell would read.
    mkdirSync(path.join(root, "keryx"), { recursive: true });
    writeFileSync(path.join(root, "keryx", "auth.json"), JSON.stringify({ provider: "ollama", model: "qwen3:8b" }));
    const client = new AcpProcessClient({ cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      await newSession(client, []);
      await client.end();
      await client.stderrClosed();
      expect(client.stderrText()).not.toContain("no provider is configured");
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});

describe("T13 — a server that only a signal stops (ECHO_SERVER_IGNORE_EOF=1)", () => {
  const stubborn = () => echoEntry([{ name: "ECHO_SERVER_IGNORE_EOF", value: "1" }]);

  /** Starts keryx with the stubborn server and waits until it is connected (search_tool finds it). */
  async function startWithStubbornServer(): Promise<{ client: AcpProcessClient; pid: number }> {
    const fixture = writeFixture([toolRound("s1", "search_tool", { query: "echo" }), textRound("found.")]);
    const client = new AcpProcessClient({ fixture, cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    await initialize(client);
    const sessionId = await newSession(client, [stubborn()]);
    await driveTurn(client, sessionId, () => ACP_PERMISSION_OPTION_IDS.allowOnce);
    expect(String(callsOf(client, "search_tool").closed[0]?.rawOutput)).toContain(ECHO_FQN);
    const { pid } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number };
    expect(isAlive(pid)).toBe(true);
    return { client, pid };
  }

  test("stdin closes: keryx stops it (EOF is not enough) before exiting", async () => {
    const { client, pid } = await startWithStubbornServer();
    try {
      await client.end();
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("SIGTERM to keryx: it stops the server, then exits 143", async () => {
    const { client, pid } = await startWithStubbornServer();
    try {
      client.signal("SIGTERM");
      const code = await client.exited();
      expect(code).toBe(143);
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
      await client.kill();
    }
  }, TIMEOUT_MS);
});

describe("T13 — AC6 against a server that echoes its own credential", () => {
  test("the leaked value is redacted in the tool result, and appears in no artifact", async () => {
    const fixture = writeFixture([
      toolRound("u1", "use_tool", { tool_name: ECHO_FQN, tool_input: { text: "hi" } }),
      textRound("done."),
    ]);
    const client = new AcpProcessClient({ fixture, cwd: projectDir, dataDir, homeRoot: root, env: sandboxEnv() });
    try {
      await initialize(client);
      const sessionId = await newSession(client, [echoEntry([{ name: "ECHO_SERVER_LEAK_PROBE", value: "1" }])]);
      const { reply } = await driveTurn(client, sessionId, () => ACP_PERMISSION_OPTION_IDS.allowOnce);
      expect(reply.result).toEqual({ stopReason: "end_turn" });
      const use = callsOf(client, "use_tool");
      // The server DID answer with its credential; keryx replaced it.
      expect(String(use.closed[0]?.rawOutput)).toContain("hi probe=<redacted>");
      await client.end();
      await client.stderrClosed();
      const artifacts: [string, string][] = [
        ["stdout", client.transcript()],
        ["stderr", client.stderrText()],
        ...filesUnder(root).map((file): [string, string] => [file, readFileSync(file, "utf8")]),
      ];
      expect(artifacts.filter(([, text]) => text.includes(sentinel)).map(([where]) => where)).toEqual([]);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});
