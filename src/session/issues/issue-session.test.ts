import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IssueDetail, IssueProjectRef, IssueViewer } from "../../integrations/issues-contract";
import { readSessionFlags, setSessionFlags } from "../organize";
import { sessionDir } from "../paths";
import { withIssueBinding } from "./issue-session";

const viewer: IssueViewer = { host: "github.com", login: "reader", nodeId: "user-reader" };

function issue(overrides: Partial<IssueDetail["ref"]> = {}): IssueDetail {
  return {
    ref: { host: "github.com", nodeId: "I_9", repositoryId: "R_9", owner: "Org", repo: "repo", number: 9, url: "https://github.com/Org/repo/issues/9", ...overrides },
    title: "Bind me", state: "open", author: "reader", assignees: [], labels: [],
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", body: "Body",
  };
}

function workspace(): { root: string; dataDir: string; project: IssueProjectRef } {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-issue-session-"));
  return { root, dataDir: path.join(root, "data"), project: { cwd: root, projectId: "p", cloneId: "c", baseBranch: "main" } };
}

describe("withIssueBinding: session subject", () => {
  test("binding a session writes subject.kind = issue beside the private marker; a rebind keeps it", async () => {
    const { root, dataDir, project } = workspace();
    try {
      const sessionId = await withIssueBinding(viewer, project, issue(), dataDir, async (record) => record.launch.sessionId);
      const dir = sessionDir(root, sessionId, dataDir);
      const expected = { kind: "issue", repo: "Org/repo", number: 9, url: "https://github.com/Org/repo/issues/9", repositoryId: "R_9" };
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
      const sessionId = await withIssueBinding(viewer, project, issue(), dataDir, async (record) => record.launch.sessionId);
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

  test("an issue outside github.com binds without a subject", async () => {
    const { root, dataDir, project } = workspace();
    try {
      const enterprise = issue({ host: "git.example.com", url: "https://git.example.com/Org/repo/issues/9" });
      const sessionId = await withIssueBinding({ ...viewer, host: "git.example.com" }, project, enterprise, dataDir, async (record) => record.launch.sessionId);
      expect(readSessionFlags(sessionDir(root, sessionId, dataDir))).toEqual({ hasIssue: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
