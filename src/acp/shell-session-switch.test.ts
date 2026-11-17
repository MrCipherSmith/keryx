// `keryx acp --profile shell` holds one active session per connection
// (specification §3.8; PR #1213 review highload-w3 F-001, highload-w5
// F-001/F-002): when `session/new` or `session/load` switches the connection
// to another session, the previous one is released — its lease goes back so
// `keryx shell --resume` can open it, and its shell tasks are swept. The
// editor profile keeps every session until the connection ends, as before.
//
// Also the roster cache (performance-w5 F-001/F-002): a session's shell roster
// is built once and reused by later turns and `/status`.
//
// Round 3 (PR #1213 r03): the switch is applied last, so a shared client MCP
// set is reused and a failed or overtaken switch leaves the previous session
// held; a switch during a running turn waits for it; a session's mode survives
// a switch away and back; and the connection's end sweeps tasks and still
// persists the turns a shutdown aborted.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerConnection } from "../mcp-client/client";
import { mergeCatalogs } from "../mcp-servers/catalog";
import type { ConnectFn } from "../mcp-servers/manager";
import type { McpRuntime } from "../mcp-servers/runtime";
import { createSession, listSessions, persistHistory } from "../session";
import { openLeasedSession, releaseSessionLease, sessionLeaseState } from "../session/lease";
import { ACP_CLIENT_METHODS } from "./protocol";
import { buildAcpShellSessionTools, type AcpShellRosterInput } from "./shell-roster";
import { driveTurn, shellHarness, textRound, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;

const dataDirOf = (h: ShellHarness): string => path.join(h.projectDir, "data");

const leaseStateOf = (h: ShellHarness, sessionId: string): string => sessionLeaseState(h.projectDir, sessionId, dataDirOf(h)).state;

/** A stored session with one turn, as `keryx shell` would leave it. */
function storedSession(h: ShellHarness): string {
  const handle = createSession({ cwd: h.projectDir, provider: "test", model: "test-model", dataDir: dataDirOf(h) });
  persistHistory(
    handle,
    [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ],
    { provider: "test", model: "test-model" },
  );
  return handle.summary.id;
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function load(h: ShellHarness, sessionId: string): Promise<void> {
  const id = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [] });
  const reply = await h.waitFor((f) => f.id === id);
  expect(reply.error).toBeUndefined();
}

/** Starts a background shell task in `sessionId` and returns its pid. */
async function startTask(h: ShellHarness, sessionId: string, pidFile: string): Promise<number> {
  const { reply } = await driveTurn(h, sessionId, "start a watcher");
  expect(reply.error).toBeUndefined();
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, "the task's pid file");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(isAlive(pid)).toBe(true);
  return pid;
}

const pidPath = (): string => path.join(mkdtempSync(path.join(tmpdir(), "keryx-acp-switch-")), "task.pid");

const taskRounds = (pidFile: string) => [
  toolRound("t1", "shell_exec", { command: `echo $$ > ${pidFile}; exec sleep 60`, background: true }),
  textRound("started"),
];

describe("shell profile — one active session per connection", () => {
  test("session/load of B releases A: A's lease is free, A's task is swept, A is no longer served", async () => {
    const pidFile = pidPath();
    const h = shellHarness({ rounds: taskRounds(pidFile) });
    let pid = 0;
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      expect(leaseStateOf(h, a)).toBe("mine");
      pid = await startTask(h, a, pidFile);

      const b = storedSession(h);
      await load(h, b);

      expect(leaseStateOf(h, a)).toBe("free");
      expect(leaseStateOf(h, b)).toBe("mine");
      await until(() => !isAlive(pid), "A's task to be swept");
      // A second holder can open A now (`keryx shell --resume` would).
      const reopened = openLeasedSession({ cwd: h.projectDir, resumeId: a, dataDir: dataDirOf(h) });
      releaseSessionLease(reopened.lease);

      // A is no longer this connection's: a prompt on it is an unknown session.
      const promptId = h.prompt(a, "hello");
      expect((await h.waitFor((f) => f.id === promptId)).error?.message).toContain("Unknown ACP session");
      // Loading A again leases it afresh and releases B.
      await load(h, a);
      expect(leaseStateOf(h, a)).toBe("mine");
      expect(leaseStateOf(h, b)).toBe("free");
    } finally {
      if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
      await h.end();
    }
  }, TIMEOUT_MS);

  test("session/new of B releases A the same way", async () => {
    const pidFile = pidPath();
    const h = shellHarness({ rounds: taskRounds(pidFile) });
    let pid = 0;
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      pid = await startTask(h, a, pidFile);
      const b = (await h.newSession()).sessionId;
      expect(leaseStateOf(h, a)).toBe("free");
      expect(leaseStateOf(h, b)).toBe("mine");
      await until(() => !isAlive(pid), "A's task to be swept");
    } finally {
      if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
      await h.end();
    }
  }, TIMEOUT_MS);

  test("re-loading the active session keeps it, and the connection's end releases the last one", async () => {
    const h = shellHarness({ storedMode: "trust" });
    let a: string;
    try {
      await h.initialize();
      a = (await h.newSession()).sessionId;
      await load(h, a);
      expect(leaseStateOf(h, a)).toBe("mine");
      const promptId = h.prompt(a, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    } finally {
      await h.end();
    }
    expect(leaseStateOf(h, a)).toBe("free");
  }, TIMEOUT_MS);

  test("editor profile is unchanged: both sessions stay held and served until the connection ends", async () => {
    const h = shellHarness({ profile: "editor", rounds: [textRound("one"), textRound("two")] });
    let a: string;
    let b: string;
    try {
      await h.initialize();
      a = (await h.newSession()).sessionId;
      b = (await h.newSession()).sessionId;
      expect(leaseStateOf(h, a)).toBe("mine");
      expect(leaseStateOf(h, b)).toBe("mine");
      expect((await driveTurn(h, a, "first")).reply.error).toBeUndefined();
      expect((await driveTurn(h, b, "second")).reply.error).toBeUndefined();
    } finally {
      await h.end();
    }
    expect(leaseStateOf(h, a)).toBe("free");
    expect(leaseStateOf(h, b)).toBe("free");
  }, TIMEOUT_MS);
});

describe("shell profile — the roster is built once per session", () => {
  test("two prompts build one roster; /status reuses it, and before any prompt builds no MCP-bound roster", async () => {
    const builds: AcpShellRosterInput[] = [];
    const h = shellHarness({
      rounds: [textRound("one"), textRound("two")],
      serverOptions: {
        buildShellRoster: (input) => {
          builds.push(input);
          return buildAcpShellSessionTools(input);
        },
      },
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();

      // /status first: names only, nothing cached for the turns.
      const statusId = h.prompt(sessionId, "/status");
      expect((await h.waitFor((f) => f.id === statusId)).error).toBeUndefined();
      expect(builds.length).toBe(1);

      expect((await driveTurn(h, sessionId, "first")).reply.error).toBeUndefined();
      expect((await driveTurn(h, sessionId, "second")).reply.error).toBeUndefined();
      // One build for /status's names, one for the turns — not one per turn.
      expect(builds.length).toBe(2);
      // /status's build and the turns' build were given the root's one adapter.
      expect(builds[1]?.metaprojectPort).toBe(builds[0]?.metaprojectPort);

      const again = h.prompt(sessionId, "/status");
      expect((await h.waitFor((f) => f.id === again)).error).toBeUndefined();
      expect(builds.length).toBe(2);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a session/load with different client MCP servers rebuilds it; one adapter serves the root across sessions", async () => {
    const builds: AcpShellRosterInput[] = [];
    const h = shellHarness({
      rounds: [textRound("one"), textRound("unchanged"), textRound("two"), textRound("three")],
      serverOptions: {
        buildShellRoster: (input) => {
          builds.push(input);
          return buildAcpShellSessionTools(input);
        },
        // A client server that never starts: the binding changes, the dial fails fast.
        mcpConnect: async () => {
          throw new Error("not in this test");
        },
      },
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      expect((await driveTurn(h, sessionId, "first")).reply.error).toBeUndefined();
      expect(builds.length).toBe(1);

      // A load that changes nothing keeps the cached roster (testing-practices-w2 TPF-007).
      await load(h, sessionId);
      expect((await driveTurn(h, sessionId, "unchanged")).reply.error).toBeUndefined();
      expect(builds.length).toBe(1);

      const loadId = h.request("session/load", {
        sessionId,
        cwd: h.projectDir,
        mcpServers: [{ name: "probe", command: "/bin/true", args: [], env: [] }],
      });
      expect((await h.waitFor((f) => f.id === loadId)).error).toBeUndefined();
      expect((await driveTurn(h, sessionId, "second")).reply.error).toBeUndefined();
      expect(builds.length).toBe(2);

      const other = (await h.newSession()).sessionId;
      expect((await driveTurn(h, other, "third")).reply.error).toBeUndefined();
      expect(builds.length).toBe(3);
      expect(builds[2]?.metaprojectPort).toBe(builds[0]?.metaprojectPort);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

/** Sends a prompt and waits for the turn's first permission question, unanswered. */
async function promptUntilAsked(
  h: ShellHarness,
  sessionId: string,
  text: string,
): Promise<{ promptId: number; ask: { id?: string | number | null } }> {
  const start = h.frames.length;
  const promptId = h.prompt(sessionId, text);
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission && h.frames.indexOf(f) >= start);
  return { promptId, ask };
}

/** The stored sessions of the harness's project other than `known`. */
function otherSessionIds(h: ShellHarness, known: readonly string[]): string[] {
  return listSessions(h.projectDir, dataDirOf(h))
    .map((summary) => summary.id)
    .filter((id) => !known.includes(id));
}

/** A client MCP dial that never spawns, counting dials and closes. */
function countingConnect(): { connect: ConnectFn; dials: () => number; closes: () => number } {
  let dials = 0;
  let closes = 0;
  const connect: ConnectFn = async () => {
    dials += 1;
    return {
      listTools: async () => [],
      callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
      close: async () => {
        closes += 1;
      },
    } as unknown as McpServerConnection;
  };
  return { connect, dials: () => dials, closes: () => closes };
}

const probe = [{ name: "probe", command: "probe-bin", args: [], env: [] }];

async function newSessionWith(h: ShellHarness, mcpServers: unknown[]): Promise<string> {
  const id = h.request("session/new", { cwd: h.projectDir, mcpServers });
  const reply = await h.waitFor((f) => f.id === id);
  expect(reply.error).toBeUndefined();
  return reply.result?.["sessionId"] as string;
}

describe("shell profile — the switch is applied last (PR #1213 r03)", () => {
  test("the same client MCP list on the next session reuses the running set; switching away from it closes it", async () => {
    const dial = countingConnect();
    const h = shellHarness({ serverOptions: { mcpConnect: dial.connect } });
    try {
      await h.initialize();
      const a = await newSessionWith(h, probe);
      await until(() => dial.dials() === 1, "the probe dial");
      const b = await newSessionWith(h, probe);
      expect(leaseStateOf(h, a)).toBe("free");
      expect(leaseStateOf(h, b)).toBe("mine");
      // Bound by B before A was released: one dial, never closed.
      expect(dial.dials()).toBe(1);
      expect(dial.closes()).toBe(0);

      await newSessionWith(h, []);
      // B was the set's last holder: switching away from it stops the server.
      await until(() => dial.closes() === 1, "the probe set to close");
      expect(dial.dials()).toBe(1);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a session/new that fails after creating its session leaves the previous one held and active", async () => {
    let failNext = false;
    const h = shellHarness({
      serverOptions: {
        // Thrown by the new session's hook set-up (its run id), after `registry.create`.
        idSeq: () => {
          if (failNext) {
            failNext = false;
            throw new Error("injected failure");
          }
          return randomUUID();
        },
      },
    });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      failNext = true;
      const failedId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
      expect((await h.waitFor((f) => f.id === failedId)).error).toBeDefined();

      expect(leaseStateOf(h, a)).toBe("mine");
      const [failed] = otherSessionIds(h, [a]);
      expect(failed).toBeDefined();
      await until(() => leaseStateOf(h, failed as string) === "free", "the failed session to be given back");
      // A is still the connection's: it is served.
      const promptId = h.prompt(a, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("overlapping switches: the overtaken one is refused and given back, the last one is the only one held", async () => {
    const h = shellHarness({
      serverOptions: {
        // Every session waits this long for a model list that never comes, so
        // the two switches below are both in flight at once.
        models: { choices: () => new Promise(() => {}), bind: async () => "unused" },
        modelListTimeoutMs: 200,
      },
    });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      const b = storedSession(h);
      const loadId = h.request("session/load", { sessionId: b, cwd: h.projectDir, mcpServers: [] });
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });

      const loaded = await h.waitFor((f) => f.id === loadId);
      expect(loaded.error?.data?.["condition"]).toBe("session-superseded");
      const created = await h.waitFor((f) => f.id === newId);
      expect(created.error).toBeUndefined();
      const c = created.result?.["sessionId"] as string;
      // The refused load announced nothing after its (error) reply.
      expect(
        h.frames.some((f) => f.params?.sessionId === b && f.params?.update?.sessionUpdate === "available_commands_update"),
      ).toBe(false);

      await until(() => leaseStateOf(h, a) === "free" && leaseStateOf(h, b) === "free", "A and B to be released");
      expect(leaseStateOf(h, c)).toBe("mine");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a switch during a running turn holds the previous session until that turn ends, then releases it", async () => {
    const h = shellHarness({ rounds: [toolRound("t1", "shell_exec", { command: "true" }), textRound("done")] });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      const { promptId, ask } = await promptUntilAsked(h, a, "run something");

      const b = (await h.newSession()).sessionId;
      expect(leaseStateOf(h, b)).toBe("mine");
      // A's turn is still running: A stays held so the turn can persist.
      expect(leaseStateOf(h, a)).toBe("mine");

      h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
      const reply = await h.waitFor((f) => f.id === promptId);
      expect(reply.error).toBeUndefined();
      await until(() => leaseStateOf(h, a) === "free", "A to be released after its turn");
      expect(leaseStateOf(h, b)).toBe("mine");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("A → B → A keeps A's permission mode (degradation-w1 DEG-R2-001)", async () => {
    const h = shellHarness({ storedMode: "trust" });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      const setId = h.request("session/set_mode", { sessionId: a, modeId: "ask" });
      expect((await h.waitFor((f) => f.id === setId)).error).toBeUndefined();

      const b = await h.newSession();
      expect((b.result["modes"] as { currentModeId: string }).currentModeId).toBe("trust");

      const loadId = h.request("session/load", { sessionId: a, cwd: h.projectDir, mcpServers: [] });
      const loaded = await h.waitFor((f) => f.id === loadId);
      expect((loaded.result?.["modes"] as { currentModeId: string }).currentModeId).toBe("ask");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("shell profile — /status and keryx's MCP runtime (architecture-w3 ARCH-R3-001, testing-practices-w1 TPF-006)", () => {
  test("/status before the first turn starts no runtime yet reports the MCP pair; the turn starts it once", async () => {
    const builds: AcpShellRosterInput[] = [];
    let starts = 0;
    const runtime: McpRuntime = {
      catalog: () => mergeCatalogs([]),
      servers: () => [],
      toolTimeoutSec: () => undefined,
      problems: () => [],
      configured: () => [],
      ready: async () => {},
      connectServer: async () => ({ ok: true }),
      disconnectServer: async () => ({ ok: true }),
      close: async () => {},
    };
    const h = shellHarness({
      rounds: [textRound("one")],
      serverOptions: {
        keryxMcp: {
          configured: () => true,
          start: () => {
            starts += 1;
            return runtime;
          },
        },
        buildShellRoster: (input) => {
          builds.push(input);
          return buildAcpShellSessionTools(input);
        },
      },
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const statusId = h.prompt(sessionId, "/status");
      expect((await h.waitFor((f) => f.id === statusId)).error).toBeUndefined();
      expect(starts).toBe(0);
      expect(builds[0]?.mcp).toBeDefined();
      const statusText = h.frames
        .filter((f) => f.params?.sessionId === sessionId && f.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((f) => f.params?.update?.content?.text ?? "")
        .join("");
      expect(statusText).toContain("use_tool");

      expect((await driveTurn(h, sessionId, "first")).reply.error).toBeUndefined();
      expect(starts).toBe(1);
      expect(builds[1]?.mcp).toBeDefined();
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

describe("shell profile — the connection's end", () => {
  test("ending the connection kills a session's running background task (round-1 TP-207)", async () => {
    const pidFile = pidPath();
    const h = shellHarness({ rounds: taskRounds(pidFile) });
    let pid = 0;
    let a: string;
    try {
      await h.initialize();
      a = (await h.newSession()).sessionId;
      pid = await startTask(h, a, pidFile);
    } finally {
      await h.end();
    }
    try {
      await until(() => !isAlive(pid), "the task to be killed at the connection's end");
      expect(leaseStateOf(h, a)).toBe("free");
    } finally {
      if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, TIMEOUT_MS);

  test("a shutdown still persists the turn it aborted, and does not answer it as a lost lease (logic-w8 LOGIC-W8-001)", async () => {
    const shutdown = new AbortController();
    const h = shellHarness({
      rounds: [toolRound("t1", "shell_exec", { command: "true" }), textRound("never reached")],
      serverOptions: { shutdown: shutdown.signal },
    });
    let a: string;
    try {
      await h.initialize();
      a = (await h.newSession()).sessionId;
      const { promptId } = await promptUntilAsked(h, a, "persist me");
      shutdown.abort();
      await h.done;
      const reply = await h.waitFor((f) => f.id === promptId);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.["stopReason"]).toBe("cancelled");
    } finally {
      await h.end();
    }
    expect(leaseStateOf(h, a)).toBe("free");
    const reopened = openLeasedSession({ cwd: h.projectDir, resumeId: a, dataDir: dataDirOf(h) });
    try {
      expect(reopened.history.some((message) => message.role === "user" && message.content.includes("persist me"))).toBe(true);
    } finally {
      releaseSessionLease(reopened.lease);
    }
  }, TIMEOUT_MS);
});
