import { useCallback, useEffect, useRef, useState } from "react";
import { issueViewerKey, type IssueListSource, type IssuePage, type IssueSummary, type IssueViewer } from "../../../../src/integrations/issues-contract";
import { errMessage } from "../lib/format";
import { requestIssues } from "../platform/issues";
import { mergeRows, type Filters, type ProjectBoard, type ProjectSource, type Row } from "./model";

interface Snapshot {
  viewer: IssueViewer;
  rows: Row[];
  project?: ProjectBoard;
  nextCursor: string | null;
  incomplete: boolean;
  readAt: Date;
}

export function isAccessError(reason: string) {
  return /(?:^|\b)(?:access|account_mismatch|source_unavailable):/i.test(reason);
}

// The classification is part of the CLI contract; tests on the producing side pin its texts.
export { repositoryUnavailable } from "../../../../src/integrations/issues-contract";

export function useIssueCollection(cwd: string, login: string, source: IssueListSource | "project", target: ProjectSource | null,
  filters: Filters, verified: IssueViewer, denied: (reason: string) => void, request: typeof requestIssues) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const newest = useRef(0);
  const cursor = useRef<string | null>(null);
  const loading = useRef(false);
  const viewer = issueViewerKey(verified);
  const owner = target?.owner;
  const number = target?.number;
  const { state, since, sort } = filters;

  const invalidate = useCallback((message: string) => {
    newest.current++;
    loading.current = false;
    cursor.current = null;
    setSnapshot(null);
    setError(message);
    setBusy(false);
  }, []);

  const load = useCallback(async (append = false) => {
    if (append && (loading.current || !cursor.current)) return;
    const generation = ++newest.current;
    if (!login || (source === "project" && (!owner || !number))) {
      setSnapshot(null); setBusy(false); setError(""); return;
    }
    const next = append ? cursor.current : null;
    loading.current = true;
    setBusy(true);
    setError("");
    try {
      let result: Snapshot;
      if (source === "project") {
        const page = await request<IssuePage<{ itemId: string; optionId: string | null; issue: IssueSummary }> & { project: ProjectBoard }>(
          cwd, login, "project", { owner, number, cursor: next });
        result = { viewer: page.viewer, rows: page.items, project: page.project, nextCursor: page.nextCursor, incomplete: page.incomplete, readAt: new Date() };
      } else {
        const page = await request<IssuePage<IssueSummary>>(cwd, login, "list", {
          source, state, sort, ...(since ? { updatedSince: since + "T00:00:00Z" } : {}), cursor: next,
        });
        result = { viewer: page.viewer, rows: page.items.map(issue => ({ issue })), nextCursor: page.nextCursor, incomplete: page.incomplete, readAt: new Date() };
      }
      if (generation !== newest.current) return;
      const identity = issueViewerKey(result.viewer);
      if (result.viewer.login.toLowerCase() !== login.toLowerCase() || viewer !== identity) {
        denied("access: GitHub account changed. Refresh to verify this account.");
        return;
      }
      cursor.current = result.nextCursor;
      setSnapshot(old => ({ ...result, incomplete: result.incomplete || (append && !!old?.incomplete),
        rows: mergeRows(append ? old?.rows ?? [] : [], result.rows) }));
    } catch (e) {
      if (newest.current !== generation) return;
      const reason = errMessage(e);
      if (isAccessError(reason)) denied(reason);
      else setError(reason);
    } finally {
      if (newest.current === generation) { loading.current = false; setBusy(false); }
    }
  }, [cwd, login, source, owner, number, state, since, sort, request, viewer, denied]);

  useEffect(() => {
    cursor.current = null;
    setSnapshot(null);
    void load();
    return () => { newest.current++; };
  }, [load]);

  return { snapshot, busy, error, load, invalidate, setSnapshot };
}
