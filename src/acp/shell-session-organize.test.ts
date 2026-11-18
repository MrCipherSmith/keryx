// Shell profile: the desktop app archives, pins and trashes sessions over
// `_keryx/session_flags` and `_keryx/session_trash`; `session/list` reports
// the flags as `_meta.keryx`. The editor profile serves none of it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory, sessionDir } from "../session";
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

        expect((await call(h, FLAGS, { sessionId: id, archived: "yes" })).error?.code).toBe(-32602);
        expect((await call(h, FLAGS, { sessionId: "missing", cwd: h.projectDir, archived: true })).error).toBeDefined();
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
