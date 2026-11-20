import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskRevision, DeskRunKey, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { readRunStatus } from "./runPolling";
import { reviewRun } from "../platform/reviewRuns";

import { runActive } from "../../../../src/review/board-badges";
export { runActive, sameRange } from "../../../../src/review/board-badges";

type ActionError =
  | { kind: "start" | "cancel"; message: string }
  | { kind: "answer"; id: string; questionId: string; message: string };

export type RunObserver = (key: DeskRunKey, revision: DeskRevision, snapshot: DeskRunSnapshot) => void;

export function useReviewRuns(
  cwd: string, key: DeskRunKey, baseSha: string, headSha: string, visible: boolean,
  invoke: typeof reviewRun, onSnapshot?: RunObserver, onAccessLost?: (reason: string) => void,
) {
  const [snapshot, setSnapshot] = useState<DeskRunSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const followers = useRef(new Map<symbol, string>());
  const followedId = useCallback(() => Array.from(followers.current.values()).at(-1), []);
  const [activityLoaded, setActivityLoaded] = useState<string>();
  type PollAction = Exclude<Parameters<typeof reviewRun>[2], { kind: "decide" | "readiness" }>;
  const pending = useRef<PollAction["kind"] | null>(null);
  const request = useCallback(async function request(action: PollAction, automatic = false): Promise<void> {
    // A mutation can overtake a status read. A stale read must never roll it back.
    if (pending.current && (action.kind === "status" || pending.current !== "status")) return;
    const activityId = followedId();
    if (action.kind === "status" && activityId && !action.id) action = { ...action, activityId };
    const id = ++generation.current;
    pending.current = action.kind;
    setWorking(action.kind !== "status");
    if (action.kind !== "status") setActionError(null);
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
      if (action.kind === "status") {
        setActionError(error => error?.kind === "answer" && !next.runs.some(run =>
          run.id === error.id && (run.pendingQuestion?.id === error.questionId ||
            run.pendingQuestions?.some(question => question.id === error.questionId))) ? null : error);
        onSnapshot?.(key, { baseSha, headSha }, next);
      }
    } catch (cause) {
      if (id !== generation.current) return;
      const message = errMessage(cause);
      if (action.kind === "status") setReadError(message);
      else if (action.kind === "answer") setActionError({ kind: "answer", id: action.id, questionId: action.questionId, message });
      else setActionError({ kind: action.kind, message });
      if (/^(access|configuration):/i.test(message)) {
        setSnapshot(null);
        if (action.kind === "status") setActionError(null);
      }
      if (/^access:/i.test(message)) onAccessLost?.(message);
    } finally {
      if (id === generation.current) {
        pending.current = null;
        setWorking(false);
        // A dialog may have opened during a plain history read. Fetch its activity immediately.
        const selected = followedId();
        if (selected && (action.kind !== "status" || selected !== action.activityId)) void request({ kind: "status" });
      }
    }
  }, [cwd, key, baseSha, headSha, invoke, onSnapshot, onAccessLost, followedId]);

  useEffect(() => {
    setActionError(null);
    void request({ kind: "status" });
    return () => { generation.current++; pending.current = null; };
  }, [request]);

  const follow = useCallback((id: string) => {
    const subscriber = Symbol();
    const previous = followedId();
    followers.current.set(subscriber, id);
    if (previous !== id) void request({ kind: "status" });
    return () => { followers.current.delete(subscriber); };
  }, [request, followedId]);

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

  return { activity: { follow, loaded: activityLoaded, error: readError }, runs: snapshot?.runs ?? [], loaded: snapshot !== null, error: actionError?.message || readError,
    staleRange: actionError?.kind === "start" && /^stale:/i.test(actionError.message), working, request };
}
