// Shell profile: the desktop app archives, pins and trashes sessions over
// `_keryx/session_flags` and `_keryx/session_trash`; `session/list` reports
// the flags as `_meta.keryx`. The editor profile serves none of it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory, sessionDir } from "../session";
import { readSessionFlags } from "../session/organize";
import { KERYX_ACP_EXTENSION_METHODS } from "./profile";
import { shellHarness, textRound, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const FLAGS = KERYX_ACP_EXTENSION_METHODS.sessionFlags;
const TRASH = KERYX_ACP_EXTENSION_METHODS.sessionTrash;
const TIMEOUT_MS = 30_000;

const dataDirOf = (h: ShellHarness): string => path.join(h.projectDir, "data");

function storedSession(h: ShellHarness): string {
  const handle = createSession({ cwd: h.projectDir, provider: "test", model: "test-model", dataDir: dataDirOf(h) });
  persistHistory(handle, [{ role: "user", content: "q" }, { role: "assistant", content: "a" }], { provider: "test", model: "test-model" });
  return handle.summary.id;
}

async function call(h: ShellHarness, method: string, params: Record<string, unknown>) {
  const id = h.request(method, params);
  return h.waitFor((f) => f.id === id);
}

/**
 * Another keryx process (another Desktop window's server, the issue-workspace
 * child) holding the session's flags lock until `release` is called.
 */
async function holdFlagsLock(dir: string): Promise<{ release: () => Promise<number> }> {
  const barrier = mkdtempSync(path.join(tmpdir(), "keryx-acp-flags-barrier-"));
  const held = path.join(barrier, "held");
  const go = path.join(barrier, "go");
  const child = Bun.spawn([process.execPath, "-e", `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { withFileLock } = await import(${JSON.stringify(path.join(import.meta.dir, "../lib/file-lock.ts"))});
    const done = withFileLock(${JSON.stringify(path.join(dir, "flags.json.lock"))}, () => {
      writeFileSync(${JSON.stringify(held)}, "");
      while (!existsSync(${JSON.stringify(go)})) Bun.sleepSync(2);
      return true;
    }, { createDir: false, timeoutMs: 30_000 });
    if (done !== true) process.exit(3);`], { stdout: "ignore", stderr: "inherit" });
  while (!existsSync(held)) {
    if (child.exitCode !== null) throw new Error(`the lock holder exited (${child.exitCode}) before taking the lock`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return {
    release: () => {
      writeFileSync(go, "");
      return child.exited;
    },
  };
}

function trashSeam() {
  const home = mkdtempSync(path.join(tmpdir(), "keryx-acp-trash-"));
  return { home, serverOptions: { trash: { home, platform: "darwin" as const } } };
}

describe("shell profile: organise sessions", () => {
  test(
    "archive and pin show up in session/list as _meta.keryx; unarchive clears it",
    async () => {
      const h = shellHarness();
      try {
        await h.initialize();
        const id = storedSession(h);
        const set = await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, archived: true, pinned: true });
        expect(set.error).toBeUndefined();
        expect(typeof set.result?.["archivedAt"]).toBe("string");

        const listed = await call(h, "session/list", { cwd: h.projectDir });
        const info = (listed.result?.["sessions"] as Array<Record<string, any>>).find((s) => s["sessionId"] === id);
        expect(info?.["_meta"]?.keryx?.archivedAt).toBe(set.result?.["archivedAt"]);
        expect(info?.["_meta"]?.keryx?.pinnedAt).toBe(set.result?.["pinnedAt"]);

        await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, archived: false, pinned: false });
        const again = await call(h, "session/list", { cwd: h.projectDir });
        const cleared = (again.result?.["sessions"] as Array<Record<string, any>>).find((s) => s["sessionId"] === id);
        // Only the message count is left once the flags are cleared.
        expect(Object.keys(cleared?.["_meta"]?.keryx ?? {})).toEqual(["messageCount"]);
        expect(typeof cleared?.["_meta"]?.keryx?.messageCount).toBe("number");

        const linked = await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, flow: "495-2026-11-17-cards" });
        expect(linked.result?.["flow"]).toBe("495-2026-11-17-cards");
        const withFlow = await call(h, "session/list", { cwd: h.projectDir });
        const entry = (withFlow.result?.["sessions"] as Array<Record<string, any>>).find((s) => s["sessionId"] === id);
        expect(entry?.["_meta"]?.keryx?.flow).toBe("495-2026-11-17-cards");
        await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, flow: null });
        expect((await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, flow: 7 })).error?.code).toBe(-32602);

        // A session started from another names it, so Desktop can show the sessions as a tree.
        const child = createSession({ cwd: h.projectDir, provider: "test", model: "test-model", dataDir: dataDirOf(h), parentSessionId: id });
        persistHistory(child, [{ role: "user", content: "q" }], { provider: "test", model: "test-model" });
        const tree = await call(h, "session/list", { cwd: h.projectDir });
        const sessions = tree.result?.["sessions"] as Array<Record<string, any>>;
        expect(sessions.find((s) => s["sessionId"] === child.summary.id)?.["_meta"]?.keryx?.parentSessionId).toBe(id);
        expect(sessions.find((s) => s["sessionId"] === id)?.["_meta"]?.keryx?.parentSessionId).toBeUndefined();

        expect((await call(h, FLAGS, { sessionId: id, archived: "yes" })).error?.code).toBe(-32602);
        expect((await call(h, FLAGS, { sessionId: "missing", cwd: h.projectDir, archived: true })).error).toBeDefined();
      } finally {
        await h.end();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a subject is linked, listed after a fresh read, unlinked by null; an invalid one is refused",
    async () => {
      const h = shellHarness();
      try {
        await h.initialize();
        const id = storedSession(h);
        const subject = { kind: "pr", repo: "org/repo", number: 12, url: "https://github.com/org/repo/pull/12" };
        const linked = await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, subject });
        expect(linked.error).toBeUndefined();
        expect(linked.result?.["subject"]).toEqual(subject);
        // session/list reads flags.json again, as after a restart.
        const listed = await call(h, "session/list", { cwd: h.projectDir });
        const info = (listed.result?.["sessions"] as Array<Record<string, any>>).find((s) => s["sessionId"] === id);
        expect(info?.["_meta"]?.keryx?.subject).toEqual(subject);

        // Refused at the wire (wrong type) and at the store (URL that does not match).
        expect((await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, subject: "org/repo#12" })).error?.code).toBe(-32602);
        // An array is an object to `typeof`; the wire refuses it as a bad parameter, before the store sees it.
        expect((await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, subject: [] })).error?.code).toBe(-32602);
        expect((await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, subject: [subject] })).error?.code).toBe(-32602);
        const mismatch = await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, subject: { ...subject, url: "https://github.com/org/repo/issues/12" } });
        expect(mismatch.error).toBeDefined();
        expect(mismatch.result).toBeUndefined();
        // Omitted: a flag change leaves the subject as it is.
        expect((await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, pinned: true })).result?.["subject"]).toEqual(subject);

        const unlinked = await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, subject: null });
        expect(unlinked.result?.["subject"]).toBeUndefined();
        const again = await call(h, "session/list", { cwd: h.projectDir });
        const cleared = (again.result?.["sessions"] as Array<Record<string, any>>).find((s) => s["sessionId"] === id);
        expect(cleared?.["_meta"]?.keryx?.subject).toBeUndefined();
      } finally {
        await h.end();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a flags write waiting for another process's lock leaves the server answering, and two writes to one session apply in arrival order",
    async () => {
      // Never stale, a long timeout: only the holder letting go can let the writes in.
      const h = shellHarness({ serverOptions: { sessionFlagsLock: { timeoutMs: 10_000, staleMs: 60_000 } } });
      try {
        await h.initialize();
        const id = storedSession(h);
        const dir = sessionDir(h.projectDir, id, dataDirOf(h));
        const holder = await holdFlagsLock(dir);
        let released = false;
        try {
          const pin = h.request(FLAGS, { sessionId: id, cwd: h.projectDir, pinned: true });
          const unpin = h.request(FLAGS, { sessionId: id, cwd: h.projectDir, pinned: false });
          // A server that waited for the lock on its own thread would answer nothing before the writes.
          const listed = await call(h, "session/list", { cwd: h.projectDir });
          expect(listed.error).toBeUndefined();
          expect(h.frames.filter((f) => f.id === pin || f.id === unpin)).toEqual([]);
          released = true;
          expect(await holder.release()).toBe(0);
          expect((await h.waitFor((f) => f.id === pin)).result?.["pinnedAt"]).toBeDefined();
          const last = await h.waitFor((f) => f.id === unpin);
          expect(last.error).toBeUndefined();
          expect(last.result?.["pinnedAt"]).toBeUndefined();
          expect(readSessionFlags(dir).pinnedAt).toBeUndefined();
        } finally {
          if (!released) await holder.release();
        }
      } finally {
        await h.end();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a store refusal (unknown session, lock not taken in time) comes back as the request's invalid-request error with its reason",
    async () => {
      // A short wait and a never-stale lock: the planted lock is refused, not broken.
      const h = shellHarness({ serverOptions: { sessionFlagsLock: { timeoutMs: 20, staleMs: 60_000 } } });
      try {
        await h.initialize();
        const missing = await call(h, FLAGS, { sessionId: "no-such-session", cwd: h.projectDir, pinned: true });
        expect(missing.error?.code).toBe(-32600);
        expect(missing.error?.data).toMatchObject({ reason: `${FLAGS}: no session no-such-session in this project`, sessionId: "no-such-session" });

        const id = storedSession(h);
        writeFileSync(path.join(sessionDir(h.projectDir, id, dataDirOf(h)), "flags.json.lock"), "another-writer");
        const locked = await call(h, FLAGS, { sessionId: id, cwd: h.projectDir, pinned: true });
        expect(locked.error?.code).toBe(-32600);
        expect((locked.error?.data as { reason?: string } | undefined)?.reason).toMatch(/locked by another keryx process; retry$/);
        expect(h.stderr.filter((line) => /dispatch failed|unhandled/i.test(line))).toEqual([]);
      } finally {
        await h.end();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "trash releases an idle held session and moves its folder; a busy one is refused",
    async () => {
      const seam = trashSeam();
      const h = shellHarness({
        rounds: [toolRound("t1", "shell_exec", { command: "true" }), textRound("done")],
        serverOptions: seam.serverOptions,
      });
      try {
        await h.initialize();
        const busy = (await h.newSession()).sessionId;
        // A turn waiting on its permission question holds the session.
        const promptId = h.prompt(busy, "run it");
        const ask = await h.waitFor((f) => f.method === "session/request_permission");
        const refused = await call(h, TRASH, { sessionId: busy, cwd: h.projectDir });
        expect(refused.error?.data).toMatchObject({ condition: "session-busy" });
        h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
        expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();

        // Idle now: released and moved, and session/list no longer has it.
        const dir = sessionDir(h.projectDir, busy, dataDirOf(h));
        expect(existsSync(dir)).toBe(true);
        const done = await call(h, TRASH, { sessionId: busy, cwd: h.projectDir });
        expect(done.error).toBeUndefined();
        expect(path.dirname(done.result?.["trashedTo"] as string)).toBe(path.join(seam.home, ".Trash"));
        expect(existsSync(dir)).toBe(false);
        const listed = await call(h, "session/list", { cwd: h.projectDir });
        expect((listed.result?.["sessions"] as Array<Record<string, unknown>>).some((s) => s["sessionId"] === busy)).toBe(false);
        // Not held any more: a prompt to it is refused rather than run.
        const after = await call(h, "session/prompt", { sessionId: busy, prompt: [{ type: "text", text: "hi" }] });
        expect(after.error).toBeDefined();
      } finally {
        await h.end();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the editor profile does not serve them",
    async () => {
      const h = shellHarness({ profile: "editor" });
      try {
        await h.initialize();
        expect((await call(h, FLAGS, { sessionId: "x", archived: true })).error?.code).toBe(-32601);
        expect((await call(h, TRASH, { sessionId: "x" })).error?.code).toBe(-32601);
      } finally {
        await h.end();
      }
    },
    TIMEOUT_MS,
  );
});
