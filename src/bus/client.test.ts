import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  joinBus,
  type BusClient,
  type BusPeer,
  type BusTimers,
  type JoinBusOptions,
  type RenderedBusEvent,
} from "./client";
import { displaySafe } from "./display";
import { appendEvent } from "./log";
import { presencePath, resolveBusRoot } from "./paths";
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
        sessionLease: {
          refresh(patch) {
            refreshCalls.push(patch);
            return true;
          },
        },
      }),
    );
    const { root } = await resolveBusRoot(cwd);
    const before = await readPresence(root, client.instanceId);

    clock += 5000;
    status = { status: "working", activity: "flow 273" };
    tick(5000); // the heartbeat only, never the poller
    await settle();

    const after = await readPresence(root, client.instanceId);
    expect(after?.status).toBe("working");
    expect(after?.activity).toBe("flow 273");
    expect(after?.heartbeatAt).not.toBe(before?.heartbeatAt);
    expect(refreshCalls).toEqual([{ name: client.name }]);
    client.leave();
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
        sessionLease: {
          refresh(patch) {
            refreshCalls.push(patch);
            return true;
          },
        },
      }),
    );

    await expect(client.rename("release")).rejects.toThrow(/name-taken/);
    expect(client.name).toBe("agent-1");

    await client.rename("phoenix");
    expect(client.name).toBe("phoenix");
    const record = await readPresence(root, client.instanceId);
    expect(record?.name).toBe("phoenix");
    expect(refreshCalls).toEqual([{ name: "phoenix" }]);
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

  test("setSession(id) rewrites presence.sessionId immediately", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd, { sessionId: SESSION }));
    const { root } = await resolveBusRoot(cwd);

    await client.setSession(SESSION_2);

    expect((await readPresence(root, client.instanceId))?.sessionId).toBe(SESSION_2);
    client.leave();
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
