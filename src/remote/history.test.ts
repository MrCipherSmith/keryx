// Flow 376 AC4: a session driven from Telegram keeps the intervals it was
// driven in, next to runMode in the summary. History is the session's own
// record: the topic being deleted does not touch it, and resuming a session
// with -r/-c never turns remote control back on.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_REMOTE_INTERVALS,
  REMOTE_MARK,
  createSession,
  describeRemote,
  listSessions,
  openSession,
  persistHistory,
  recordRemoteOff,
  recordRemoteOn,
  type SessionHandle,
} from "../session";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): { dataDir: string; cwd: string; handle: SessionHandle } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-remote-hist-data-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-remote-hist-proj-"));
  cleanups.push(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const handle = createSession({ cwd, dataDir, provider: "anthropic", model: "claude-x" });
  return { dataDir, cwd, handle };
}

function readSummary(handle: SessionHandle): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(handle.dir, "summary.json"), "utf8")) as Record<string, unknown>;
}

test("a session never driven remotely has no remote field and no mark text", () => {
  const f = fixture();
  expect(f.handle.summary.remote).toBeUndefined();
  expect(describeRemote(f.handle.summary.remote)).toBe("");
  expect(listSessions(f.cwd, f.dataDir)[0]?.remote).toBeUndefined();
});

test("turning it on opens an interval and writes it to summary.json", () => {
  const f = fixture();
  const on = recordRemoteOn(f.handle, "keryx-demo", "2026-10-01T10:00:00.000Z");
  expect(on.summary.remote).toEqual({ name: "keryx-demo", intervals: [{ on: "2026-10-01T10:00:00.000Z" }] });
  expect(readSummary(on).remote).toEqual({ name: "keryx-demo", intervals: [{ on: "2026-10-01T10:00:00.000Z" }] });
});

test("turning it off closes the open interval; a second off is a no-op", () => {
  const f = fixture();
  const on = recordRemoteOn(f.handle, "t", "2026-10-01T10:00:00.000Z");
  const off = recordRemoteOff(on, "2026-10-01T10:30:00.000Z");
  expect(off.summary.remote?.intervals).toEqual([{ on: "2026-10-01T10:00:00.000Z", off: "2026-10-01T10:30:00.000Z" }]);
  const again = recordRemoteOff(off, "2026-10-01T11:00:00.000Z");
  expect(again.summary.remote?.intervals).toEqual([{ on: "2026-10-01T10:00:00.000Z", off: "2026-10-01T10:30:00.000Z" }]);
});

test("off without any recorded on writes nothing", () => {
  const f = fixture();
  const off = recordRemoteOff(f.handle);
  expect(off.summary.remote).toBeUndefined();
  expect(readSummary(f.handle).remote).toBeUndefined();
});

test("on, off, on again keeps both intervals and the latest topic name", () => {
  const f = fixture();
  let h = recordRemoteOn(f.handle, "first", "2026-10-01T10:00:00.000Z");
  h = recordRemoteOff(h, "2026-10-01T10:10:00.000Z");
  h = recordRemoteOn(h, "second", "2026-10-01T11:00:00.000Z");
  expect(h.summary.remote?.name).toBe("second");
  expect(h.summary.remote?.intervals).toEqual([
    { on: "2026-10-01T10:00:00.000Z", off: "2026-10-01T10:10:00.000Z" },
    { on: "2026-10-01T11:00:00.000Z" },
  ]);
});

test("a conversation turn (persistHistory) keeps the remote field", () => {
  const f = fixture();
  const on = recordRemoteOn(f.handle, "keepme", "2026-10-01T10:00:00.000Z");
  const next = persistHistory(on, [{ role: "user", content: "hello", provenance: "project" }]);
  expect(next.summary.remote?.name).toBe("keepme");
  expect(readSummary(next).remote).toEqual({ name: "keepme", intervals: [{ on: "2026-10-01T10:00:00.000Z" }] });
});

test("recording on or off does not count as a conversation turn: updatedAt is untouched", () => {
  const f = fixture();
  const before = f.handle.summary.updatedAt;
  const on = recordRemoteOn(f.handle, "t");
  const off = recordRemoteOff(on);
  expect(off.summary.updatedAt).toBe(before);
});

test("listSessions reads the remote field back and the one-line description names topic and times", () => {
  const f = fixture();
  let h = recordRemoteOn(f.handle, "keryx-demo", "2026-10-01T10:00:00.000Z");
  h = recordRemoteOff(h, "2026-10-01T10:30:00.000Z");
  recordRemoteOn(h, "keryx-demo", "2026-10-01T12:00:00.000Z");
  const listed = listSessions(f.cwd, f.dataDir)[0];
  expect(listed?.remote?.intervals).toHaveLength(2);
  expect(REMOTE_MARK).toBe("remote");
  expect(describeRemote(listed?.remote)).toBe("remote keryx-demo: 2026-10-01 10:00 - 2026-10-01 10:30; 2026-10-01 12:00 -");
});

test("only the newest MAX_REMOTE_INTERVALS intervals are kept", () => {
  const f = fixture();
  let h = f.handle;
  for (let i = 0; i < MAX_REMOTE_INTERVALS + 5; i += 1) {
    const stamp = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    h = recordRemoteOn(h, "t", stamp);
    h = recordRemoteOff(h, new Date(Date.UTC(2026, 9, 1, 0, i, 30)).toISOString());
  }
  expect(h.summary.remote?.intervals).toHaveLength(MAX_REMOTE_INTERVALS);
  const reread = listSessions(f.cwd, f.dataDir)[0];
  expect(reread?.remote?.intervals).toHaveLength(MAX_REMOTE_INTERVALS);
  // The oldest were dropped, the newest stays.
  expect(reread?.remote?.intervals.at(-1)?.on).toBe(new Date(Date.UTC(2026, 9, 1, 0, MAX_REMOTE_INTERVALS + 4)).toISOString());
});

test("a damaged remote field is ignored and does not hide the session", () => {
  const f = fixture();
  const file = path.join(f.handle.dir, "summary.json");
  const summary = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...summary, remote: { name: 7, intervals: "nope" } }), "utf8");
  const listed = listSessions(f.cwd, f.dataDir);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.remote).toBeUndefined();

  writeFileSync(
    file,
    JSON.stringify({ ...summary, remote: { name: "ok", intervals: [{ on: "2026-10-01T10:00:00.000Z" }, { on: 5 }, "junk", { on: "2026-10-01T11:00:00.000Z", off: 9 }] } }),
    "utf8",
  );
  const partial = listSessions(f.cwd, f.dataDir)[0];
  expect(partial?.remote?.name).toBe("ok");
  expect(partial?.remote?.intervals).toEqual([{ on: "2026-10-01T10:00:00.000Z" }, { on: "2026-10-01T11:00:00.000Z" }]);
});

test("resuming with -c or an id lists the history but does not start remote control", () => {
  const f = fixture();
  const on = recordRemoteOn(f.handle, "t", "2026-10-01T10:00:00.000Z");
  persistHistory(recordRemoteOff(on, "2026-10-01T10:30:00.000Z"), [{ role: "user", content: "hi", provenance: "project" }]);

  for (const opts of [{ continueLast: true }, { resumeId: f.handle.summary.id }]) {
    const opened = openSession({ cwd: f.cwd, dataDir: f.dataDir, ...opts });
    expect(opened.resumed).toBe(true);
    // The recorded interval is closed and resuming adds none: nothing started it.
    expect(opened.handle.summary.remote?.intervals).toEqual([{ on: "2026-10-01T10:00:00.000Z", off: "2026-10-01T10:30:00.000Z" }]);
    expect(readSummary(opened.handle).remote).toEqual({
      name: "t",
      intervals: [{ on: "2026-10-01T10:00:00.000Z", off: "2026-10-01T10:30:00.000Z" }],
    });
  }
});

test("deleting the topic is not a session event: history is only written by recordRemoteOn/Off", () => {
  const f = fixture();
  const on = recordRemoteOn(f.handle, "gone-topic", "2026-10-01T10:00:00.000Z");
  const closed = recordRemoteOff(on, "2026-10-01T10:05:00.000Z");
  // Nothing in the session store knows about the topic's lifetime: the record stays as written.
  expect(listSessions(f.cwd, f.dataDir)[0]?.remote).toEqual(closed.summary.remote);
});
