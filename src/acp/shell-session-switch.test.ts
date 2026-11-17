// `keryx acp --profile shell` holds one active session per connection
// (specification §3.8; PR #1213 review highload-w3 F-001, highload-w5
// F-001/F-002): when `session/new` or `session/load` switches the connection
// to another session, the previous one is released — its lease goes back so
// `keryx shell --resume` can open it, and its shell tasks are swept. The
// editor profile keeps every session until the connection ends, as before.
//
// Also the roster cache (performance-w5 F-001/F-002): a session's shell roster
// is built once and reused by later turns and `/status`.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory } from "../session";
import { openLeasedSession, releaseSessionLease, sessionLeaseState } from "../session/lease";
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
    let a = "";
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
    let a = "";
    let b = "";
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
      // Both turns shared one metaproject adapter for the root.
      expect(builds[1]?.metaprojectPort).toBeDefined();

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
      rounds: [textRound("one"), textRound("two"), textRound("three")],
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
