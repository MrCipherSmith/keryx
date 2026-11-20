import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskRevision, DeskRunKey, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { readRunStatus } from "./runPolling";
import { reviewRun } from "../platform/reviewRuns";

import { runActive } from "../../../../src/review/board-badges";
export { runActive, sameRange } from "../../../../src/review/board-badges";

export type RunObserver = (key: DeskRunKey, revision: DeskRevision, snapshot: DeskRunSnapshot) => void;

export function useReviewRuns(
  cwd: string, key: DeskRunKey, baseSha: string, headSha: string, visible: boolean,
  invoke: typeof reviewRun, onSnapshot?: RunObserver, onAccessLost?: (reason: string) => void,
) {
  const [snapshot, setSnapshot] = useState<DeskRunSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const activityId = useRef<string | undefined>(undefined);
  const [activityLoaded, setActivityLoaded] = useState<string>();
  const pending = useRef<"start" | "cancel" | "status" | null>(null);
  const request = useCallback(async (action: Parameters<typeof reviewRun>[2], automatic = false) => {
    // A mutation can overtake a status read. A stale read must never roll it back.
    if (pending.current && (action.kind === "status" || pending.current !== "status")) return;
    if (action.kind === "status" && activityId.current && !action.id) action = { ...action, activityId: activityId.current };
    const id = ++generation.current;
    pending.current = action.kind;
    setWorking(action.kind !== "status");
    const setError = action.kind === "status" ? setReadError : setActionError;
    if (action.kind !== "status") setActionError("");
    try {
      const next = action.kind === "status" ? await readRunStatus(invoke, cwd, key, action, automatic) : await invoke(cwd, key, action);
      if (!next) return;
      // Mutations belong to the PR even if its drawer closed while the CLI was working.
      // The board observer checks viewer, repository and revision before updating a badge.
      if (action.kind !== "status") onSnapshot?.(key, { baseSha, headSha }, next);
      if (id !== generation.current) return;
      setSnapshot(next);
      setActivityLoaded(action.kind === "status" ? action.activityId : undefined);
      setReadError("");
      if (action.kind === "status") onSnapshot?.(key, { baseSha, headSha }, next);
    } catch (cause) {
      if (id !== generation.current) return;
      const message = errMessage(cause);
      setError(message);
      if (/^(access|configuration):/i.test(message)) {
        setSnapshot(null);
        if (action.kind === "status") setActionError("");
      }
      if (/^access:/i.test(message)) onAccessLost?.(message);
    } finally {
      if (id === generation.current) {
        pending.current = null;
        setWorking(false);
      }
    }
  }, [cwd, key, baseSha, headSha, invoke, onSnapshot, onAccessLost]);

  useEffect(() => {
    setActionError("");
    void request({ kind: "status" });
    return () => { generation.current++; pending.current = null; };
  }, [request]);

  const follow = useCallback((id: string) => {
    activityId.current = id;
    void request({ kind: "status" });
    return () => { if (activityId.current === id) activityId.current = undefined; };
  }, [request]);

  const active = snapshot?.runs.some(runActive) ?? false;
  useEffect(() => {
    if (!active && !visible) return;
    function poll() {
      if (document.visibilityState !== "hidden") void request({ kind: "status" }, true);
    }
    const timer = window.setInterval(poll, active ? 3000 : 15000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [active, visible, request]);

  return { activity: { follow, loaded: activityLoaded, error: readError }, runs: snapshot?.runs ?? [], loaded: snapshot !== null, error: actionError || readError, working, request };
}
