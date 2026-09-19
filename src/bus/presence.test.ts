import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBusRefusal } from "./errors";
import { presenceDir, presencePath } from "./paths";
import { allocateName, classifyPresence, listPresence, readPresence, writePresence } from "./presence";
import type { PresenceRecord } from "./schema";

// AC6: atomic 0600 records in 0700 directories, D-09 classification, D-06 names.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-presence-"));
  ROOTS.push(dir);
  return path.join(dir, "bus", "root");
}

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const T0 = Date.parse("2026-09-19T10:00:00.000Z");

function record(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId: A,
    name: "agent-1",
    pid: 4242,
    host: "this-host",
    sessionId: B,
    checkout: "/repo",
    branch: "main",
    surface: "tui",
    status: "idle",
    activity: "flow 272 task 6",
    startedAt: new Date(T0).toISOString(),
    heartbeatAt: new Date(T0).toISOString(),
    keryxVersion: "0.2.121",
    ...overrides,
  };
}

const mode = async (target: string): Promise<number> => (await stat(target)).mode & 0o777;

describe("writePresence / readPresence / listPresence", () => {
  test("writes 0600 in 0700 directories and reads it back", async () => {
    const root = await busRoot();
    await writePresence(root, record());

    if (process.platform !== "win32") {
      expect(await mode(root)).toBe(0o700);
      expect(await mode(presenceDir(root))).toBe(0o700);
      expect(await mode(presencePath(root, A))).toBe(0o600);
    }
    expect(await readPresence(root, A)).toEqual(record());
    // Atomic: no temp file is left beside the record.
    expect(await readdir(presenceDir(root))).toEqual([`${A}.json`]);
  });

  test("redacts and bounds activity", async () => {
    const root = await busRoot();
    const secret = "ghp_" + "a".repeat(36);
    const written = await writePresence(root, record({ activity: `token ${secret} ${"x".repeat(200)}` }));
    expect(written.activity).not.toContain(secret);
    expect(written.activity.length).toBeLessThanOrEqual(120);
    expect((await readPresence(root, A))?.activity).toBe(written.activity);
  });

  test("refuses a non-UUID instanceId before any path is built, and a reserved name", async () => {
    const root = await busRoot();
    let caught: unknown;
    try {
      await writePresence(root, record({ instanceId: "../../escape" }));
    } catch (error) {
      caught = error;
    }
    expect(isBusRefusal(caught, "invalid-id")).toBe(true);
    await expect(writePresence(root, record({ name: "system" }))).rejects.toThrow(/invalid-presence/);
    expect(await readdir(path.dirname(path.dirname(root)))).toEqual([]);
  });

  test("list skips invalid, torn, foreign and mismatched files without throwing", async () => {
    const root = await busRoot();
    await writePresence(root, record());
    await writePresence(root, record({ instanceId: B, name: "release" }));
    const dir = presenceDir(root);
    const third = "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f";
    await writeFile(path.join(dir, `${third}.json`), '{"schemaVersion":1,"instanceId"', "utf8");
    await writeFile(path.join(dir, "notes.txt"), "x", "utf8");
    const fourth = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    await writeFile(path.join(dir, `${fourth}.json`), JSON.stringify(record({ instanceId: A })), "utf8");
    await writeFile(path.join(dir, `${"5".repeat(8)}-5555-4555-8555-${"5".repeat(12)}.json`), JSON.stringify({ ...record(), schemaVersion: 2 }), "utf8");

    expect((await listPresence(root)).map((r) => r.name)).toEqual(["agent-1", "release"]);
    expect(await listPresence(path.join(root, "missing"))).toEqual([]);
    expect(await readPresence(root, "not-a-uuid")).toBeUndefined();
  });
});

describe("classifyPresence (D-09)", () => {
  const opts = { host: "this-host", isAlive: (pid: number) => pid === 4242 };

  test("live within 15 s of the heartbeat, whatever the pid", () => {
    expect(classifyPresence(record(), { ...opts, now: T0 + 15_000 })).toBe("live");
    expect(classifyPresence(record({ pid: 1 }), { ...opts, now: T0 + 1_000 })).toBe("live");
  });

  test("stale when older, on this host, with the pid alive", () => {
    expect(classifyPresence(record(), { ...opts, now: T0 + 15_001 })).toBe("stale");
  });

  test("gone when older and the pid is dead or the host differs", () => {
    expect(classifyPresence(record({ pid: 7 }), { ...opts, now: T0 + 60_000 })).toBe("gone");
    expect(classifyPresence(record({ host: "other" }), { ...opts, now: T0 + 60_000 })).toBe("gone");
  });

  test("staleMs is injectable", () => {
    expect(classifyPresence(record(), { ...opts, now: T0 + 2_000, staleMs: 1_000 })).toBe("stale");
  });
});

describe("allocateName (D-06)", () => {
  test("agent-<n> with the lowest free n by default", () => {
    expect(allocateName(undefined, [])).toBe("agent-1");
    expect(allocateName(undefined, ["agent-1", "agent-3"])).toBe("agent-2");
  });

  test("a requested name held by a live instance becomes <name>-2, then -3", () => {
    expect(allocateName("release", [])).toBe("release");
    expect(allocateName("release", ["release"])).toBe("release-2");
    expect(allocateName("release", ["release", "release-2"])).toBe("release-3");
  });

  test("the suffix still fits the 32-character rule", () => {
    const long = "a".repeat(32);
    const name = allocateName(long, [long]);
    expect(name).toBe(`${"a".repeat(30)}-2`);
    expect(name.length).toBe(32);
  });

  test("reserved and malformed requests are refused", () => {
    for (const name of ["all", "cli", "system"]) {
      expect(() => allocateName(name, [])).toThrow(/reserved-name/);
    }
    expect(() => allocateName("Bad Name", [])).toThrow(/invalid-name/);
  });
});
