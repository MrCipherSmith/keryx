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

  test("a flow link is stored, replaced and cleared; a path-like name is refused", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    expect(setSessionFlags(cwd, id, { flow: "495-2026-11-17-live-cards" }, dataDir).flow).toBe("495-2026-11-17-live-cards");
    expect(setSessionFlags(cwd, id, { pinned: true }, dataDir).flow).toBe("495-2026-11-17-live-cards");
    expect(setSessionFlags(cwd, id, { flow: null }, dataDir).flow).toBeUndefined();
    for (const bad of ["../etc", "a/b", "-x", "a b", ""]) {
      expect(() => setSessionFlags(cwd, id, { flow: bad }, dataDir)).toThrow(/not a flow package name/);
    }
  });

  test("a PR subject is stored, survives a restart re-read and later saves, and null unlinks it", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const subject = { kind: "pr" as const, repo: "Org/Repo.name", number: 42, url: "https://github.com/Org/Repo.name/pull/42", repositoryId: "R_kgDOabc" };
    expect(setSessionFlags(cwd, id, { subject, pinned: true }, dataDir).subject).toEqual(subject);
    // A fresh read of flags.json, as a restarted keryx does.
    expect(readSessionFlags(sessionDir(cwd, id, dataDir)).subject).toEqual(subject);
    // Another flag change and a later save of the session keep it.
    expect(setSessionFlags(cwd, id, { pinned: false }, dataDir).subject).toEqual(subject);
    const handle = createSession({ cwd, dataDir, id, provider: "test", model: "m" });
    persistHistory(handle, [{ role: "user", content: "again" }], { provider: "test", model: "m" });
    expect(readSessionFlags(sessionDir(cwd, id, dataDir)).subject).toEqual(subject);

    const issue = { kind: "issue" as const, repo: "org/repo", number: 7, url: "https://github.com/org/repo/issues/7" };
    expect(setSessionFlags(cwd, id, { subject: issue }, dataDir).subject).toEqual(issue);
    expect(setSessionFlags(cwd, id, { subject: null }, dataDir).subject).toBeUndefined();
    expect(readSessionFlags(sessionDir(cwd, id, dataDir))).toEqual({});
  });

  test("an invalid subject is refused on write and the stored one is kept", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const good = { kind: "pr", repo: "org/repo", number: 1, url: "https://github.com/org/repo/pull/1" };
    setSessionFlags(cwd, id, { subject: good as never }, dataDir);
    const bad: unknown[] = [
      "org/repo#1",
      { ...good, kind: "commit" },
      { ...good, url: "https://github.com/org/repo/issues/1" },
      { ...good, url: "http://github.com/org/repo/pull/1" },
      { ...good, url: "https://evil.example/org/repo/pull/1" },
      { ...good, url: "https://github.com/org/other/pull/1" },
      { ...good, url: "https://github.com/org/repo/pull/2" },
      { ...good, number: 0, url: "https://github.com/org/repo/pull/0" },
      { ...good, number: 1.5 },
      { ...good, repo: "org" },
      { ...good, repo: "../x/y", url: "https://github.com/../x/y/pull/1" },
      { ...good, repo: "org/re po" },
      { ...good, repositoryId: 5 },
      { ...good, repositoryId: "" },
    ];
    for (const subject of bad) {
      expect(() => setSessionFlags(cwd, id, { subject: subject as never }, dataDir)).toThrow(/not a GitHub subject/);
    }
    expect(readSessionFlags(sessionDir(cwd, id, dataDir)).subject).toEqual(good as never);
  });

  test("an invalid subject in flags.json reads as absent and leaves the other flags", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const file = path.join(sessionDir(cwd, id, dataDir), "flags.json");
    writeFileSync(file, JSON.stringify({ pinnedAt: "2026-11-17T10:00:00.000Z", subject: { kind: "pr", repo: "org/repo", number: 3, url: "https://github.com/org/repo/issues/3" } }));
    expect(readSessionFlags(sessionDir(cwd, id, dataDir))).toEqual({ pinnedAt: "2026-11-17T10:00:00.000Z" });
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
