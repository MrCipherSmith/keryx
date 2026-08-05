import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compactSession,
  createSession,
  findSession,
  latestSession,
  listSessions,
  loadArchive,
  loadContext,
  openSession,
  persistHistory,
  projectKeyFromPath,
  resolveProjectRoot,
  shortSessionId,
  titleFromPrompt,
} from "./index";

function tempData(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-session-"));
}

test("titleFromPrompt and shortSessionId", () => {
  expect(titleFromPrompt("  hello   world  ")).toBe("hello world");
  expect(titleFromPrompt("x".repeat(80)).endsWith("…")).toBe(true);
  expect(shortSessionId("019f8070-95f5-7422-9bde-8862e9f685af")).toHaveLength(8);
});

test("projectKeyFromPath is stable and isolates different roots", () => {
  const a = projectKeyFromPath("/tmp/proj-a");
  const b = projectKeyFromPath("/tmp/proj-b");
  expect(a).not.toBe(b);
  expect(projectKeyFromPath("/tmp/proj-a")).toBe(a);
});

test("resolveProjectRoot falls back to absolute cwd without git", () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-nongit-"));
  try {
    expect(resolveProjectRoot(root)).toBe(path.resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessions are isolated per project", () => {
  const dataDir = tempData();
  const projA = mkdtempSync(path.join(tmpdir(), "keryx-pa-"));
  const projB = mkdtempSync(path.join(tmpdir(), "keryx-pb-"));
  try {
    const a = createSession({ cwd: projA, dataDir });
    const b = createSession({ cwd: projB, dataDir });
    persistHistory(a, [{ role: "user", content: "from A", provenance: "project" }]);
    persistHistory(b, [{ role: "user", content: "from B", provenance: "project" }]);

    const listA = listSessions(projA, dataDir);
    const listB = listSessions(projB, dataDir);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]!.id).toBe(a.summary.id);
    expect(listB[0]!.id).toBe(b.summary.id);
    expect(listA[0]!.title).toBe("from A");
    expect(listB[0]!.title).toBe("from B");
    expect(findSession(projB, a.summary.id, dataDir)).toBeUndefined();
    expect(latestSession(projA, dataDir)?.id).toBe(a.summary.id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
    rmSync(projB, { recursive: true, force: true });
  }
});

test("openSession continue/resume and dual context/archive roundtrip", () => {
  const dataDir = tempData();
  const proj = mkdtempSync(path.join(tmpdir(), "keryx-pr-"));
  try {
    const created = openSession({ cwd: proj, dataDir, provider: "p", model: "m" });
    expect(created.resumed).toBe(false);
    expect(created.history).toEqual([]);
    expect(created.archive).toEqual([]);

    const next = persistHistory(
      created.handle,
      [
        { role: "user", content: "fix auth", provenance: "project" },
        { role: "assistant", content: "looking…", provenance: "model" },
        { role: "tool", content: "ok", provenance: "tool" },
      ],
      { provider: "p", model: "m" },
    );
    expect(next.summary.messageCount).toBe(3);
    expect(next.summary.archiveMessageCount).toBe(3);
    expect(next.summary.title).toBe("fix auth");

    const cont = openSession({ cwd: proj, dataDir, continueLast: true });
    expect(cont.resumed).toBe(true);
    expect(cont.handle.summary.id).toBe(created.handle.summary.id);
    expect(cont.history.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(cont.archive).toHaveLength(3);

    const byPrefix = openSession({
      cwd: proj,
      dataDir,
      resumeId: shortSessionId(created.handle.summary.id),
    });
    expect(byPrefix.handle.summary.id).toBe(created.handle.summary.id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("compactSession shrinks context but keeps archive", () => {
  const dataDir = tempData();
  const proj = mkdtempSync(path.join(tmpdir(), "keryx-cp-"));
  try {
    let handle = createSession({ cwd: proj, dataDir });
    const long = [
      { role: "user" as const, content: "t1", provenance: "project" as const },
      { role: "assistant" as const, content: "a1", provenance: "model" as const },
      { role: "user" as const, content: "t2", provenance: "project" as const },
      { role: "assistant" as const, content: "a2", provenance: "model" as const },
      { role: "user" as const, content: "t3", provenance: "project" as const },
      { role: "assistant" as const, content: "a3", provenance: "model" as const },
      { role: "user" as const, content: "t4", provenance: "project" as const },
      { role: "assistant" as const, content: "a4", provenance: "model" as const },
    ];
    handle = persistHistory(handle, long);
    const archiveBefore = loadArchive(proj, handle.summary.id, dataDir);
    expect(archiveBefore).toHaveLength(8);

    const { handle: after, context, result } = compactSession(handle, long, long, {
      keepLastUserTurns: 2,
      focus: "ship it",
    });
    expect(result.noop).toBe(false);
    expect(context.length).toBeLessThan(long.length);
    expect(after.summary.compactCount).toBe(1);
    expect(loadContext(proj, after.summary.id, dataDir).length).toBe(context.length);
    // archive still has full history
    expect(loadArchive(proj, after.summary.id, dataDir).length).toBe(8);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resume missing id throws with per-project hint", () => {
  const dataDir = tempData();
  const proj = mkdtempSync(path.join(tmpdir(), "keryx-miss-"));
  try {
    expect(() => openSession({ cwd: proj, dataDir, resumeId: "no-such-id" })).toThrow(/per-project/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("loadContext returns empty for unknown session", () => {
  const dataDir = tempData();
  const proj = mkdtempSync(path.join(tmpdir(), "keryx-empty-"));
  try {
    expect(loadContext(proj, "00000000-0000-4000-8000-000000000099", dataDir)).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
