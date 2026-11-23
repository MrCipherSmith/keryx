import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxSubdir, isDefiniteAbsence, keryxDataDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../../lib/config-dir";
import { withFileLock } from "../../lib/fs";
import { createSession, findSession, sessionDir } from "../index";
import { parseSessionSubject, readSessionFlags, updateSessionFlagsAt } from "../organize";
import { issueDigest, issueKey, issueSessionKey, issueViewerKey, type IssueDetail, type IssueLaunch, type IssueProjectRef, type IssueViewer } from "../../integrations/issue-context/service";

export interface BoundIssue {
  launch: IssueLaunch;
  /** The independently fetched description is available to the ACP conversation as untrusted external context. */
  body: string;
  updatedAt: string;
  /** Persisted before dispatch so retries survive title, login and issue URL changes or a client upgrade. */
  preparationPrompt?: string;
  flowSourceUrl?: string;
}

export function issueBindingFile(viewer: IssueViewer, project: IssueProjectRef, issue: IssueDetail["ref"], dataDir?: string): string {
  const key = issueSessionKey("shell", viewer, project.cloneId, issue);
  return path.join(keryxDataDir(dataDir), "issue-sessions", issueDigest(key) + ".json");
}

export function privateJson<T>(file: string): T | undefined {
  const read = readConfigFile(file);
  if (read.ok) return JSON.parse(read.text) as T;
  if (isDefiniteAbsence(read.reason)) return undefined;
  throw new Error("The local issue-session record could not be read. Check the storage permissions and try again.");
}

export function saveBinding(file: string, record: BoundIssue): void {
  writeOwnerOnlyFileAtomic(file, JSON.stringify(record));
}

export function issueContextForSession(dir: string, dataDir?: string): BoundIssue | undefined {
  const id = privateJson<{ key: string }>(path.join(dir, "issue-link.json"))?.key;
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return undefined;
  const binding = privateJson<BoundIssue>(path.join(keryxDataDir(dataDir), "issue-sessions", id + ".json"));
  return binding?.launch.sessionId === path.basename(dir) && binding.launch.version === 1 ? binding : undefined;
}

/**
 * Records the issue as the session's public subject in `flags.json`, so a
 * client can tell which issue the session works on (the private record above
 * stays the authority). Written once, when the session is bound: a subject the
 * person later unlinks is not written back. An issue whose URL is not a
 * github.com issue page (GitHub Enterprise) has no subject keryx can store.
 */
function bindIssueSubject(dir: string, ref: IssueDetail["ref"]): void {
  const subject = parseSessionSubject({ kind: "issue", repo: `${ref.owner}/${ref.repo}`, number: ref.number, url: ref.url,
    ...(ref.repositoryId ? { repositoryId: ref.repositoryId } : {}) });
  if (subject !== undefined) updateSessionFlagsAt(dir, { subject });
}

/** Only called after the remote issue and viewer were verified. The intent reserves the UUID before creating the session. */
export async function withIssueBinding<T>(
  viewer: IssueViewer, project: IssueProjectRef, issue: IssueDetail, dataDir: string | undefined,
  apply: (record: BoundIssue, file: string) => Promise<T>,
): Promise<T> {
  const file = issueBindingFile(viewer, project, issue.ref, dataDir);
  ensureKeryxSubdir(["issue-sessions"], keryxDataDir(dataDir));
  return withFileLock(file + ".lock", async () => {
    let record = privateJson<BoundIssue>(file);
    if (!record) {
      const launchId = randomUUID();
      record = {
        launch: { version: 1, launchId, issue: issue.ref, viewer, project, stage: "registered",
          sessionId: randomUUID(), initialTurn: { key: launchId, state: "unsent" } },
        body: issue.body, updatedAt: issue.updatedAt,
      };
      saveBinding(file, record);
    }
    const launch = record.launch;
    if (launch.version !== 1 || issueKey(launch.issue) !== issueKey(issue.ref) || issueViewerKey(launch.viewer) !== issueViewerKey(viewer)
        || launch.project.cloneId !== project.cloneId || !launch.sessionId) {
      throw new Error("Invalid issue-session binding. Inspect the session storage before continuing.");
    }
    const root = launch.project.cwd;
    const dir = sessionDir(root, launch.sessionId, dataDir);
    if (launch.stage !== "registered" && (!findSession(root, launch.sessionId, dataDir) || readSessionFlags(dir).archivedAt)) {
      throw new Error("The linked session is archived or missing. Restore it in Sessions and retry.");
    }
    if (launch.stage === "registered") {
      // Only the new intent can materialize its reserved UUID, including after a crash at creation.
      if (!findSession(root, launch.sessionId, dataDir)) {
        createSession({ cwd: root, id: launch.sessionId, title: `${issue.ref.owner}/${issue.ref.repo}#${issue.ref.number} ${issue.title}`,
          ...(dataDir !== undefined ? { dataDir } : {}) });
      }
      writeOwnerOnlyFileAtomic(path.join(dir, "issue-link.json"), JSON.stringify({ key: path.basename(file, ".json") }));
      bindIssueSubject(dir, issue.ref);
      launch.stage = "session_bound";
    }
    if (!existsSync(dir)) throw new Error("The linked session is missing. Restore it in Sessions and retry.");
    if (launch.flow) record.flowSourceUrl ??= launch.issue.url;
    launch.issue = issue.ref;
    record.body = issue.body;
    record.updatedAt = issue.updatedAt;
    saveBinding(file, record);
    return apply(record, file);
  });
}
