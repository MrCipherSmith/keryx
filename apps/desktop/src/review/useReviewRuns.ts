import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskRevision, DeskRun, DeskRunKey, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { reviewRun } from "../platform/reviewRuns";

export function runActive(run: DeskRun) {
  return run.state === "running" || run.state === "queued" || run.state === "cancelling";
}

export function sameRange(a: DeskRevision | null, b: DeskRevision) {
  return a?.baseSha === b.baseSha && a.headSha === b.headSha;
}

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
  const pending = useRef<"start" | "cancel" | "status" | null>(null);
  const request = useCallback(async (action: Parameters<typeof reviewRun>[2]) => {
    // A mutation can overtake a status read. A stale read must never roll it back.
    if (pending.current && (action.kind === "status" || pending.current !== "status")) return;
    const id = ++generation.current;
    pending.current = action.kind;
    setWorking(action.kind !== "status");
    const setError = action.kind === "status" ? setReadError : setActionError;
    if (action.kind !== "status") setActionError("");
    try {
      const next = await invoke(cwd, key, action);
      if (id !== generation.current) return;
      setSnapshot(next);
      setReadError("");
      onSnapshot?.(key, { baseSha, headSha }, next);
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

  const active = snapshot?.runs.some(runActive) ?? false;
  useEffect(() => {
    if (!active && !visible) return;
    function poll() {
      if (document.visibilityState !== "hidden") void request({ kind: "status" });
    }
    const timer = window.setInterval(poll, active ? 3000 : 15000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [active, visible, request]);

  return { runs: snapshot?.runs ?? [], loaded: snapshot !== null, error: actionError || readError, working, request };
}
