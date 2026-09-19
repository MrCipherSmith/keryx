// `keryx sessions list` — the LIVE column and the `live` JSON field (flow 271, AC10).
//
// A session leased by a heartbeating shell reads `live`, one whose holder is on
// this host with a live pid but an old heartbeat reads `stale`, and an unleased
// one reads blank / null. The lease state is produced by writing `owner.json`
// directly, so no timer or second process is involved.
//
// Isolation: every test points `KERYX_DATA_DIR` at a fresh temp directory, so
// nothing here reads or writes the developer's real sessions.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSession, shortSessionId } from "../session";
import { SESSION_LEASE_STALE_MS, sessionLeasePath, type SessionLeaseOwner } from "../session/lease";
import { sessionsCommand } from "./sessions";

let dataDir: string;
let projectDir: string;
let previousDataDir: string | undefined;
let logged: string[];
let restoreLog: () => void;

function captureConsole(): () => void {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  return () => {
    console.log = originalLog;
  };
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-list-data-")));
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-list-proj-")));
  previousDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
  logged = [];
  restoreLog = captureConsole();
  process.exitCode = 0;
});

afterEach(() => {
  restoreLog();
  if (previousDataDir === undefined) {
    delete process.env.KERYX_DATA_DIR;
  } else {
    process.env.KERYX_DATA_DIR = previousDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  process.exitCode = 0;
});

function seedSession(title: string): string {
  return createSession({ cwd: projectDir, title, provider: "fake-provider", model: "fixture-model" }).summary.id;
}

/**
 * Lease `sessionId` for another instance: this host, a live pid (ours), a
 * foreign instance id so it never reads as `mine`, heartbeating `ageMs` ago.
 */
function leaseFor(sessionId: string, ageMs: number): void {
  const lockPath = sessionLeasePath(projectDir, sessionId);
  mkdirSync(lockPath, { recursive: true });
  const at = new Date(Date.now() - ageMs).toISOString();
  const owner: SessionLeaseOwner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    instanceId: randomUUID(),
    name: null,
    acquiredAt: at,
    heartbeatAt: at,
  };
  writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
}

async function runSessions(args: string[]): Promise<void> {
  const originalCwd = process.cwd();
  process.chdir(projectDir);
  try {
    await sessionsCommand(args);
  } finally {
    process.chdir(originalCwd);
  }
}

function seedThree(): { liveId: string; staleId: string; freeId: string } {
  const freeId = seedSession("nobody holds this");
  const staleId = seedSession("hung holder");
  const liveId = seedSession("open elsewhere");
  leaseFor(liveId, 0);
  leaseFor(staleId, SESSION_LEASE_STALE_MS * 4);
  return { liveId, staleId, freeId };
}

describe("keryx sessions list — LIVE (flow 271, AC10)", () => {
  test("the table shows live, stale and blank in the LIVE column", async () => {
    const { liveId, staleId, freeId } = seedThree();

    await runSessions(["list"]);

    const header = logged.find((line) => line.startsWith("ID"));
    expect(header).toBeDefined();
    const liveCol = (header as string).indexOf("LIVE");
    const modelCol = (header as string).indexOf("MODEL");
    expect(liveCol).toBeGreaterThan(0);
    expect(modelCol).toBeGreaterThan(liveCol);

    const cell = (id: string): string => {
      const row = logged.find((line) => line.startsWith(shortSessionId(id)));
      expect(row).toBeDefined();
      return (row as string).slice(liveCol, modelCol).trim();
    };
    expect(cell(liveId)).toBe("live");
    expect(cell(staleId)).toBe("stale");
    expect(cell(freeId)).toBe("");
  });

  test("--json carries live: \"live\" | \"stale\" | null on every row", async () => {
    const { liveId, staleId, freeId } = seedThree();

    await runSessions(["list", "--json"]);

    const payload = JSON.parse(logged.join("\n")) as { sessions: { id: string; live: unknown }[] };
    const live = new Map(payload.sessions.map((s) => [s.id, s.live]));
    expect(payload.sessions.length).toBe(3);
    expect(payload.sessions.every((s) => "live" in s)).toBe(true);
    expect(live.get(liveId)).toBe("live");
    expect(live.get(staleId)).toBe("stale");
    expect(live.get(freeId)).toBeNull();
  });

  test("an unreadable lease shows ? (null in --json) and does not fail the listing (review F6)", async () => {
    const { liveId } = seedThree();
    const brokenId = seedSession("unreadable lease");
    // ENOTDIR: the lease path resolves through a regular file.
    const blocker = path.join(projectDir, "not-a-dir");
    writeFileSync(blocker, "");
    symlinkSync(path.join(blocker, "active.lease"), sessionLeasePath(projectDir, brokenId));

    await runSessions(["list"]);
    const header = logged.find((line) => line.startsWith("ID")) as string;
    const liveCol = header.indexOf("LIVE");
    const modelCol = header.indexOf("MODEL");
    const cell = (id: string): string =>
      (logged.find((line) => line.startsWith(shortSessionId(id))) as string).slice(liveCol, modelCol).trim();
    expect(cell(brokenId)).toBe("?");
    expect(cell(liveId)).toBe("live");

    logged = [];
    await runSessions(["list", "--json"]);
    const payload = JSON.parse(logged.join("\n")) as { sessions: { id: string; live: unknown }[] };
    expect(payload.sessions.length).toBe(4);
    expect(payload.sessions.find((s) => s.id === brokenId)?.live).toBeNull();
    expect(process.exitCode).toBe(0);
  });

  test("help describes the LIVE column", async () => {
    await runSessions(["--help"]);
    expect(logged.join("\n")).toContain("LIVE");
  });
});
