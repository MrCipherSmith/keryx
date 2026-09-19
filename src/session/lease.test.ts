// Session lease (agent bus P0, spec §6, AC8/AC9 groundwork for AC1/AC2/AC5).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { readLeaseOwnerSync } from "../lib/fs";
import {
  describeLeaseLoss,
  latestUnleasedSession,
  openLeasedSession,
  processInstanceId,
  releaseSessionLease,
  resolveSessionLeaseTiming,
  SESSION_LEASE_HEARTBEAT_MS,
  SESSION_LEASE_STALE_MS,
  SessionLeasedError,
  type SessionLeaseOwner,
  sessionLeasePath,
  sessionLeaseState,
  switchLeasedSession,
  watchLeaseLoss,
} from "./lease";
import { createSession, type SessionHandle, shortSessionId } from "./store";

const SCHEMA_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-agent-bus",
  "schemas",
  "session-lease.schema.json",
);

let root: string;
let cwd: string;
let dataDir: string;
const opened: Array<{ lease: { release(): void } }> = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-session-lease-"));
  cwd = path.join(root, "project");
  dataDir = path.join(root, "data");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  for (const item of opened.splice(0)) item.lease.release();
  rmSync(root, { recursive: true, force: true });
});

function track<T extends { lease: { release(): void } }>(value: T): T {
  opened.push(value);
  return value;
}

/**
 * A session created without any lease. Spins past the current millisecond
 * first so consecutive sessions get distinct `updatedAt` and list in order.
 */
function makeSession(title: string): SessionHandle {
  const start = Date.now();
  while (Date.now() - start < 3) {
    // wait
  }
  return createSession({ cwd, dataDir, title });
}

/** Plant a holder from ANOTHER instance directly with fs, as that process would. */
function plantHolder(sessionId: string, overrides: Partial<SessionLeaseOwner> = {}): SessionLeaseOwner {
  const at = new Date().toISOString();
  const holder: SessionLeaseOwner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: 424242,
    host: hostname(),
    instanceId: randomUUID(),
    name: null,
    acquiredAt: at,
    heartbeatAt: at,
    ...overrides,
  };
  const lockPath = sessionLeasePath(cwd, sessionId, dataDir);
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(holder), { mode: 0o600 });
  return holder;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stats = statSync(full);
    out[name] = stats.isDirectory() ? `dir:${stats.mtimeMs}` : `${stats.mtimeMs}:${readFileSync(full, "utf8")}`;
  }
  return out;
}

/** Minimal validator for the subset of JSON Schema the lease schema uses. */
function validateAgainstSchema(value: Record<string, unknown>): string[] {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, Record<string, unknown>>;
  };
  const errors: string[] = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const key of schema.required) {
    if (!(key in value)) errors.push(`missing ${key}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) errors.push(`unexpected ${key}`);
    }
  }
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    const v = value[key];
    if ("const" in rule && v !== rule.const) errors.push(`${key} != const`);
    const types = rule.type === undefined ? [] : Array.isArray(rule.type) ? rule.type : [rule.type];
    const typeOk =
      types.length === 0 ||
      types.some((t) =>
        t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : typeof v === t,
      );
    if (!typeOk) errors.push(`${key} has wrong type`);
    if (typeof v === "string") {
      if (rule.format === "uuid" && !uuid.test(v)) errors.push(`${key} not a uuid`);
      if (rule.format === "date-time" && Number.isNaN(Date.parse(v))) errors.push(`${key} not a date-time`);
      if (typeof rule.minLength === "number" && v.length < rule.minLength) errors.push(`${key} too short`);
      if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(v)) errors.push(`${key} pattern`);
    }
    if (typeof v === "number" && typeof rule.minimum === "number" && v < rule.minimum) errors.push(`${key} < min`);
  }
  return errors;
}

describe("constants and identity", () => {
  test("D-09 timings and a stable per-process instance id", () => {
    expect(SESSION_LEASE_STALE_MS).toBe(15_000);
    expect(SESSION_LEASE_HEARTBEAT_MS).toBe(5_000);
    expect(processInstanceId()).toBe(processInstanceId());
  });
});

describe("openLeasedSession", () => {
  test("a new session is leased with a schema-valid owner record, 0600 inside 0700", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    expect(result.resumed).toBe(false);
    const lockPath = sessionLeasePath(cwd, result.handle.summary.id, dataDir);
    const raw = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as Record<string, unknown>;
    expect(validateAgainstSchema(raw)).toEqual([]);
    expect(raw.name).toBeNull();
    expect(raw.pid).toBe(process.pid);
    expect(raw.instanceId).toBe(processInstanceId());
    expect(statSync(lockPath).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(lockPath, "owner.json")).mode & 0o777).toBe(0o600);
    expect(sessionLeaseState(cwd, result.handle.summary.id, dataDir).state).toBe("mine");
  });

  test("the schema validator itself rejects a bad record", () => {
    expect(validateAgainstSchema({ schemaVersion: 2, token: "x", pid: 0, extra: 1 }).length).toBeGreaterThan(3);
  });

  test("continueLast skips a session held by another live instance and reports it", () => {
    const older = makeSession("older");
    const newer = makeSession("newer");
    // Make the ordering deterministic: `newer` is the latest.
    expect(latestUnleasedSession(cwd, dataDir).summary?.id).toBe(newer.summary.id);
    const holder = plantHolder(newer.summary.id);

    const result = track(openLeasedSession({ cwd, dataDir, continueLast: true }));
    expect(result.handle.summary.id).toBe(older.summary.id);
    expect(result.resumed).toBe(true);
    expect(result.skipped?.summary.id).toBe(newer.summary.id);
    expect(result.skipped?.state).toBe("live");
    expect(result.skipped?.holder?.instanceId).toBe(holder.instanceId);
  });

  test("continueLast starts a new session when every session is held, naming the holder", () => {
    const only = makeSession("only");
    plantHolder(only.summary.id);
    const result = track(openLeasedSession({ cwd, dataDir, continueLast: true }));
    expect(result.resumed).toBe(false);
    expect(result.handle.summary.id).not.toBe(only.summary.id);
    expect(result.skipped?.summary.id).toBe(only.summary.id);
  });

  test("resumeId against a live holder throws a --fork error and touches nothing", () => {
    const target = makeSession("held");
    const holder = plantHolder(target.summary.id);
    const before = snapshot(target.dir);
    const leaseBefore = readFileSync(
      path.join(sessionLeasePath(cwd, target.summary.id, dataDir), "owner.json"),
      "utf8",
    );

    let caught: unknown;
    try {
      openLeasedSession({ cwd, dataDir, resumeId: target.summary.id });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionLeasedError);
    const error = caught as SessionLeasedError;
    expect(error.state).toBe("live");
    expect(error.summary.id).toBe(target.summary.id);
    expect(error.holder?.token).toBe(holder.token);
    expect(error.message).toContain("--fork");
    expect(error.message).not.toContain("--take-over");
    expect(error.message).toContain(`instance ${holder.instanceId.slice(0, 8)} (pid ${holder.pid})`);

    expect(snapshot(target.dir)).toEqual(before);
    expect(
      readFileSync(path.join(sessionLeasePath(cwd, target.summary.id, dataDir), "owner.json"), "utf8"),
    ).toBe(leaseBefore);
  });

  test("resumeId against a stale holder names --take-over; takeOver reclaims it", () => {
    const target = makeSession("stale");
    const old = new Date(Date.now() - 60_000).toISOString();
    plantHolder(target.summary.id, { acquiredAt: old, heartbeatAt: old });
    const timing = { isAlive: () => true };

    expect(() => openLeasedSession({ cwd, dataDir, resumeId: target.summary.id, ...timing })).toThrow(
      /--fork or --take-over/,
    );

    const result = track(openLeasedSession({ cwd, dataDir, resumeId: target.summary.id, takeOver: true, ...timing }));
    expect(result.handle.summary.id).toBe(target.summary.id);
    expect(readLeaseOwnerSync<SessionLeaseOwner>(result.lease.lockPath)?.instanceId).toBe(processInstanceId());
  });

  test("takeOver against a live holder is refused", () => {
    const target = makeSession("live");
    const holder = plantHolder(target.summary.id);
    expect(() => openLeasedSession({ cwd, dataDir, resumeId: target.summary.id, takeOver: true })).toThrow(
      /--take-over is refused; use --fork/,
    );
    expect(readLeaseOwnerSync(sessionLeasePath(cwd, target.summary.id, dataDir))?.token).toBe(holder.token);
  });

  test("a gone holder is reclaimed silently on resume", () => {
    const target = makeSession("gone");
    const old = new Date(Date.now() - 60_000).toISOString();
    plantHolder(target.summary.id, { heartbeatAt: old, host: "another-host" });
    const result = track(openLeasedSession({ cwd, dataDir, resumeId: target.summary.id }));
    expect(result.handle.summary.id).toBe(target.summary.id);
  });

  test("fork opens a new id and leases it, leaving the held source alone", () => {
    const source = makeSession("source");
    const holder = plantHolder(source.summary.id);
    const result = track(openLeasedSession({ cwd, dataDir, resumeId: source.summary.id, fork: true }));
    expect(result.handle.summary.id).not.toBe(source.summary.id);
    expect(result.handle.summary.parentSessionId).toBe(source.summary.id);
    expect(sessionLeaseState(cwd, result.handle.summary.id, dataDir).state).toBe("mine");
    expect(readLeaseOwnerSync(sessionLeasePath(cwd, source.summary.id, dataDir))?.token).toBe(holder.token);
  });

  test("re-opening a session this process holds returns the same handle", () => {
    const first = track(openLeasedSession({ cwd, dataDir }));
    const again = openLeasedSession({ cwd, dataDir, resumeId: first.handle.summary.id });
    expect(again.lease).toBe(first.lease);
  });

  test("an unknown resumeId raises the store's error and leases nothing", () => {
    expect(() => openLeasedSession({ cwd, dataDir, resumeId: "nope" })).toThrow(/No session matching/);
  });
});

describe("lease handle lifecycle", () => {
  test("the heartbeat timer is unref'd, and release is idempotent", () => {
    const result = openLeasedSession({ cwd, dataDir });
    const timer = result.lease.heartbeatTimer as unknown as { hasRef(): boolean } | undefined;
    expect(timer).toBeDefined();
    expect(timer?.hasRef()).toBe(false);

    const lockPath = result.lease.lockPath;
    const exitHooks = process.listenerCount("exit");
    releaseSessionLease(result.lease);
    releaseSessionLease(result.lease);
    result.lease.release();
    expect(result.lease.released).toBe(true);
    expect(result.lease.heartbeatTimer).toBeUndefined();
    expect(process.listenerCount("exit")).toBe(exitHooks - 1);
    expect(() => statSync(lockPath)).toThrow();
    expect(sessionLeaseState(cwd, result.handle.summary.id, dataDir).state).toBe("free");
  });

  test("the heartbeat refreshes heartbeatAt on its interval", async () => {
    const result = track(openLeasedSession({ cwd, dataDir, heartbeatMs: 20 }));
    const first = result.lease.owner.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const onDisk = readLeaseOwnerSync<SessionLeaseOwner>(result.lease.lockPath);
    expect(onDisk?.heartbeatAt).not.toBe(first);
    expect(onDisk?.acquiredAt).toBe(result.lease.owner.acquiredAt);
  });

  test("refresh merges a name patch", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    expect(result.lease.refresh({ name: "alpha" })).toBe(true);
    expect(readLeaseOwnerSync<SessionLeaseOwner>(result.lease.lockPath)?.name).toBe("alpha");
  });
});

describe("switchLeasedSession", () => {
  test("acquires the target before releasing the current lease", () => {
    const current = openLeasedSession({ cwd, dataDir });
    const target = makeSession("target");
    let currentHeldDuringAcquire: boolean | undefined;

    const next = track(
      switchLeasedSession(current.lease, () => {
        const got = openLeasedSession({ cwd, dataDir, resumeId: target.summary.id });
        currentHeldDuringAcquire = !current.lease.released;
        return got;
      }),
    );
    expect(currentHeldDuringAcquire).toBe(true);
    expect(next.handle.summary.id).toBe(target.summary.id);
    expect(current.lease.released).toBe(true);
    expect(sessionLeaseState(cwd, current.handle.summary.id, dataDir).state).toBe("free");
    expect(sessionLeaseState(cwd, target.summary.id, dataDir).state).toBe("mine");
  });

  test("on refusal it rethrows and keeps the current lease", () => {
    const current = track(openLeasedSession({ cwd, dataDir }));
    const target = makeSession("held-elsewhere");
    plantHolder(target.summary.id);

    expect(() =>
      switchLeasedSession(current.lease, () => openLeasedSession({ cwd, dataDir, resumeId: target.summary.id })),
    ).toThrow(SessionLeasedError);
    expect(current.lease.released).toBe(false);
    expect(sessionLeaseState(cwd, current.handle.summary.id, dataDir).state).toBe("mine");
  });

  test("switching to the session already held releases nothing", () => {
    const current = track(openLeasedSession({ cwd, dataDir }));
    const next = switchLeasedSession(current.lease, () =>
      openLeasedSession({ cwd, dataDir, resumeId: current.handle.summary.id }),
    );
    expect(next.lease).toBe(current.lease);
    expect(current.lease.released).toBe(false);
  });
});

/** Another instance takes the lease: the directory is replaced, as a take-over does. */
function takeOverOnDisk(sessionId: string): SessionLeaseOwner {
  rmSync(sessionLeasePath(cwd, sessionId, dataDir), { recursive: true, force: true });
  return plantHolder(sessionId);
}

describe("a lost lease (review F1)", () => {
  test("the heartbeat notices a take-over: lost flips, onLost fires once, the heartbeat stops", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    const fired: string[] = [];
    result.lease.onLost(() => fired.push("a"));
    expect(result.lease.lost).toBe(false);

    const rival = takeOverOnDisk(result.handle.summary.id);
    // What the heartbeat timer runs, invoked directly instead of waiting for it.
    expect(result.lease.refresh()).toBe(false);
    expect(result.lease.refresh()).toBe(false);

    expect(result.lease.lost).toBe(true);
    expect(result.lease.lostTo?.token).toBe(rival.token);
    expect(fired).toEqual(["a"]);
    expect(result.lease.heartbeatTimer).toBeUndefined();
    // A late subscriber hears about it at once, and only once.
    result.lease.onLost(() => fired.push("late"));
    expect(fired).toEqual(["a", "late"]);
  });

  test("checkLost catches a take-over at the write, before any heartbeat", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    expect(result.lease.checkLost()).toBe(false);
    takeOverOnDisk(result.handle.summary.id);
    expect(result.lease.checkLost()).toBe(true);
    expect(result.lease.heartbeatTimer).toBeUndefined();
  });

  test("a vanished lease directory is a loss too", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    rmSync(result.lease.lockPath, { recursive: true, force: true });
    expect(result.lease.checkLost()).toBe(true);
    expect(result.lease.lostTo).toBeUndefined();
    expect(describeLeaseLoss(result.lease)).toContain("taken over by another instance");
  });

  test("a lost lease is not released: the new holder's lease stays on disk", () => {
    const result = openLeasedSession({ cwd, dataDir });
    const rival = takeOverOnDisk(result.handle.summary.id);
    expect(result.lease.checkLost()).toBe(true);
    result.lease.release();
    expect(readLeaseOwnerSync(sessionLeasePath(cwd, result.handle.summary.id, dataDir))?.token).toBe(rival.token);
  });

  test("a lost handle is not reused: re-opening the session is refused against the new holder", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    takeOverOnDisk(result.handle.summary.id);
    expect(result.lease.checkLost()).toBe(true);
    expect(() => openLeasedSession({ cwd, dataDir, resumeId: result.handle.summary.id })).toThrow(SessionLeasedError);
  });

  test("the operator line names the session, the holder, and the way out", () => {
    const result = track(openLeasedSession({ cwd, dataDir }));
    const rival = takeOverOnDisk(result.handle.summary.id);
    result.lease.checkLost();
    const short = shortSessionId(result.handle.summary.id);
    const line = describeLeaseLoss(result.lease);
    expect(line).toContain(`session ${short} was taken over by instance ${rival.instanceId.slice(0, 8)} (pid 424242)`);
    expect(line).toContain("this shell no longer saves it");
    expect(line).toContain(`Use /new, or restart with -r ${short} --fork to keep your turns.`);
  });

  test("watchLeaseLoss: canPersist turns false, notify fires once, and a new lease is watched afresh", () => {
    const first = track(openLeasedSession({ cwd, dataDir }));
    const notes: string[] = [];
    const watch = watchLeaseLoss((message) => notes.push(message));
    watch.track(first.lease);
    expect(watch.canPersist()).toBe(true);

    takeOverOnDisk(first.handle.summary.id);
    expect(watch.canPersist()).toBe(false);
    expect(watch.canPersist()).toBe(false);
    expect(notes.length).toBe(1);

    const second = track(openLeasedSession({ cwd, dataDir }));
    watch.track(second.lease);
    expect(watch.canPersist()).toBe(true);
    watch.track(undefined);
    expect(watch.canPersist()).toBe(true);
    expect(notes.length).toBe(1);
  });
});

describe("openLeasedSession error path (review F4)", () => {
  test("a failed re-open of the session this process holds keeps its lease", () => {
    const current = track(openLeasedSession({ cwd, dataDir }));
    const id = current.handle.summary.id;
    // An unreadable transcript: a directory where context.jsonl should be.
    rmSync(path.join(current.handle.dir, "context.jsonl"), { force: true });
    mkdirSync(path.join(current.handle.dir, "context.jsonl"));

    expect(() => openLeasedSession({ cwd, dataDir, resumeId: id })).toThrow(/could not be read/);
    expect(current.lease.released).toBe(false);
    expect(sessionLeaseState(cwd, id, dataDir).state).toBe("mine");
  });

  test("a failed open of another session releases the lease that call took", () => {
    const target = makeSession("unreadable");
    rmSync(path.join(target.dir, "context.jsonl"), { force: true });
    mkdirSync(path.join(target.dir, "context.jsonl"));
    expect(() => openLeasedSession({ cwd, dataDir, resumeId: target.summary.id })).toThrow(/could not be read/);
    expect(sessionLeaseState(cwd, target.summary.id, dataDir).state).toBe("free");
  });
});

describe("test-only timing knobs (review F5)", () => {
  const KEYS = ["NODE_ENV", "KERYX_TEST_LEASE_TIMING", "KERYX_SESSION_LEASE_STALE_MS", "KERYX_SESSION_LEASE_HEARTBEAT_MS"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  function setEnv(values: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  test("honoured in a test context within bounds", () => {
    setEnv({ NODE_ENV: "test", KERYX_SESSION_LEASE_STALE_MS: "600", KERYX_SESSION_LEASE_HEARTBEAT_MS: "150" });
    const timing = resolveSessionLeaseTiming();
    expect(timing.staleMs).toBe(600);
    expect(timing.heartbeatMs).toBe(150);
  });

  test("a staleMs below 250 is ignored", () => {
    setEnv({ NODE_ENV: "test", KERYX_SESSION_LEASE_STALE_MS: "1", KERYX_SESSION_LEASE_HEARTBEAT_MS: undefined });
    expect(resolveSessionLeaseTiming().staleMs).toBe(SESSION_LEASE_STALE_MS);
    expect(resolveSessionLeaseTiming().heartbeatMs).toBe(SESSION_LEASE_HEARTBEAT_MS);
  });

  test("a heartbeat above staleMs / 3 or below 50 is ignored, and the default never exceeds staleMs / 3", () => {
    setEnv({ NODE_ENV: "test", KERYX_SESSION_LEASE_STALE_MS: "600", KERYX_SESSION_LEASE_HEARTBEAT_MS: "5000" });
    expect(resolveSessionLeaseTiming().heartbeatMs).toBe(200);
    setEnv({ KERYX_SESSION_LEASE_HEARTBEAT_MS: "10" });
    expect(resolveSessionLeaseTiming().heartbeatMs).toBe(200);
  });

  test("ignored outside a test context; KERYX_TEST_LEASE_TIMING=1 opts in", () => {
    setEnv({
      NODE_ENV: "production",
      KERYX_TEST_LEASE_TIMING: undefined,
      KERYX_SESSION_LEASE_STALE_MS: "600",
      KERYX_SESSION_LEASE_HEARTBEAT_MS: "150",
    });
    expect(resolveSessionLeaseTiming().staleMs).toBe(SESSION_LEASE_STALE_MS);
    expect(resolveSessionLeaseTiming().heartbeatMs).toBe(SESSION_LEASE_HEARTBEAT_MS);
    setEnv({ KERYX_TEST_LEASE_TIMING: "1" });
    expect(resolveSessionLeaseTiming().staleMs).toBe(600);
  });

  test("explicit options still win", () => {
    setEnv({ NODE_ENV: "test", KERYX_SESSION_LEASE_STALE_MS: "600", KERYX_SESSION_LEASE_HEARTBEAT_MS: "150" });
    expect(resolveSessionLeaseTiming({ staleMs: 30, heartbeatMs: 7 })).toMatchObject({ staleMs: 30, heartbeatMs: 7 });
  });
});
