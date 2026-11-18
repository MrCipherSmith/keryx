// A `/delegate` result kept in the parent's history (§3.9.5a, D-14) after the session is stored:
// it never names the session, a title it already named is repaired, and `session/load` replays it as
// the result card's shape (text + `_meta.keryx.delegateResult`), never with its envelope tags.

import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { createSession, listSessions, loadContext, persistHistory, renameSession } from "../session";
import type { NormalizedMessage } from "../harness/provider/types";
import { delegateResultNote, parseDelegateNote } from "./delegate-turn-hook";
import { shellHarness, type ShellHarness } from "./shell-profile.test-helpers";

const open: ShellHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
});

const dataDirOf = (h: ShellHarness): string => path.join(h.projectDir, "data");
const NONCE = "58c9727fff42";
const TEXT = "| a | b |\n|---|---|\n| 1 | 2 |";

const note = (runId: string, turn: number, text: string = TEXT): NormalizedMessage => ({
  role: "user",
  content: delegateResultNote({ agentId: "claude-cli", runId, turn, text, nonce: NONCE }),
  provenance: "harness",
  injected: true,
});

function harness(): ShellHarness {
  const h = shellHarness({ rounds: [] });
  open.push(h);
  return h;
}

function stored(h: ShellHarness, history: NormalizedMessage[], title?: string) {
  const handle = createSession({ cwd: h.projectDir, provider: "test", model: "test-model", dataDir: dataDirOf(h) });
  const persisted = persistHistory(handle, history, { provider: "test", model: "test-model" });
  // As an older keryx left it: a title taken from the note, written without going through the repair.
  return title !== undefined ? renameSession(persisted, title) : persisted;
}

test("parseDelegateNote reads run, turn and text back; the envelope stays out; other messages are not notes", () => {
  const parsed = parseDelegateNote(note("ext:7", 3).content);
  expect(parsed).toEqual({ agentId: "claude-cli", runId: "ext:7", turn: 3, text: TEXT });
  expect(parseDelegateNote("[delegate x, run y, turn 1 result] but not a note")).toBeUndefined();
  expect(parseDelegateNote("just a question")).toBeUndefined();
});

test("title: an injected note before the first real message does not name the session", () => {
  const h = harness();
  const handle = stored(h, [note("ext:1", 1), { role: "user", content: "refactor the parser" }, { role: "assistant", content: "ok" }]);
  expect(handle.summary.title).toBe("refactor the parser");
});

test("title: only injected notes leave the default title", () => {
  const h = harness();
  expect(stored(h, [note("ext:1", 1)]).summary.title).toBe("New session");
});

test("title: a stored \"[delegate …\" title is recomputed from the first real message on load and persisted", async () => {
  const h = harness();
  const bad = stored(h, [{ role: "user", content: "refactor the parser" }, note("ext:1", 1)], "[delegate claude-cli, run ext:1, turn 1 result]");
  expect(listSessions(h.projectDir, dataDirOf(h)).find((s) => s.id === bad.summary.id)?.title.startsWith("[delegate ")).toBe(true);
  await h.initialize();
  const id = h.request("session/load", { sessionId: bad.summary.id, cwd: h.projectDir, mcpServers: [] });
  expect((await h.waitFor((f) => f.id === id)).error).toBeUndefined();
  expect(listSessions(h.projectDir, dataDirOf(h)).find((s) => s.id === bad.summary.id)?.title).toBe("refactor the parser");
});

test("session/list shows the repaired title of an unopened session", async () => {
  const h = harness();
  const bad = stored(h, [{ role: "user", content: "fix the cache" }, note("ext:1", 1)], "[delegate claude-cli, run ext:1, turn 1 result]");
  await h.initialize();
  const id = h.request("session/list", { cwd: h.projectDir });
  const reply = await h.waitFor((f) => f.id === id);
  const sessions = (reply.result as { sessions: { sessionId: string; title: string }[] }).sessions;
  expect(sessions.find((s) => s.sessionId === bad.summary.id)?.title).toBe("fix the cache");
});

test("replay: a delegate note is sent as text + _meta.keryx.delegateResult; no envelope text reaches the client; the history is untouched", async () => {
  const h = harness();
  const s = stored(h, [{ role: "user", content: "go" }, { role: "assistant", content: "delegating" }, note("ext:1", 1), note("ext:1", 2, "second")]);
  await h.initialize();
  const id = h.request("session/load", { sessionId: s.summary.id, cwd: h.projectDir, mcpServers: [] });
  expect((await h.waitFor((f) => f.id === id)).error).toBeUndefined();
  const chunks = h.frames.filter((f) => f.params?.update?.sessionUpdate === "user_message_chunk");
  expect(chunks.map((f) => f.params?.update?.content?.text)).toEqual(["go", TEXT, "second"]);
  expect(JSON.stringify(chunks)).not.toContain("delegate-result-");
  expect(JSON.stringify(chunks)).not.toContain("UNTRUSTED");
  const delegateMeta = (frame: unknown) =>
    (frame as { params?: { update?: { _meta?: { keryx?: { delegateResult?: Record<string, unknown> } } } } } | undefined)?.params?.update?._meta?.keryx?.delegateResult;
  expect(delegateMeta(chunks[1])).toEqual({ agentId: "claude-cli", runId: "ext:1", turn: 1, text: TEXT });
  expect(delegateMeta(chunks[2])?.turn).toBe(2);
  const kept = loadContext(h.projectDir, s.summary.id, dataDirOf(h));
  expect(kept[2]?.content).toContain(`<delegate-result-${NONCE}>`);
  expect(kept[2]?.injected).toBe(true);
});
