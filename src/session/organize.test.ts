import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory, sessionDir } from ".";
import { LOCK_RETRY_MS } from "../lib/file-lock";
import { sessionLeasePath } from "./lease";
import {
  type SessionFlags,
  backfillSessionSubject,
  readSessionFlags,
  sessionSubjectSettled,
  setSessionFlags,
  setSessionFlagsAsync,
  trashDirectory,
  trashSession,
  updateSessionFlagsAt,
  updateSessionFlagsAtAsync,
} from "./organize";

const ORGANIZE = path.join(import.meta.dir, "organize.ts");

type Child = ReturnType<typeof spawnScript>;

/** A keryx-side writer in its own process, as another Desktop window's ACP server or the issue-workspace child is. */
function spawnScript(script: string) {
  return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
}

/** Resolves once `file` exists: the barrier a child writes. Fails instead of waiting forever when the child exits first. */
async function until(file: string, child: Child): Promise<void> {
  while (!existsSync(file)) {
    if (child.exitCode !== null) throw new Error(`the writer exited (${child.exitCode}) before ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

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
    expect(setSessionFlags(cwd, id, { archived: true, pinned: true }, dataDir, { now: () => t1 })).toEqual({
      archivedAt: t1.toISOString(),
      pinnedAt: t1.toISOString(),
    });
    // A flag already set keeps its first time.
    const t2 = new Date("2026-11-18T10:00:00Z");
    expect(setSessionFlags(cwd, id, { pinned: true }, dataDir, { now: () => t2 }).pinnedAt).toBe(t1.toISOString());

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
      // Consistent repo and url, so only REPO_REF can refuse them: `..` is not a name, a space is not in the charset.
      { ...good, repo: "org/..", url: "https://github.com/org/../pull/1" },
      { ...good, repo: "org/.", url: "https://github.com/org/./pull/1" },
      { ...good, repo: "org/re po", url: "https://github.com/org/re po/pull/1" },
      { ...good, repositoryId: 5 },
      { ...good, repositoryId: "" },
    ];
    for (const subject of bad) {
      expect(() => setSessionFlags(cwd, id, { subject: subject as never }, dataDir)).toThrow(/not a GitHub subject/);
    }
    expect(readSessionFlags(sessionDir(cwd, id, dataDir)).subject).toEqual(good as never);
  });

  test("a subject's repo and url agree without case, and fields the store does not know are dropped", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const mixed = { kind: "pr" as const, repo: "org/repo", number: 1, url: "https://github.com/Org/Repo/pull/1" };
    expect(setSessionFlags(cwd, id, { subject: mixed }, dataDir).subject).toEqual(mixed);
    const extra = { ...mixed, title: "client text", flow: "x" };
    const kept = setSessionFlags(cwd, id, { subject: extra as never }, dataDir).subject;
    expect(kept).toEqual(mixed);
    const raw = JSON.parse(readFileSync(path.join(sessionDir(cwd, id, dataDir), "flags.json"), "utf8"));
    expect(Object.keys(raw.subject).sort()).toEqual(["kind", "number", "repo", "url"]);
  });

  test("an unlinked subject is not backfilled; a session that never had one is", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const issue = { kind: "issue" as const, repo: "org/repo", number: 7, url: "https://github.com/org/repo/issues/7" };
    expect(backfillSessionSubject(dir, issue)).toBe(true);
    expect(readSessionFlags(dir).subject).toEqual(issue);
    // Present already: left as it is.
    expect(backfillSessionSubject(dir, { ...issue, number: 8, url: "https://github.com/org/repo/issues/8" })).toBe(false);
    expect(readSessionFlags(dir).subject).toEqual(issue);
    // Unlinked by the person: the marker survives other flag changes and blocks the backfill.
    setSessionFlags(cwd, id, { subject: null }, dataDir);
    setSessionFlags(cwd, id, { pinned: true }, dataDir);
    expect(backfillSessionSubject(dir, issue)).toBe(false);
    expect(readSessionFlags(dir).subject).toBeUndefined();
    // The marker stays private to the store.
    expect(readSessionFlags(dir)).toEqual({ pinnedAt: expect.any(String) });
    // Linking again clears the marker.
    setSessionFlags(cwd, id, { subject: issue }, dataDir);
    setSessionFlags(cwd, id, { subject: null }, dataDir);
    setSessionFlags(cwd, id, { subject: issue }, dataDir);
    expect(JSON.parse(readFileSync(path.join(dir, "flags.json"), "utf8")).subjectUnlinked).toBeUndefined();
  });

  test("a flags change waits for a writer in another process and lands after its change", async () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const barrier = mkdtempSync(path.join(tmpdir(), "keryx-organize-barrier-"));
    const held = path.join(barrier, "held");
    const go = path.join(barrier, "go");
    // The other writer holds the flags lock across a read-modify-write: it reads, says so, waits for `go`, then writes what it read plus its change.
    const child = spawnScript(`
      const { existsSync, writeFileSync } = await import("node:fs");
      const { withFileLock } = await import(${JSON.stringify(path.join(import.meta.dir, "../lib/file-lock.ts"))});
      const { readSessionFlags } = await import(${JSON.stringify(ORGANIZE)});
      const done = withFileLock(${JSON.stringify(path.join(dir, "flags.json.lock"))}, () => {
        const seen = readSessionFlags(${JSON.stringify(dir)});
        writeFileSync(${JSON.stringify(held)}, "");
        while (!existsSync(${JSON.stringify(go)})) Bun.sleepSync(2);
        writeFileSync(${JSON.stringify(path.join(dir, "flags.json"))}, JSON.stringify({ ...seen, flow: "child-flow" }));
        return true;
      }, { createDir: false, timeoutMs: 30_000 });
      if (done !== true) process.exit(3);`);
    let change: Promise<SessionFlags>;
    try {
      await until(held, child);
      // The change starts while the lock is held: its first attempt fails before `go` is written.
      change = setSessionFlagsAsync(cwd, id, { pinned: true }, dataDir, { timing: { timeoutMs: 30_000, staleMs: 30_000 } });
    } finally {
      writeFileSync(go, "");
    }
    const flags = await change;
    expect(await child.exited).toBe(0);
    // An unlocked writer would have landed before the child's write, which then rolled it back.
    expect(flags).toEqual({ flow: "child-flow", pinnedAt: expect.any(String) });
    expect(readSessionFlags(dir)).toEqual(flags);
  }, 30_000);

  test("two async changes to one session apply in the order they were called, even when the later one would take the lock first", async () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const lock = path.join(dir, "flags.json.lock");
    writeFileSync(lock, "another-writer");
    const wait = { timing: { timeoutMs: 30_000, staleMs: 60_000 } };
    const pin = setSessionFlagsAsync(cwd, id, { pinned: true }, dataDir, wait);
    // The holder lets go between the pin's first retry, which still finds the lock held, and the unpin's first retry
    // (timers of one delay fire in the order they were set). Each racing on its own timer, the unpin would take the
    // lock first and the pin would land over it.
    const released = new Promise<void>((resolve) => setTimeout(() => {
      rmSync(lock);
      resolve();
    }, LOCK_RETRY_MS));
    const unpin = setSessionFlagsAsync(cwd, id, { pinned: false }, dataDir, wait);
    await released;
    expect((await pin).pinnedAt).toBeDefined();
    expect(await unpin).toEqual({});
    expect(readSessionFlags(dir)).toEqual({});
  });

  test("a flags change held off past its timeout fails with the retry error and leaves the other writer's lock", async () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const lock = path.join(dir, "flags.json.lock");
    writeFileSync(lock, "another-writer");
    const held = { timeoutMs: 20, staleMs: 60_000 };
    const locked = /the flags of session .+ are locked by another keryx process; retry/;
    expect(() => setSessionFlags(cwd, id, { pinned: true }, dataDir, { timing: held })).toThrow(locked);
    await expect(setSessionFlagsAsync(cwd, id, { pinned: true }, dataDir, { timing: held })).rejects.toThrow(locked);
    expect(readSessionFlags(dir)).toEqual({});
    expect(readFileSync(lock, "utf8")).toBe("another-writer");
    // A refused write does not hold up the next one queued for the session.
    rmSync(lock);
    expect((await setSessionFlagsAsync(cwd, id, { pinned: true }, dataDir, { timing: held })).pinnedAt).toBeDefined();
  });

  test("a flags lock older than the stale window is taken over and the change lands", async () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const lock = path.join(dir, "flags.json.lock");
    const stale = { timeoutMs: 30_000, staleMs: 1 };
    writeFileSync(lock, "crashed-writer");
    expect(setSessionFlags(cwd, id, { pinned: true }, dataDir, { timing: stale }).pinnedAt).toBeDefined();
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "crashed-writer");
    expect(await setSessionFlagsAsync(cwd, id, { flow: "001-x" }, dataDir, { timing: stale })).toMatchObject({ flow: "001-x", pinnedAt: expect.any(String) });
    expect(existsSync(lock)).toBe(false);
  });

  test("a subject backfill runs under the flags lock", () => {
    const { cwd, dataDir } = project();
    const dir = sessionDir(cwd, stored(cwd, dataDir), dataDir);
    writeFileSync(path.join(dir, "flags.json.lock"), "another-writer");
    const issue = { kind: "issue" as const, repo: "org/repo", number: 7, url: "https://github.com/org/repo/issues/7" };
    expect(() => backfillSessionSubject(dir, issue, { timing: { timeoutMs: 20, staleMs: 60_000 } })).toThrow(/locked by another keryx process; retry/);
    expect(readSessionFlags(dir).subject).toBeUndefined();
  });

  test("a backfill of an invalid subject is refused and writes nothing", () => {
    const { cwd, dataDir } = project();
    const dir = sessionDir(cwd, stored(cwd, dataDir), dataDir);
    const mismatched = { kind: "issue", repo: "org/repo", number: 7, url: "https://github.com/org/other/issues/7" };
    expect(() => backfillSessionSubject(dir, mismatched as never)).toThrow(/not a GitHub subject/);
    expect(existsSync(path.join(dir, "flags.json"))).toBe(false);
  });

  test("a flags write to a session removed since it was located is refused and does not bring it back", async () => {
    const { cwd, dataDir } = project();
    const issue = { kind: "issue" as const, repo: "org/repo", number: 7, url: "https://github.com/org/repo/issues/7" };
    // A short timeout: a missing directory must fail as missing, not wait out the lock and say "retry".
    const quick = { timeoutMs: 200, staleMs: 60_000 };
    const gone = /^no session .+ in this project$/;
    // The directory is gone (moved to the trash): no write site may recreate it.
    const trashed = sessionDir(cwd, stored(cwd, dataDir), dataDir);
    rmSync(trashed, { recursive: true });
    expect(() => updateSessionFlagsAt(trashed, { pinned: true }, { timing: quick })).toThrow(gone);
    await expect(updateSessionFlagsAtAsync(trashed, { pinned: true }, { timing: quick })).rejects.toThrow(gone);
    expect(() => backfillSessionSubject(trashed, issue, { timing: quick })).toThrow(gone);
    expect(existsSync(trashed)).toBe(false);
    // The directory is still there but its summary is not (a move half done): refused, and no flags file appears.
    const half = sessionDir(cwd, stored(cwd, dataDir), dataDir);
    rmSync(path.join(half, "summary.json"));
    expect(() => updateSessionFlagsAt(half, { pinned: true }, { timing: quick })).toThrow(gone);
    await expect(updateSessionFlagsAtAsync(half, { pinned: true }, { timing: quick })).rejects.toThrow(gone);
    expect(() => backfillSessionSubject(half, issue, { timing: quick })).toThrow(gone);
    expect(existsSync(path.join(half, "flags.json"))).toBe(false);
  });

  test("sessionSubjectSettled: a stored or unlinked subject is settled, none is not", () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    expect(sessionSubjectSettled(dir)).toBe(false);
    const issue = { kind: "issue" as const, repo: "org/repo", number: 7, url: "https://github.com/org/repo/issues/7" };
    setSessionFlags(cwd, id, { subject: issue }, dataDir);
    expect(sessionSubjectSettled(dir)).toBe(true);
    setSessionFlags(cwd, id, { subject: null }, dataDir);
    expect(sessionSubjectSettled(dir)).toBe(true);
  });

  test("a writer in another process mid read-modify-write excludes this one until it has written", async () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const barrier = mkdtempSync(path.join(tmpdir(), "keryx-organize-barrier-"));
    const read = path.join(barrier, "read");
    const go = path.join(barrier, "go");
    // The other process pauses its own updateSessionFlagsAt between its read and its write: `now` runs there.
    const child = spawnScript(`
      const { existsSync, writeFileSync } = await import("node:fs");
      const { updateSessionFlagsAt } = await import(${JSON.stringify(ORGANIZE)});
      updateSessionFlagsAt(${JSON.stringify(dir)}, { pinned: true }, { now: () => {
        writeFileSync(${JSON.stringify(read)}, "");
        while (!existsSync(${JSON.stringify(go)})) Bun.sleepSync(2);
        return new Date();
      }, timing: { timeoutMs: 30_000, staleMs: 60_000 } });`);
    try {
      await until(read, child);
      // Locked out while the other writer is between its read and its write. Unlocked, this write would land now
      // and the other writer's stale read would roll it back.
      expect(() => updateSessionFlagsAt(dir, { flow: "001-x" }, { timing: { timeoutMs: 20, staleMs: 60_000 } })).toThrow(/locked by another keryx process; retry/);
    } finally {
      writeFileSync(go, "");
    }
    expect(await child.exited).toBe(0);
    expect(readSessionFlags(dir)).toEqual({ pinnedAt: expect.any(String) });
    // Once it has written, the change lands beside it.
    expect(updateSessionFlagsAt(dir, { flow: "001-x" })).toEqual({ pinnedAt: expect.any(String), flow: "001-x" });
  }, 30_000);

  test("two processes changing different flags of one session lose neither change", async () => {
    const { cwd, dataDir } = project();
    const id = stored(cwd, dataDir);
    const dir = sessionDir(cwd, id, dataDir);
    const barrier = mkdtempSync(path.join(tmpdir(), "keryx-organize-barrier-"));
    const go = path.join(barrier, "go");
    const rounds = 200;
    // Each writer owns one field and checks, after every write, that the other writer did not roll it back.
    // Both start from the same barrier file, so their loops overlap from the first round.
    const writer = (field: "pinned" | "flow") => `
      const { existsSync, writeFileSync } = await import("node:fs");
      const { updateSessionFlagsAt, readSessionFlags } = await import(${JSON.stringify(ORGANIZE)});
      writeFileSync(${JSON.stringify(path.join(barrier, field))}, "");
      while (!existsSync(${JSON.stringify(go)})) Bun.sleepSync(1);
      let lost = 0;
      for (let i = 0; i < ${rounds}; i++) {
        ${field === "pinned"
          ? `const want = i % 2 === 0; updateSessionFlagsAt(${JSON.stringify(dir)}, { pinned: want });
             if ((readSessionFlags(${JSON.stringify(dir)}).pinnedAt !== undefined) !== want) lost++;`
          : `const want = "flow-" + i; updateSessionFlagsAt(${JSON.stringify(dir)}, { flow: want });
             if (readSessionFlags(${JSON.stringify(dir)}).flow !== want) lost++;`}
      }
      process.stdout.write(String(lost));`;
    const children = [spawnScript(writer("pinned")), spawnScript(writer("flow"))];
    try {
      await until(path.join(barrier, "pinned"), children[0]!);
      await until(path.join(barrier, "flow"), children[1]!);
    } finally {
      writeFileSync(go, "");
    }
    const lost = await Promise.all(children.map(async (child) => {
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return Number(out);
    }));
    expect(lost).toEqual([0, 0]);
    expect(readSessionFlags(dir)).toEqual({ flow: `flow-${rounds - 1}` });
  }, 30_000);

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
