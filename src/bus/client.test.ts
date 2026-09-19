import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_HEARTBEAT_MS,
  joinBus,
  type BusClient,
  type BusPeer,
  type BusTimers,
  type JoinBusOptions,
  type RenderedBusEvent,
} from "./client";
import { displaySafe } from "./display";
import { isBusRefusal } from "./errors";
import { readLease } from "./leases";
import { appendEvent, cursorAtStart, readEvents } from "./log";
import { eventsPath, presencePath, resolveBusRoot } from "./paths";
import { readPresence, writePresence } from "./presence";
import { processInstanceId } from "../session/lease";
import type { PresenceRecord } from "./schema";
import { sendMessage } from "./send";

// AC1, AC2, AC3, AC5, AC6: the surface-independent join/heartbeat/poll/leave
// sequence, proven with injected timers and clock over a real temp git repo
// (git itself is real and fast; only the 5 s/1500 ms production intervals are
// avoided, by ticking a fake timer instead of waiting on a real one).

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      // Isolated from the host's git config (hooks, signing, identity rules).
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

/** A one-commit repo, so `resolveProjectRoot`/`resolveBusRoot`/branch resolution all have something real to read. */
async function repo(branch = "main"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-client-"));
  ROOTS.push(dir);
  await writeFile(path.join(dir, "README.md"), "x\n", "utf8");
  await git(dir, "init", "-b", branch);
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial");
  return dir;
}

/** Records every `setInterval` call so a test can fire one deterministically, by its own `ms`. */
function fakeTimers(): { timers: BusTimers; tick: (ms: number) => void; size: () => number } {
  const registry = new Map<number, { ms: number; cb: () => void }>();
  let nextId = 1;
  const timers: BusTimers = {
    setInterval(cb, ms) {
      const id = nextId++;
      registry.set(id, { ms, cb });
      return id;
    },
    clearInterval(handle) {
      registry.delete(handle as number);
    },
  };
  return {
    timers,
    tick(ms) {
      for (const entry of registry.values()) if (entry.ms === ms) entry.cb();
    },
    size: () => registry.size,
  };
}

/** Real I/O (a git spawn, a file write) the heartbeat/poll kick off but do not expose a promise for; a short, bounded wait, never the production interval itself. */
function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `done()` holds, bounded by `timeoutMs` — for a fire-and-forget tick whose last observable step is known, so the wait ends on that step rather than on a guessed duration. */
async function until(done: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await settle(5);
  }
}

function asClient(result: BusClient | { disabled: string }): BusClient {
  if ("disabled" in result) throw new Error(`joinBus unexpectedly disabled: ${result.disabled}`);
  return result;
}

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const OTHER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SESSION = "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f";
const SESSION_2 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const SYSTEM_ID = "00000000-0000-4000-8000-000000000000";
const REPLY_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function peerRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId: OTHER,
    name: "release",
    pid: 4242,
    host: "this-host",
    sessionId: SESSION,
    checkout: "/repo",
    branch: null,
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: iso(NOW),
    heartbeatAt: iso(NOW),
    keryxVersion: "0.2.121",
    ...overrides,
  };
}

function join(cwd: string, overrides: Partial<JoinBusOptions> = {}): Promise<BusClient | { disabled: string }> {
  return joinBus({
    cwd,
    sessionId: SESSION,
    surface: "readline",
    env: {},
    now: () => NOW,
    host: "this-host",
    isAlive: () => false,
    status: () => ({ status: "idle", activity: "" }),
    onEvent: () => {},
    onPeers: () => {},
    ...overrides,
  });
}

describe("joinBus: disabled", () => {
  test("returns { disabled: reason } and writes nothing when KERYX_BUS=off", async () => {
    const cwd = await repo();
    const result = await join(cwd, { env: { KERYX_BUS: "off" } });
    expect(result).toEqual({ disabled: "KERYX_BUS=off" });
    const { root } = await resolveBusRoot(cwd);
    expect(existsSync(root)).toBe(false);
  });

  test("shell config bus.enabled: false is also honoured", async () => {
    const cwd = await repo();
    const result = await join(cwd, { shellConfig: { bus: { enabled: false } } });
    expect(result).toEqual({ disabled: "shell config bus.enabled is false" });
  });
});

describe("joinBus: name allocation (D-06)", () => {
  test("defaults to agent-<n>", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    expect(client.name).toBe("agent-1");
    expect(client.nameWasTaken).toBe(false);
    client.leave();
  });

  test("prefers bus.name over agent-<n>, and --name over bus.name", async () => {
    const cwd = await repo();
    const viaConfig = asClient(await join(cwd, { shellConfig: { bus: { name: "scribe" } } }));
    expect(viaConfig.name).toBe("scribe");
    viaConfig.leave();

    const viaFlag = asClient(await join(cwd, { requestedName: "herald", shellConfig: { bus: { name: "scribe" } } }));
    expect(viaFlag.name).toBe("herald");
    viaFlag.leave();
  });

  test("a name a live peer holds becomes <name>-2, and nameWasTaken is reported", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    await writePresence(root, peerRecord({ name: "release" }));

    const client = asClient(await join(cwd, { requestedName: "release" }));
    expect(client.name).toBe("release-2");
    expect(client.nameWasTaken).toBe(true);
    client.leave();
  });

  test("an invalid or reserved requested name throws a typed BusRefusal, and writes no presence", async () => {
    const cwd = await repo();
    await expect(join(cwd, { requestedName: "Bad Name" })).rejects.toThrow(/invalid-name/);
    await expect(join(cwd, { requestedName: "system" })).rejects.toThrow(/reserved-name/);
    const { root } = await resolveBusRoot(cwd);
    expect(await readPresence(root, processInstanceId())).toBeUndefined();
  });
});

describe("joinBus: presence fields (specification §4.1)", () => {
  test("writes every field, keyed by the resolved checkout and branch", async () => {
    const cwd = await repo("feature/agent-bus");
    const client = asClient(
      await join(cwd, {
        sessionId: SESSION,
        surface: "tui",
        status: () => ({ status: "working", activity: "flow 273 task T5" }),
      }),
    );
    const { root } = await resolveBusRoot(cwd);
    const record = await readPresence(root, client.instanceId);

    expect(record).toMatchObject({
      schemaVersion: 1,
      instanceId: client.instanceId,
      name: client.name,
      pid: process.pid,
      sessionId: SESSION,
      checkout: path.resolve(cwd),
      branch: "feature/agent-bus",
      surface: "tui",
      status: "working",
      activity: "flow 273 task T5",
    });
    expect(record?.host.length).toBeGreaterThan(0);
    expect(record?.keryxVersion.length).toBeGreaterThan(0);
    expect(record?.startedAt).toEqual(expect.any(String));
    expect(record?.heartbeatAt).toEqual(expect.any(String));
    client.leave();
  });

  test("activity is displaySafe'd and bounded to 120 characters", async () => {
    const cwd = await repo();
    const dirty = `line1[31m${"x".repeat(200)}`;
    const client = asClient(await join(cwd, { status: () => ({ status: "idle", activity: dirty }) }));
    const { root } = await resolveBusRoot(cwd);
    const record = await readPresence(root, client.instanceId);
    expect(record?.activity.length).toBeLessThanOrEqual(120);
    expect(record?.activity).not.toContain("");
    client.leave();
  });

  test("the initial onPeers call reports the peer count before this instance's own presence is written", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    await writePresence(root, peerRecord({ name: "release" }));
    const seen: BusPeer[][] = [];
    const client = asClient(await join(cwd, { onPeers: (peers) => seen.push(peers) }));
    expect(seen[0]?.map((p) => p.record.name)).toEqual(["release"]);
    client.leave();
  });
});

describe("joinBus: heartbeat (specification §5.1, §5.2)", () => {
  test("an unref'd heartbeat tick rewrites presence and patches the session lease with the current name", async () => {
    const cwd = await repo();
    const { timers, tick } = fakeTimers();
    let clock = NOW;
    let status: { status: "idle" | "working" | "blocked"; activity: string } = { status: "idle", activity: "start" };
    const refreshCalls: Array<{ name?: string | null } | undefined> = [];
    const client = asClient(
      await join(cwd, {
        timers,
        heartbeatMs: 5000,
        pollMs: 1500,
        now: () => clock,
        status: () => status,
        resolveBranch: async () => "main", // no `git rev-parse` spawn inside the tick
        // review r1 F2: a GETTER, called at each use — not a value captured once.
        sessionLease: () => ({
          refresh(patch) {
            refreshCalls.push(patch);
            return true;
          },
        }),
      }),
    );
    const { root } = await resolveBusRoot(cwd);
    const before = await readPresence(root, client.instanceId);
    expect(refreshCalls).toEqual([{ name: client.name }]); // specification §5.1: refreshed right at join

    clock += 5000;
    status = { status: "working", activity: "flow 273" };
    tick(5000); // the heartbeat only, never the poller
    await until(() => refreshCalls.length === 2); // the lease refresh is the tick's last step, after the presence write

    const after = await readPresence(root, client.instanceId);
    expect(after?.status).toBe("working");
    expect(after?.activity).toBe("flow 273");
    expect(after?.heartbeatAt).not.toBe(before?.heartbeatAt);
    expect(refreshCalls).toEqual([{ name: client.name }, { name: client.name }]);
    client.leave();
  });

  test("review r1 F2: the getter is re-read on every heartbeat, so a swapped lease handle is refreshed, never a released one", async () => {
    const cwd = await repo();
    const { timers, tick } = fakeTimers();
    const oldCalls: Array<{ name?: string | null } | undefined> = [];
    const newCalls: Array<{ name?: string | null } | undefined> = [];
    const oldLease = { refresh: (patch: { name?: string | null }) => oldCalls.push(patch) };
    const newLease = { refresh: (patch: { name?: string | null }) => newCalls.push(patch) };
    let current: typeof oldLease | typeof newLease | undefined = oldLease;
    const client = asClient(
      await join(cwd, { timers, resolveBranch: async () => "main", sessionLease: () => current }),
    );
    expect(oldCalls.length).toBe(1); // at join

    current = newLease; // e.g. `/new` swaps the lease the shell holds
    tick(DEFAULT_HEARTBEAT_MS);
    await until(() => newCalls.length > 0 || oldCalls.length > 1);

    expect(oldCalls.length).toBe(1); // never refreshed again: it was released
    expect(newCalls).toEqual([{ name: client.name }]);
    client.leave();
  });

  test("review r1 F8: KERYX_BUS_HEARTBEAT_MS shortens the heartbeat interval in a test context, clamped to 50ms", async () => {
    const cwd = await repo();
    const savedNodeEnv = process.env.NODE_ENV;
    const savedTiming = process.env.KERYX_TEST_BUS_TIMING;
    const savedHeartbeat = process.env.KERYX_BUS_HEARTBEAT_MS;
    try {
      process.env.NODE_ENV = "production"; // the gate itself: env alone must not apply outside a test context
      process.env.KERYX_TEST_BUS_TIMING = "1";
      process.env.KERYX_BUS_HEARTBEAT_MS = "10"; // below the 50ms floor: ignored
      // The heartbeat timer is always the FIRST `setInterval` call `joinBus`
      // makes (the poller is the second, at a different `ms`) — the array is
      // cleared before each join so `[0]` always names that join's heartbeat.
      let seenMs: number[] = [];
      const timers: BusTimers = {
        setInterval(_cb, ms) {
          seenMs.push(ms);
          return {};
        },
        clearInterval() {},
      };
      const clamped = asClient(await join(cwd, { timers }));
      expect(seenMs[0]).toBe(DEFAULT_HEARTBEAT_MS); // 10 < the 50ms floor
      clamped.leave();

      seenMs = [];
      process.env.KERYX_BUS_HEARTBEAT_MS = "77";
      const honoured = asClient(await join(cwd, { timers }));
      expect(seenMs[0]).toBe(77);
      honoured.leave();

      seenMs = [];
      delete process.env.KERYX_TEST_BUS_TIMING;
      const outsideTestContext = asClient(await join(cwd, { timers }));
      expect(seenMs[0]).toBe(DEFAULT_HEARTBEAT_MS); // gate off: env ignored
      outsideTestContext.leave();
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedTiming === undefined) delete process.env.KERYX_TEST_BUS_TIMING;
      else process.env.KERYX_TEST_BUS_TIMING = savedTiming;
      if (savedHeartbeat === undefined) delete process.env.KERYX_BUS_HEARTBEAT_MS;
      else process.env.KERYX_BUS_HEARTBEAT_MS = savedHeartbeat;
    }
  });

  test("both the heartbeat and the poller are started unref'd", async () => {
    const cwd = await repo();
    const unreffed: string[] = [];
    let n = 0;
    const timers: BusTimers = {
      setInterval(_cb, ms) {
        const id = `t${(n += 1)}`;
        return { id, ms, unref: () => unreffed.push(id) };
      },
      clearInterval() {},
    };
    const client = asClient(await join(cwd, { timers }));
    expect(unreffed.length).toBe(2); // heartbeat + poller, each unref'd exactly once
    client.leave();
  });
});

describe("joinBus: poll (specification §5.2)", () => {
  test("renders events addressed to me or broadcast by someone else, skips my own broadcasts and system kinds, and displaySafe's the preview", async () => {
    const cwd = await repo();
    const rendered: RenderedBusEvent[] = [];
    const client = asClient(await join(cwd, { onEvent: (event) => rendered.push(event) }));
    const { root } = await resolveBusRoot(cwd);
    const other = { instanceId: OTHER, name: "release", origin: "operator" as const };

    // My own @all: never rendered back to myself.
    await sendMessage(root, {
      toLabel: "@all",
      kind: "notice",
      body: "self broadcast",
      origin: "operator",
      from: { instanceId: client.instanceId, name: client.name, origin: "operator" },
    });
    // Addressed to me directly, with an ANSI escape in the body.
    await appendEvent(root, {
      from: other,
      to: [client.instanceId],
      toLabel: `@${client.name}`,
      kind: "notice",
      body: "hi [31mred[0m there",
    });
    // A broadcast from someone else: rendered.
    await appendEvent(root, { from: other, to: ["*"], toLabel: "@all", kind: "question", body: "anyone?" });
    // A system kind addressed to me: kept, never rendered.
    await appendEvent(root, {
      from: { instanceId: SYSTEM_ID, name: "system", origin: "system" },
      to: [client.instanceId],
      toLabel: `@${client.name}`,
      kind: "ack",
      refs: { replyTo: REPLY_ID },
    });

    const kept = await client.pollNow();

    expect(kept.map((event) => event.kind).sort()).toEqual(["ack", "notice", "question"]);
    expect(rendered.map((event) => event.kind)).toEqual(["notice", "question"]);
    expect(rendered[0]?.preview).toBe(displaySafe("hi [31mred[0m there"));
    expect(rendered[0]?.preview).toBe("hi red there");
    expect(rendered[0]?.fromName).toBe("release");
    expect(rendered[0]?.fromInstanceId).toBe(OTHER);
    expect(rendered[0]?.shortId).toBe(rendered[0]?.id.slice(0, 8));
    expect(rendered[0]?.shortId.length).toBe(8);
    client.leave();
  });

  test("onPeers excludes self and reports live peers on every poll", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const seen: BusPeer[][] = [];
    const client = asClient(await join(cwd, { onPeers: (peers) => seen.push(peers) }));

    await writePresence(root, peerRecord({ name: "release", heartbeatAt: iso(NOW) }));
    await writePresence(root, peerRecord({ instanceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "ghost", heartbeatAt: iso(NOW - 60_000), host: "other-host" }));

    await client.pollNow();
    const peers = client.peers();
    expect(peers.map((p) => p.record.name)).toEqual(["release"]);
    expect(peers.every((p) => p.record.instanceId !== client.instanceId)).toBe(true);
    expect(seen.at(-1)?.map((p) => p.record.name)).toEqual(["release"]);
    client.leave();
  });
});

describe("joinBus: rename (D-06)", () => {
  test("refuses a name a live peer holds, and otherwise rewrites presence and patches the lease", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    await writePresence(root, peerRecord({ name: "release" }));
    const refreshCalls: Array<{ name?: string | null } | undefined> = [];
    const client = asClient(
      await join(cwd, {
        // review r1 F2: a GETTER — join() itself calls it once with the initial name.
        sessionLease: () => ({
          refresh(patch) {
            refreshCalls.push(patch);
            return true;
          },
        }),
      }),
    );
    expect(refreshCalls).toEqual([{ name: "agent-1" }]);

    await expect(client.rename("release")).rejects.toThrow(/name-taken/);
    expect(client.name).toBe("agent-1");
    expect(refreshCalls).toEqual([{ name: "agent-1" }]); // a refused rename never refreshes

    await client.rename("phoenix");
    expect(client.name).toBe("phoenix");
    const record = await readPresence(root, client.instanceId);
    expect(record?.name).toBe("phoenix");
    expect(refreshCalls).toEqual([{ name: "agent-1" }, { name: "phoenix" }]);
    client.leave();
  });

  test("refuses an invalid new name", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    await expect(client.rename("Not Valid")).rejects.toThrow(/invalid-name/);
    client.leave();
  });
});

describe("joinBus: send (specification §4.2, D-12)", () => {
  test("sends with origin operator and from set to this instance", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));

    const result = await client.send("@all", "notice", "hello everyone");

    expect(result.event.from).toEqual({ instanceId: client.instanceId, name: client.name, origin: "operator" });
    expect(result.event.kind).toBe("notice");
    expect(result.resolvedTo).toEqual(["*"]);
    client.leave();
  });

  test("setSession(id) rewrites presence.sessionId immediately, and refreshes the lease (review r1 F2)", async () => {
    const cwd = await repo();
    const refreshCalls: Array<{ name?: string | null } | undefined> = [];
    const client = asClient(
      await join(cwd, {
        sessionId: SESSION,
        sessionLease: () => ({
          refresh(patch) {
            refreshCalls.push(patch);
            return true;
          },
        }),
      }),
    );
    const { root } = await resolveBusRoot(cwd);
    expect(refreshCalls).toEqual([{ name: client.name }]); // at join

    await client.setSession(SESSION_2);

    expect((await readPresence(root, client.instanceId))?.sessionId).toBe(SESSION_2);
    expect(refreshCalls).toEqual([{ name: client.name }, { name: client.name }]);
    client.leave();
  });

  describe("review r1 F10: setSession never rejects", () => {
    test('a presence-write failure during setSession is reported via onError("session"), and setSession still resolves', async () => {
      const cwd = await repo();
      const { timers } = fakeTimers();
      const errors: Array<[unknown, string]> = [];
      const client = asClient(
        await join(cwd, {
          timers,
          onError: (error, where) => errors.push([error, where]),
        }),
      );
      const { root } = await resolveBusRoot(cwd);
      // Corrupt presence/ into a plain file: the next write's ensureBusDir throws.
      await rm(path.join(root, "presence"), { recursive: true, force: true });
      await writeFile(path.join(root, "presence"), "not a directory", "utf8");

      await client.setSession(SESSION_2); // must resolve even though the write underneath fails

      expect(errors.length).toBe(1);
      expect(errors[0]?.[1]).toBe("session");
      client.leave();
    });
  });
});

describe("joinBus: review r1 F1 — no presence recreated after leave()", () => {
  test("a heartbeat gated mid-flight, released after leave(), never recreates the presence file", async () => {
    const cwd = await repo();
    const { timers, tick } = fakeTimers();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let branchCalls = 0;
    const client = asClient(
      await join(cwd, {
        timers,
        resolveBranch: async () => {
          branchCalls += 1;
          // The FIRST call is join()'s own initial branch resolution and must
          // resolve immediately, or `join()` itself would deadlock on the
          // gate below before ever returning. Only the heartbeat's call (the
          // second and later) is gated.
          if (branchCalls > 1) await gate;
          return null;
        },
      }),
    );
    const { root } = await resolveBusRoot(cwd);
    expect(await readPresence(root, client.instanceId)).toBeDefined();
    expect(branchCalls).toBe(1);

    tick(DEFAULT_HEARTBEAT_MS); // starts heartbeatTick, which awaits the gated branch lookup
    await settle(10); // let it begin and park on the gate
    expect(branchCalls).toBe(2);

    client.leave(); // presence removed synchronously, right here
    expect(existsSync(presencePath(root, client.instanceId))).toBe(false);

    releaseGate(); // let the parked heartbeat resume: it must not recreate the file
    await settle();

    expect(existsSync(presencePath(root, client.instanceId))).toBe(false);
  });

  test("setSession and rename no-op after leave()", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const { root } = await resolveBusRoot(cwd);
    client.leave();
    expect(existsSync(presencePath(root, client.instanceId))).toBe(false);

    await client.setSession(SESSION_2); // must not throw, must not recreate presence
    expect(existsSync(presencePath(root, client.instanceId))).toBe(false);

    await client.rename("phoenix"); // must not throw, must not recreate presence, must not change .name
    expect(client.name).toBe("agent-1");
    expect(existsSync(presencePath(root, client.instanceId))).toBe(false);
  });
});

describe("joinBus: review r1 F7 — a half-failed join orphans no presence", () => {
  test("cursorAtEnd throwing after the presence write is unlinked, and the error still propagates", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const instanceId = processInstanceId();
    // events.jsonl exists as a DIRECTORY: opening it for read succeeds, but
    // reading from it throws EISDIR — cursorAtEnd's own failure mode, induced
    // without a test seam into `./log.ts`.
    mkdirSync(eventsPath(root), { recursive: true });

    await expect(join(cwd)).rejects.toThrow();
    expect(await readPresence(root, instanceId)).toBeUndefined();
    expect(existsSync(presencePath(root, instanceId))).toBe(false);
  });
});

describe("joinBus: review r1 F10 — poll never drops a batch on a throwing onEvent", () => {
  test("one throwing onEvent is reported via onError(\"poll\") and does not stop the rest of the batch, or the cursor", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const rendered: RenderedBusEvent[] = [];
    const errors: Array<[unknown, string]> = [];
    const client = asClient(
      await join(cwd, {
        onEvent: (event) => {
          rendered.push(event);
          if (event.kind === "question") throw new Error("render exploded");
        },
        onError: (error, where) => errors.push([error, where]),
      }),
    );
    const other = { instanceId: OTHER, name: "release", origin: "operator" as const };
    await appendEvent(root, { from: other, to: ["*"], toLabel: "@all", kind: "notice", body: "one" });
    await appendEvent(root, { from: other, to: ["*"], toLabel: "@all", kind: "question", body: "two: throws" });
    await appendEvent(root, { from: other, to: ["*"], toLabel: "@all", kind: "notice", body: "three" });

    await client.pollNow();

    expect(rendered.map((e) => e.preview)).toEqual(["one", "two: throws", "three"]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.[1]).toBe("poll");
    expect((errors[0]?.[0] as Error).message).toBe("render exploded");

    // The cursor advanced past all three despite the throw: nothing is redelivered.
    rendered.length = 0;
    await client.pollNow();
    expect(rendered).toEqual([]);
    client.leave();
  });
});

describe("joinBus: resolveRef and reply (review r1 F4)", () => {
  async function joinWithOneMessage(cwd: string): Promise<{ client: BusClient; senderId: string; eventId: string; seq: number }> {
    const { root } = await resolveBusRoot(cwd);
    const client = asClient(await join(cwd));
    // `appendEvent` directly, like the "poll" describe block above: it skips
    // `sendMessage`'s `@name` liveness resolution entirely, which otherwise
    // classifies this instance's OWN presence against `Date.now()` (the
    // sender has none here) rather than the fixed `NOW` clock `join()` uses.
    const event = await appendEvent(root, {
      from: { instanceId: OTHER, name: "release", origin: "operator" },
      to: [client.instanceId],
      toLabel: `@${client.name}`,
      kind: "notice",
      body: "hello",
    });
    await client.pollNow();
    return { client, senderId: OTHER, eventId: event.id, seq: event.seq };
  }

  test("resolveRef finds a message by #seq, bare seq, or an id prefix of at least 8 characters", async () => {
    const cwd = await repo();
    const { client, senderId, eventId, seq } = await joinWithOneMessage(cwd);

    for (const ref of [`#${seq}`, `${seq}`, eventId.slice(0, 8), eventId]) {
      const resolved = client.resolveRef(ref);
      expect(resolved).toEqual({ id: eventId, seq, fromInstanceId: senderId, fromName: "release" });
    }
    client.leave();
  });

  test("an unmatched or too-short ref resolves to undefined, never a throw", async () => {
    const cwd = await repo();
    const { client } = await joinWithOneMessage(cwd);
    expect(client.resolveRef("#999")).toBeUndefined();
    expect(client.resolveRef("nope1234")).toBeUndefined();
    expect(client.resolveRef("short")).toBeUndefined(); // < 8 chars and not a bare seq
    client.leave();
  });

  test("an ambiguous id prefix resolves to undefined", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const client = asClient(await join(cwd));
    const sameName = { instanceId: OTHER, name: "release", origin: "operator" as const };
    // Two ids sharing their first 8 hex characters (a UUID's first hyphen-delimited group).
    const idA = "aaaaaaaa-0000-4000-8000-000000000001";
    const idB = "aaaaaaaa-0000-4000-8000-000000000002";
    await appendEvent(root, { id: idA, from: sameName, to: [client.instanceId], toLabel: `@${client.name}`, kind: "notice", body: "a" });
    await appendEvent(root, { id: idB, from: sameName, to: [client.instanceId], toLabel: `@${client.name}`, kind: "notice", body: "b" });
    await client.pollNow();

    expect(client.resolveRef("aaaaaaaa")).toBeUndefined();
    expect(client.resolveRef(idA)).toEqual(expect.objectContaining({ id: idA }));
    client.leave();
  });

  test("reply() sends kind reply, replyTo the resolved id, addressed to the sender's instanceId — not by name", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const { client, senderId, eventId, seq } = await joinWithOneMessage(cwd);
    // The sender renamed since: reply must still reach them, by instanceId.
    await writePresence(root, {
      schemaVersion: 1,
      instanceId: senderId,
      name: "renamed",
      pid: 4242,
      host: "this-host",
      sessionId: SESSION,
      checkout: "/repo",
      branch: null,
      surface: "tui",
      status: "idle",
      activity: "",
      startedAt: iso(NOW),
      heartbeatAt: iso(NOW),
      keryxVersion: "0.2.121",
    });

    const result = await client.reply(`#${seq}`, "on it");

    expect(result.event.kind).toBe("reply");
    expect(result.event.refs).toEqual({ replyTo: eventId });
    expect(result.event.to).toEqual([senderId]);
    expect(result.event.toLabel).toBe("@release"); // the name AT SEND TIME, not the live one
    client.leave();
  });

  test("reply() to an unresolved ref throws BusRefusal(\"unknown-message\")", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const thrown = await client.reply("#404", "?").catch((error: unknown) => error);
    expect(isBusRefusal(thrown, "unknown-message")).toBe(true);
    client.leave();
  });

  test("reply() refuses recipient-not-live when the original sender never held (or no longer holds) presence", async () => {
    const cwd = await repo();
    // `joinWithOneMessage`'s sender (OTHER) never writes its own presence
    // record, so by construction it is not live: reply() must refuse rather
    // than address an instance nobody can show is still there.
    const { client, seq } = await joinWithOneMessage(cwd);
    const thrown = await client.reply(`#${seq}`, "on it").catch((error: unknown) => error);
    expect(isBusRefusal(thrown, "recipient-not-live")).toBe(true);
    client.leave();
  });

  describe("sendAsAgent and replyAsAgent (review r1 F3, F5)", () => {
    test("sendAsAgent writes with from.origin agent, from set to this instance — not operator", async () => {
      const cwd = await repo();
      const client = asClient(await join(cwd));

      const result = await client.sendAsAgent("@all", "notice", "hello everyone");

      expect(result.event.from).toEqual({ instanceId: client.instanceId, name: client.name, origin: "agent" });
      expect(result.event.kind).toBe("notice");
      expect(result.resolvedTo).toEqual(["*"]);
      client.leave();
    });

    test("replyAsAgent shares reply()'s ref resolution: same resolved id/instanceId, but from.origin agent", async () => {
      const cwd = await repo();
      const { root } = await resolveBusRoot(cwd);
      const { client, senderId, eventId, seq } = await joinWithOneMessage(cwd);
      // The sender renamed since: replyAsAgent must still reach them, by instanceId — exactly like reply().
      await writePresence(root, {
        schemaVersion: 1,
        instanceId: senderId,
        name: "renamed",
        pid: 4242,
        host: "this-host",
        sessionId: SESSION,
        checkout: "/repo",
        branch: null,
        surface: "tui",
        status: "idle",
        activity: "",
        startedAt: iso(NOW),
        heartbeatAt: iso(NOW),
        keryxVersion: "0.2.121",
      });

      const result = await client.replyAsAgent(`#${seq}`, "on it");

      expect(result.event.kind).toBe("reply");
      expect(result.event.refs).toEqual({ replyTo: eventId });
      expect(result.event.to).toEqual([senderId]);
      expect(result.event.toLabel).toBe("@release"); // the name AT SEND TIME, not the live one
      expect(result.event.from).toEqual({ instanceId: client.instanceId, name: client.name, origin: "agent" });
      client.leave();
    });

    test("replyAsAgent() to an unresolved ref throws BusRefusal(\"unknown-message\")", async () => {
      const cwd = await repo();
      const client = asClient(await join(cwd));
      const thrown = await client.replyAsAgent("#404", "?").catch((error: unknown) => error);
      expect(isBusRefusal(thrown, "unknown-message")).toBe(true);
      client.leave();
    });

    test("sendAsAgent and send() (operator) are counted against separate D-12 budgets for the same instance", async () => {
      const cwd = await repo();
      const client = asClient(await join(cwd));
      for (let i = 0; i < 10; i++) {
        const result = await client.sendAsAgent("@all", "notice", `agent ${i}`);
        expect(result.event.from.origin).toBe("agent");
      }
      const agentBlocked = await client.sendAsAgent("@all", "notice", "one too many").catch((e: unknown) => e);
      expect(isBusRefusal(agentBlocked, "rate-limited")).toBe(true);

      // The operator budget is untouched: send() still works for this same instance.
      const operatorResult = await client.send("@all", "notice", "operator still fine");
      expect(operatorResult.event.from.origin).toBe("operator");
      client.leave();
    });
  });
});

describe("joinBus: leave (specification §5.4)", () => {
  test("removes presence, stops both timers, and is idempotent", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const { timers, size } = fakeTimers();
    const client = asClient(await join(cwd, { timers }));

    expect(await readPresence(root, client.instanceId)).toBeDefined();
    expect(size()).toBe(2); // heartbeat + poller

    client.leave();

    expect(existsSync(presencePath(root, client.instanceId))).toBe(false);
    expect(size()).toBe(0);

    // Idempotent: a second and third call do nothing and never throw.
    client.leave();
    client.leave();
  });

  test("registers a process exit hook once, and leave() unregisters it", async () => {
    const cwd = await repo();
    const before = process.listenerCount("exit");

    const client = asClient(await join(cwd));
    expect(process.listenerCount("exit")).toBe(before + 1);

    client.leave();
    expect(process.listenerCount("exit")).toBe(before);

    client.leave(); // idempotent: removes nothing more
    expect(process.listenerCount("exit")).toBe(before);
  });
});

describe("joinBus: leave resumes own leases (specification §5.4, AC9, flow 275 T5)", () => {
  test("deletes the lease file synchronously and appends a best-effort resume event", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const { root } = await resolveBusRoot(cwd);

    const lease = await client.pause("@all", "turns", "cutting 0.2.130", undefined, "operator");
    expect(await readLease(root, lease.leaseId)).toBeDefined();

    client.leave();

    expect(await readLease(root, lease.leaseId)).toBeUndefined();
    const events = (await readEvents(root, await cursorAtStart(root))).events;
    const resume = events.find((e) => e.kind === "resume" && e.refs?.leaseId === lease.leaseId);
    expect(resume).toBeDefined();
    expect(resume?.from.instanceId).toBe(client.instanceId);
  });

  test("a client holding no lease leaves exactly as before (no resume event)", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const { root } = await resolveBusRoot(cwd);

    client.leave();

    const events = (await readEvents(root, await cursorAtStart(root))).events;
    expect(events.filter((e) => e.kind === "resume")).toHaveLength(0);
  });
});
