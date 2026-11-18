// `keryx acp --profile shell` holds live sessions (PR #1213 r04, owner
// decision on review ui-ux-w3 UX-W3-R3-002): a `session/new` or `session/load`
// adds a session beside the ones the connection holds and releases none — a
// turn, a shell task or an MCP set in another session keeps running. Memory is
// bounded by an idle cap: past MAX_HELD_SESSIONS the least recently used idle
// session is released and the client is told with `_keryx/session_released`.
// A held session's re-load rebuilds nothing. The editor profile keeps every
// session until the connection ends, as before.
//
// Also the roster cache (performance-w5 F-001/F-002): a session's shell roster
// is built once and reused by later turns and `/status`; and the connection's
// end sweeps tasks and still persists the turns a shutdown aborted.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerConnection } from "../mcp-client/client";
import { mergeCatalogs } from "../mcp-servers/catalog";
import type { ConnectFn } from "../mcp-servers/manager";
import type { McpRuntime } from "../mcp-servers/runtime";
import { createSession, listSessions, persistHistory } from "../session";
import { openLeasedSession, releaseSessionLease, sessionLeaseState } from "../session/lease";
import { loadAcpFixtureProvider } from "./fixture-provider";
import { acpModelChoice, type AcpModelSource } from "./models";
import { KERYX_ACP_EXTENSION_METHODS } from "./profile";
import { ACP_CLIENT_METHODS } from "./protocol";
import { IDLE_CAP_RELEASE_REASON, MAX_HELD_SESSIONS } from "./server";
import type { Frame } from "./server-harness.test-helpers";
import { buildAcpShellSessionTools, type AcpShellRosterInput } from "./shell-roster";
import { driveTurn, shellHarness, textRound, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;

const SESSION_RELEASED = KERYX_ACP_EXTENSION_METHODS.sessionReleased;

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

describe("shell profile — live sessions: opening a session releases none (PR #1213 r04)", () => {
  test("two sessions are held at once; a turn keeps running in A while B is opened, prompted and another is loaded", async () => {
    const h = shellHarness({
      rounds: [toolRound("t1", "shell_exec", { command: "true" }), textRound("b answer"), textRound("a done")],
    });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      const { promptId, ask } = await promptUntilAsked(h, a, "run something");
      expect(ask.params?.sessionId).toBe(a);

      const b = (await h.newSession()).sessionId;
      const c = storedSession(h);
      await load(h, c);
      expect(leaseStateOf(h, a)).toBe("mine");
      expect(leaseStateOf(h, b)).toBe("mine");
      expect(leaseStateOf(h, c)).toBe("mine");

      // B is served while A's turn waits on its question.
      const bStart = h.frames.length;
      expect((await driveTurn(h, b, "hello")).reply.error).toBeUndefined();
      const bText = h.frames
        .slice(bStart)
        .filter((f) => f.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((f) => ({ sessionId: f.params?.sessionId, text: f.params?.update?.content?.text }));
      expect(bText).toContainEqual({ sessionId: b, text: "b answer" });

      // A's turn was never cancelled: answered, it runs to its end.
      h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
      const reply = await h.waitFor((f) => f.id === promptId);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.["stopReason"]).toBe("end_turn");
      expect(
        h.frames.some(
          (f) => f.params?.sessionId === a && f.params?.update?.sessionUpdate === "agent_message_chunk" && f.params.update.content?.text === "a done",
        ),
      ).toBe(true);
      expect(h.frames.some((f) => f.method === SESSION_RELEASED)).toBe(false);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("A's shell task survives a session/new and a session/load of other sessions", async () => {
    const pidFile = pidPath();
    const h = shellHarness({ rounds: taskRounds(pidFile) });
    let pid = 0;
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      pid = await startTask(h, a, pidFile);

      await h.newSession();
      await load(h, storedSession(h));
      // A release starts synchronously (the lease goes back and the notification is written before
      // the reply), so by the time the load replied there is nothing left to wait for.
      expect(h.frames.some((f) => f.method === SESSION_RELEASED)).toBe(false);
      expect(isAlive(pid)).toBe(true);
      expect(leaseStateOf(h, a)).toBe("mine");
      const promptId = h.prompt(a, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    } finally {
      await h.end();
      if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, TIMEOUT_MS);

  test("a session/load of a held session with a running turn is refused as busy", async () => {
    const h = shellHarness({ rounds: [toolRound("t1", "shell_exec", { command: "true" }), textRound("done")] });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      const { promptId, ask } = await promptUntilAsked(h, a, "run something");
      const loadId = h.request("session/load", { sessionId: a, cwd: h.projectDir, mcpServers: [] });
      expect((await h.waitFor((f) => f.id === loadId)).error?.data?.["condition"]).toBe("session-busy");
      h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
      expect(leaseStateOf(h, a)).toBe("mine");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("re-loading a held session keeps it, and the connection's end releases every held one", async () => {
    const h = shellHarness({ storedMode: "trust" });
    let a: string;
    let b: string;
    try {
      await h.initialize();
      a = (await h.newSession()).sessionId;
      b = (await h.newSession()).sessionId;
      await load(h, a);
      expect(leaseStateOf(h, a)).toBe("mine");
      const promptId = h.prompt(a, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    } finally {
      await h.end();
    }
    expect(leaseStateOf(h, a)).toBe("free");
    expect(leaseStateOf(h, b)).toBe("free");
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

  test("re-loading a held session rebuilds nothing: mode, roster and MCP stay, a new mcpServers list is not started, the transcript is replayed", async () => {
    const builds: AcpShellRosterInput[] = [];
    const dial = countingConnect();
    const h = shellHarness({
      storedMode: "trust",
      rounds: [textRound("one"), textRound("two"), textRound("three")],
      serverOptions: {
        buildShellRoster: (input) => {
          builds.push(input);
          return buildAcpShellSessionTools(input);
        },
        mcpConnect: dial.connect,
      },
    });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const setId = h.request("session/set_mode", { sessionId, modeId: "ask" });
      expect((await h.waitFor((f) => f.id === setId)).error).toBeUndefined();
      expect((await driveTurn(h, sessionId, "first question")).reply.error).toBeUndefined();
      expect(builds.length).toBe(1);

      const start = h.frames.length;
      const loadId = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: probe });
      const loaded = await h.waitFor((f) => f.id === loadId);
      expect(loaded.error).toBeUndefined();
      expect((loaded.result?.["modes"] as { currentModeId: string }).currentModeId).toBe("ask");
      // The held transcript is replayed before the reply.
      const replayed = h.frames
        .slice(start, h.frames.indexOf(loaded))
        .filter((f) => f.params?.sessionId === sessionId && f.params?.update?.sessionUpdate === "user_message_chunk")
        .map((f) => f.params?.update?.content?.text);
      expect(replayed).toContain("first question");

      expect((await driveTurn(h, sessionId, "second")).reply.error).toBeUndefined();
      expect(builds.length).toBe(1);
      expect(dial.dials()).toBe(0);

      const other = (await h.newSession()).sessionId;
      expect((await driveTurn(h, other, "third")).reply.error).toBeUndefined();
      expect(builds.length).toBe(2);
      expect(builds[1]?.metaprojectPort).toBe(builds[0]?.metaprojectPort);
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
): Promise<{ promptId: number; ask: Frame }> {
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

describe("shell profile — opening and failing (PR #1213 r04)", () => {
  test("the same client MCP list on two sessions runs one set; both stay held; the connection's end closes it", async () => {
    const dial = countingConnect();
    const h = shellHarness({ serverOptions: { mcpConnect: dial.connect } });
    try {
      await h.initialize();
      const a = await newSessionWith(h, probe);
      await until(() => dial.dials() === 1, "the probe dial");
      const b = await newSessionWith(h, probe);
      expect(leaseStateOf(h, a)).toBe("mine");
      expect(leaseStateOf(h, b)).toBe("mine");
      expect(dial.dials()).toBe(1);
      expect(dial.closes()).toBe(0);
    } finally {
      await h.end();
    }
    expect(dial.closes()).toBe(1);
  }, TIMEOUT_MS);

  test("a session/new that fails after creating its session gives back only that session", async () => {
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
      const promptId = h.prompt(a, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a second session/load of a session still being opened is refused; the first one opens it (testing-practices-w2 TPF-R3-004)", async () => {
    const h = shellHarness({
      serverOptions: {
        // The first load waits this long for a model list that never comes, so the second arrives while it is open.
        models: { choices: () => new Promise(() => {}), bind: async () => "unused" },
        modelListTimeoutMs: 200,
      },
    });
    try {
      await h.initialize();
      const b = storedSession(h);
      const firstId = h.request("session/load", { sessionId: b, cwd: h.projectDir, mcpServers: [] });
      const secondId = h.request("session/load", { sessionId: b, cwd: h.projectDir, mcpServers: [] });
      expect((await h.waitFor((f) => f.id === secondId)).error?.data?.["condition"]).toBe("session-opening");
      expect((await h.waitFor((f) => f.id === firstId)).error).toBeUndefined();
      expect(leaseStateOf(h, b)).toBe("mine");
      const promptId = h.prompt(b, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("session/prompt, set_mode and set_config_option for a session still being opened are refused as session-opening (logic-w13 LOGIC-R4-001)", async () => {
    const h = shellHarness({
      serverOptions: {
        models: { choices: () => new Promise(() => {}), bind: async () => "unused" },
        modelListTimeoutMs: 200,
      },
    });
    try {
      await h.initialize();
      const b = storedSession(h);
      const loadId = h.request("session/load", { sessionId: b, cwd: h.projectDir, mcpServers: [] });
      const promptId = h.prompt(b, "/mode");
      const modeId = h.request("session/set_mode", { sessionId: b, modeId: "trust" });
      const configId = h.request("session/set_config_option", { sessionId: b, configId: "model", value: "test-model" });
      for (const id of [promptId, modeId, configId]) {
        expect((await h.waitFor((f) => f.id === id)).error?.data?.["condition"]).toBe("session-opening");
      }
      expect((await h.waitFor((f) => f.id === loadId)).error).toBeUndefined();
      expect(leaseStateOf(h, b)).toBe("mine");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a shutdown during session/new refuses the rest of it and starts no MCP set (logic-w11 LOGIC-W11R3-002)", async () => {
    const shutdown = new AbortController();
    const dial = countingConnect();
    let stopAtNextId = false;
    const h = shellHarness({
      serverOptions: {
        shutdown: shutdown.signal,
        mcpConnect: dial.connect,
        // The new session's hook set-up takes a run id before its first await: stop there.
        idSeq: () => {
          if (stopAtNextId) {
            stopAtNextId = false;
            shutdown.abort();
          }
          return randomUUID();
        },
      },
    });
    try {
      await h.initialize();
      stopAtNextId = true;
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: probe });
      const reply = await h.waitFor((f) => f.id === newId);
      expect(reply.error?.data?.["condition"]).toBe("shutting-down");
      await h.done;
      expect(dial.dials()).toBe(0);
      const [opened] = otherSessionIds(h, []);
      expect(opened).toBeDefined();
      expect(leaseStateOf(h, opened as string)).toBe("free");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});

const LAUNCH = "test/test-model";
const SLOW = acpModelChoice("test", "slow");

/** A model source whose `slow` provider is built only when its `/model` is cancelled: `/model` holds the turn slot. */
function slowModelSource(): { source: AcpModelSource; binds: () => number } {
  let binds = 0;
  const source: AcpModelSource = {
    choices: async () => [SLOW],
    bind: (_choice, signal) => {
      binds += 1;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  };
  return { source, binds: () => binds };
}

/** Holds `sessionId` busy with a `/model` that waits; returns the prompt id. */
async function holdBusy(h: ShellHarness, sessionId: string, binds: () => number): Promise<number> {
  const before = binds();
  const promptId = h.prompt(sessionId, `/model ${SLOW.value}`);
  await until(() => binds() > before, "the /model bind to start");
  return promptId;
}

const releasedFrames = (h: ShellHarness): { sessionId: string | undefined; reason: string | undefined }[] =>
  h.frames
    .filter((f) => f.method === SESSION_RELEASED)
    .map((f) => {
      const params = f.params as { sessionId?: string; reason?: string } | undefined;
      return { sessionId: params?.sessionId, reason: params?.reason };
    });

describe(`shell profile — the idle cap of ${MAX_HELD_SESSIONS} held sessions (PR #1213 r04)`, () => {
  test("past the cap the least recently used idle session is released, the client is told, and a load brings it back", async () => {
    const slow = slowModelSource();
    const h = shellHarness({ serverOptions: { models: slow.source } });
    try {
      await h.initialize();
      const sessions: string[] = [];
      for (let i = 0; i < MAX_HELD_SESSIONS; i += 1) sessions.push((await h.newSession()).sessionId);
      const [busy, oldestIdle, nextIdle] = sessions as [string, string, string];
      // The oldest session is busy; the next one is used again, so it is no longer the least recent.
      const busyPrompt = await holdBusy(h, busy, slow.binds);
      const touchId = h.prompt(oldestIdle, "/mode");
      expect((await h.waitFor((f) => f.id === touchId)).error).toBeUndefined();
      expect(releasedFrames(h)).toEqual([]);

      const ninth = (await h.newSession()).sessionId;
      expect(releasedFrames(h)).toEqual([{ sessionId: nextIdle, reason: IDLE_CAP_RELEASE_REASON }]);
      expect(leaseStateOf(h, nextIdle)).toBe("free");
      for (const kept of [busy, oldestIdle, ninth, ...sessions.slice(3)]) expect(leaseStateOf(h, kept)).toBe("mine");
      const promptId = h.prompt(nextIdle, "/mode");
      expect((await h.waitFor((f) => f.id === promptId)).error?.message).toContain("Unknown ACP session");

      // A return to it loads it again, which releases the next least recently used idle one.
      await load(h, nextIdle);
      expect(leaseStateOf(h, nextIdle)).toBe("mine");
      expect(releasedFrames(h)).toEqual([
        { sessionId: nextIdle, reason: IDLE_CAP_RELEASE_REASON },
        { sessionId: sessions[3], reason: IDLE_CAP_RELEASE_REASON },
      ]);

      h.notify("session/cancel", { sessionId: busy });
      expect((await h.waitFor((f) => f.id === busyPrompt)).result?.["stopReason"]).toBe("cancelled");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("_keryx/session_shown counts as use: the shown session is kept and the next least recent one is released (highload-w1 HL-R4-002)", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const sessions: string[] = [];
      for (let i = 0; i < MAX_HELD_SESSIONS; i += 1) sessions.push((await h.newSession()).sessionId);
      const [oldest, second] = sessions as [string, string];
      // An unknown id is ignored, and the notification has no reply.
      h.notify(KERYX_ACP_EXTENSION_METHODS.sessionShown, { sessionId: "not-held" });
      h.notify(KERYX_ACP_EXTENSION_METHODS.sessionShown, { sessionId: oldest });
      const ninth = (await h.newSession()).sessionId;
      expect(releasedFrames(h)).toEqual([{ sessionId: second, reason: IDLE_CAP_RELEASE_REASON }]);
      expect(leaseStateOf(h, oldest)).toBe("mine");
      expect(leaseStateOf(h, ninth)).toBe("mine");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("when every held session is busy, none is released and the new one still opens", async () => {
    const slow = slowModelSource();
    const h = shellHarness({ serverOptions: { models: slow.source } });
    try {
      await h.initialize();
      const sessions: string[] = [];
      const prompts: number[] = [];
      for (let i = 0; i < MAX_HELD_SESSIONS; i += 1) {
        const sessionId = (await h.newSession()).sessionId;
        sessions.push(sessionId);
        prompts.push(await holdBusy(h, sessionId, slow.binds));
      }
      const ninth = (await h.newSession()).sessionId;
      expect(releasedFrames(h)).toEqual([]);
      for (const held of [...sessions, ninth]) expect(leaseStateOf(h, held)).toBe("mine");

      for (const sessionId of sessions) h.notify("session/cancel", { sessionId });
      for (const promptId of prompts) await h.waitFor((f) => f.id === promptId);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("a session with a running shell task is not released", async () => {
    const pidFile = pidPath();
    const h = shellHarness({ rounds: taskRounds(pidFile) });
    let pid = 0;
    try {
      await h.initialize();
      const withTask = (await h.newSession()).sessionId;
      pid = await startTask(h, withTask, pidFile);
      const others: string[] = [];
      for (let i = 0; i < MAX_HELD_SESSIONS; i += 1) others.push((await h.newSession()).sessionId);
      // `withTask` is the least recently used, but busy: the next one goes.
      expect(releasedFrames(h)).toEqual([{ sessionId: others[0], reason: IDLE_CAP_RELEASE_REASON }]);
      expect(leaseStateOf(h, withTask)).toBe("mine");
      expect(isAlive(pid)).toBe(true);
    } finally {
      await h.end();
      if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, TIMEOUT_MS);

  test("a reload after a release restores mode, model and usage; later switches still apply (testing-practices-w2 TPF-R3-003, logic-w7 LOGIC-W7-R3-001)", async () => {
    const m2 = acpModelChoice("test", "m2");
    let binds = 0;
    const fixture = path.join(mkdtempSync(path.join(tmpdir(), "keryx-acp-m2-")), "fixture.json");
    writeFileSync(fixture, JSON.stringify({ turns: [] }), "utf8");
    const h = shellHarness({
      storedMode: "trust",
      rounds: [textRound("one", { inputTokens: 10, outputTokens: 5 }), textRound("two", { inputTokens: 1, outputTokens: 1 })],
      serverOptions: {
        models: {
          choices: async () => [m2],
          bind: async (choice) => {
            binds += 1;
            return { provider: loadAcpFixtureProvider(fixture), providerId: choice.providerId, modelId: choice.modelId, turnSettings: {} };
          },
        },
      },
    });
    const sessionTally = (sessionId: string): unknown =>
      h.frames
        .filter((f) => f.params?.sessionId === sessionId && f.params?.update?.sessionUpdate === "usage_update")
        .map((f) => (f.params?.update as { _meta?: { keryx?: { session?: unknown } } })._meta?.keryx?.session)
        .at(-1);
    const setModel = async (sessionId: string, value: string): Promise<unknown> => {
      const id = h.request("session/set_config_option", { sessionId, configId: "model", value });
      const reply = await h.waitFor((f) => f.id === id);
      expect(reply.error).toBeUndefined();
      return (reply.result?.["configOptions"] as { currentValue: string }[])[0]?.currentValue;
    };
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      expect((await driveTurn(h, a, "count")).reply.error).toBeUndefined();
      expect(sessionTally(a)).toEqual({ inputTokens: 10, outputTokens: 5 });
      const setId = h.request("session/set_mode", { sessionId: a, modeId: "ask" });
      expect((await h.waitFor((f) => f.id === setId)).error).toBeUndefined();
      expect(await setModel(a, m2.value)).toBe(m2.value);
      expect(binds).toBe(1);

      for (let i = 0; i < MAX_HELD_SESSIONS; i += 1) await h.newSession();
      expect(releasedFrames(h)[0]).toEqual({ sessionId: a, reason: IDLE_CAP_RELEASE_REASON });

      const loadId = h.request("session/load", { sessionId: a, cwd: h.projectDir, mcpServers: [] });
      const loaded = await h.waitFor((f) => f.id === loadId);
      expect(loaded.error).toBeUndefined();
      expect((loaded.result?.["modes"] as { currentModeId: string }).currentModeId).toBe("ask");
      expect((loaded.result?.["configOptions"] as { currentValue: string }[])[0]?.currentValue).toBe(m2.value);
      // The provider binding was dropped with the release and is built again.
      expect(binds).toBe(2);

      // A switch after the reload applies over the restore (the sequence did not restart).
      expect(await setModel(a, LAUNCH)).toBe(LAUNCH);
      expect((await driveTurn(h, a, "again")).reply.error).toBeUndefined();
      expect(sessionTally(a)).toEqual({ inputTokens: 11, outputTokens: 6 });
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

  test("stdin ending aborts a running turn in the shell profile, as a Stop would (security-code-w7 SEC-R4-001)", async () => {
    const h = shellHarness({ rounds: [toolRound("t1", "shell_exec", { command: "true" }), textRound("never reached")] });
    try {
      await h.initialize();
      const a = (await h.newSession()).sessionId;
      const { promptId } = await promptUntilAsked(h, a, "keep going unattended");
      // The permission ask is still open when input ends: the turn must not carry on to its next round.
      await h.end();
      const reply = await h.waitFor((f) => f.id === promptId);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.["stopReason"]).toBe("cancelled");
      expect(h.frames.some((f) => f.params?.update?.content?.text === "never reached")).toBe(false);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});
