import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IssueDetail, IssueProjectRef, IssueViewer } from "../../integrations/issues-contract";
import { readSessionFlags, setSessionFlags, type SessionSubject } from "../organize";
import { sessionDir } from "../paths";
import { type BoundIssue, withIssueBinding } from "./issue-session";

const viewer: IssueViewer = { host: "github.com", login: "reader", nodeId: "user-reader" };

function issue(overrides: Partial<IssueDetail["ref"]> = {}): IssueDetail {
  return {
    ref: { host: "github.com", nodeId: "I_9", repositoryId: "R_9", owner: "Org", repo: "repo", number: 9, url: "https://github.com/Org/repo/issues/9", ...overrides },
    title: "Bind me", state: "open", author: "reader", assignees: [], labels: [],
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", body: "Body",
  };
}

/** The bound session's id; every binding in these tests reserves one, so a missing id fails the test. */
async function boundSessionId(record: BoundIssue): Promise<string> {
  const id = record.launch.sessionId;
  if (id === undefined) throw new Error("the binding reserved no session id");
  return id;
}

function workspace(): { root: string; dataDir: string; project: IssueProjectRef } {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-issue-session-"));
  return { root, dataDir: path.join(root, "data"), project: { cwd: root, projectId: "p", cloneId: "c", baseBranch: "main" } };
}

describe("withIssueBinding: session subject", () => {
  test("binding a session writes subject.kind = issue beside the private marker; a rebind keeps it", async () => {
    const { root, dataDir, project } = workspace();
    try {
      const sessionId = await withIssueBinding(viewer, project, issue(), dataDir, boundSessionId);
      const dir = sessionDir(root, sessionId, dataDir);
      const expected: SessionSubject = { kind: "issue", repo: "Org/repo", number: 9, url: "https://github.com/Org/repo/issues/9", repositoryId: "R_9" };
      expect(readSessionFlags(dir)).toEqual({ hasIssue: true, subject: expected });

      // The bound session reopened through the same binding keeps the subject and the other flags.
      await withIssueBinding(viewer, project, issue(), dataDir, async () => undefined);
      expect(readSessionFlags(dir).subject).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a subject unlinked by the person is not written back by a later open", async () => {
    const { root, dataDir, project } = workspace();
    try {
      const sessionId = await withIssueBinding(viewer, project, issue(), dataDir, boundSessionId);
      const dir = sessionDir(root, sessionId, dataDir);
      // keryx lists a session only after its first save; write the flag change straight to the store.
      const { persistHistory, createSession } = await import("../index");
      const handle = createSession({ cwd: root, id: sessionId, dataDir, provider: "test", model: "m" });
      persistHistory(handle, [{ role: "user", content: "hi" }], { provider: "test", model: "m" });
      setSessionFlags(root, sessionId, { subject: null }, dataDir);
      await withIssueBinding(viewer, project, issue(), dataDir, async () => undefined);
      expect(readSessionFlags(dir).subject).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a session bound before subjects existed gets its subject on the next open; an unlink still wins", async () => {
    const { root, dataDir, project } = workspace();
    try {
      const sessionId = await withIssueBinding(viewer, project, issue(), dataDir, boundSessionId);
      const dir = sessionDir(root, sessionId, dataDir);
      const { persistHistory, createSession } = await import("../index");
      const handle = createSession({ cwd: root, id: sessionId, dataDir, provider: "test", model: "m" });
      persistHistory(handle, [{ role: "user", content: "hi" }], { provider: "test", model: "m" });
      // What an older keryx left: the binding and a pin, no subject and no unlink marker.
      writeFileSync(path.join(dir, "flags.json"), JSON.stringify({ pinnedAt: "2026-11-01T00:00:00.000Z" }));
      expect(readSessionFlags(dir).subject).toBeUndefined();
      await withIssueBinding(viewer, project, issue(), dataDir, async () => undefined);
      expect(readSessionFlags(dir)).toEqual({ hasIssue: true, pinnedAt: "2026-11-01T00:00:00.000Z",
        subject: { kind: "issue", repo: "Org/repo", number: 9, url: "https://github.com/Org/repo/issues/9", repositoryId: "R_9" } });
      // The person unlinks it; the next open leaves it unlinked.
      setSessionFlags(root, sessionId, { subject: null }, dataDir);
      await withIssueBinding(viewer, project, issue(), dataDir, async () => undefined);
      expect(readSessionFlags(dir).subject).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an issue outside github.com binds without a subject", async () => {
    const { root, dataDir, project } = workspace();
    try {
      const enterprise = issue({ host: "git.example.com", url: "https://git.example.com/Org/repo/issues/9" });
      const sessionId = await withIssueBinding({ ...viewer, host: "git.example.com" }, project, enterprise, dataDir, boundSessionId);
      expect(readSessionFlags(sessionDir(root, sessionId, dataDir))).toEqual({ hasIssue: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
