import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory, sessionDir } from ".";
import { sessionLeasePath } from "./lease";
import { readSessionFlags, setSessionFlags, trashDirectory, trashSession } from "./organize";

function project(): { cwd: string; dataDir: string; home: string } {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-organize-"));
  return { cwd: root, dataDir: path.join(root, "data"), home: path.join(root, "home") };
}

function stored(cwd: string, dataDir: string): string {
  const handle = createSession({ cwd, dataDir, provider: "test", model: "m" });
  persistHistory(handle, [{ role: "user", content: "hi" }], { provider: "test", model: "m" });
  return handle.summary.id;
}

describe("session flags", () => {
  test("archive and pin are stored beside the summary and survive a later save", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const t1 = new Date("2026-11-17T10:00:00Z");
    expect(setSessionFlags(cwd, id, { archived: true, pinned: true }, dataDir, () => t1)).toEqual({
      archivedAt: t1.toISOString(),
      pinnedAt: t1.toISOString(),
    });
    // A flag already set keeps its first time.
    const t2 = new Date("2026-11-18T10:00:00Z");
    expect(setSessionFlags(cwd, id, { pinned: true }, dataDir, () => t2).pinnedAt).toBe(t1.toISOString());

    const handle = createSession({ cwd, dataDir, id, provider: "test", model: "m" });
    persistHistory(handle, [{ role: "user", content: "again" }], { provider: "test", model: "m" });
    expect(readSessionFlags(sessionDir(cwd, id, dataDir)).archivedAt).toBe(t1.toISOString());

    expect(setSessionFlags(cwd, id, { archived: false, pinned: false }, dataDir)).toEqual({});
  });

  test("an unreadable flags file reads as none; an unknown session is refused", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    writeFileSync(path.join(sessionDir(cwd, id, dataDir), "flags.json"), "{not json");
    expect(readSessionFlags(sessionDir(cwd, id, dataDir))).toEqual({});
    expect(() => setSessionFlags(cwd, "no-such-session", { archived: true }, dataDir)).toThrow(/no session/);
  });
});

describe("trash", () => {
  test("macOS: the session folder moves to ~/.Trash under a free name", () => {
    const { cwd, dataDir, home } = project();
    const a = stored(cwd, dataDir);
    const dir = sessionDir(cwd, a, dataDir);
    const to = trashSession(cwd, a, { dataDir, platform: "darwin", home });
    expect(path.dirname(to)).toBe(path.join(home, ".Trash"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(to, "summary.json"))).toBe(true);
  });

  test("Linux: freedesktop trash with an info file naming where it was", () => {
    const { cwd, dataDir, home } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const to = trashSession(cwd, id, { dataDir, platform: "linux", home, env: {} });
    const info = readFileSync(path.join(home, ".local/share/Trash/info", `${path.basename(to)}.trashinfo`), "utf8");
    expect(info).toContain(`Path=${encodeURI(dir)}`);
    expect(trashDirectory("win32", home, {})).toBeUndefined();
  });

  test("refused while another keryx holds the session; the folder stays", () => {
    const { cwd, dataDir, home } = project();
    const id = stored(cwd, dataDir);
    // Another live instance's lease, as lease.test.ts plants one.
    const at = new Date().toISOString();
    const lockPath = sessionLeasePath(cwd, id, dataDir);
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ schemaVersion: 1, token: randomUUID(), pid: process.pid, host: hostname(), instanceId: randomUUID(), name: null, acquiredAt: at, heartbeatAt: at }),
      { mode: 0o600 },
    );
    expect(() => trashSession(cwd, id, { dataDir, platform: "darwin", home })).toThrow(/another keryx/);
    expect(existsSync(sessionDir(cwd, id, dataDir))).toBe(true);
  });
});
