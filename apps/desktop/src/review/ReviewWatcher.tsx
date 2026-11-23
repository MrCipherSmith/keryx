import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { absoluteTime, errMessage } from "../lib/format";
import { reviewWatcher, type ReviewWatcherAction, type ReviewWatcherKey, type ReviewWatcherSnapshot } from "../platform/reviewWatcher";

type Props = { cwd: string; target: ReviewWatcherKey | null; command?: typeof reviewWatcher; active?: boolean; onPollCompleted?: () => void; onWatchingChange?: (target: ReviewWatcherKey | null) => void; onAccessLost?: ((reason: string) => void) | undefined };

function watcherState(snapshot: ReviewWatcherSnapshot | null, error: string) {
  if (error) return "Status unavailable";
  if (!snapshot) return "Checking…";
  if (snapshot.state === "disabled") return "Off";
  if (snapshot.state === "paused") return "Paused";
  if (!snapshot.installed) return "Needs repair";
  if (snapshot.lastError) return "Poll failed";
  return "Watching";
}

function Timestamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{absoluteTime(value)}</time> : <>Never</>;
}

export function ReviewWatcher({ cwd, target, command = reviewWatcher, active = true, onPollCompleted, onWatchingChange, onAccessLost }: Props) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ReviewWatcherSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [draftMinutes, setDraftMinutes] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const pending = useRef<ReviewWatcherAction["kind"] | null>(null);
  const sequence = useRef(0);
  const previousPoll = useRef<string | null | undefined>(undefined);

  useEffect(() => { if (!active) setOpen(false); }, [active]);

  const request = useCallback(async (action: ReviewWatcherAction) => {
    const mutation = action.kind !== "status";
    if (pending.current && (!mutation || pending.current !== "status")) return;
    const id = ++sequence.current;
    pending.current = action.kind;
    if (mutation) { setWorking(true); setActionError(""); }
    try {
      const result = await command(cwd, target, action);
      if (sequence.current !== id) return;
      const last = previousPoll.current;
      previousPoll.current = result.lastSuccessAt;
      if (target && result.state === "enabled" && result.installed && result.lastSuccessAt && last !== undefined && last !== result.lastSuccessAt) {
        onPollCompleted?.();
      }
      setSnapshot(result);
      setReadError("");
      if (mutation) setDraftMinutes(null);
    } catch (cause) {
      if (sequence.current !== id) return;
      const message = errMessage(cause);
      if (/^access:/i.test(message)) {
        setSnapshot(null);
        setReadError(message);
        onAccessLost?.(message);
      } else if (mutation) setActionError(message);
      else { setReadError(message); setSnapshot(null); }
    } finally {
      if (sequence.current === id) { pending.current = null; setWorking(false); }
    }
  }, [command, cwd, target, onAccessLost, onPollCompleted]);

  useEffect(() => {
    void request({ kind: "status" });
    return () => { sequence.current++; pending.current = null; };
  }, [request]);

  useEffect(() => {
    const refresh = () => { if (!document.hidden) void request({ kind: "status" }); };
    const timer = window.setInterval(refresh, open ? 15000 : 60000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [open, request]);

  const label = watcherState(snapshot, readError);
  const configured = snapshot && snapshot.state !== "disabled";
  const minutes = draftMinutes ?? String(snapshot?.intervalMinutes ?? 5);
  const value = Number(minutes);
  const valid = Number.isInteger(value) && value >= 1 && value <= 1440;
  const canConfigure = !!target && !!snapshot;
  const applyInterval = () => void request({ kind: "enable", intervalMinutes: value });
  const running = snapshot?.state === "enabled";
  const watching = running && snapshot.installed;
  useEffect(() => {
    onWatchingChange?.(watching ? target : null);
  }, [onWatchingChange, watching, target]);
  return <>
    <button className="btn btn-sm" aria-haspopup="dialog" aria-label={'PR watcher · ' + label} title={'PR watcher · ' + label} onClick={() => {
      setOpen(true); void request({ kind: "status" });
    }}><Icon name="clock" size={14} /> <span className="toolbar-label">PR watcher</span> <span className="watcher-indicator">{label}</span></button>
    {active && open && createPortal(<Dialog title="PR watcher" icon="clock" width={500} onClose={() => setOpen(false)} focusRoot
      footer={<button className="btn" onClick={() => setOpen(false)}>Close</button>}>
      <div className="review-watcher">
        <p>{target ? <><strong>{target.repo}</strong> · {target.viewer}</> : "Local schedule for this project"}</p>
        {(!snapshot && !readError) && <span role="status"><Spinner /> Checking schedule…</span>}
        {readError && <div className="watcher-notice" role="alert">{readError} <button className="link-btn"
          onClick={() => void request({ kind: "status" })}>Retry status</button></div>}
        {snapshot && <>
          <dl className="watcher-facts">
            <dt>Status</dt><dd>{label}</dd>
            {configured && <>
              <dt>Schedule</dt><dd>Every {snapshot.intervalMinutes} {snapshot.intervalMinutes === 1 ? "minute" : "minutes"}</dd>
              <dt>System timer</dt><dd>{snapshot.installed ? "Loaded" : "Unloaded"}</dd>
              <dt>Last attempt</dt><dd><Timestamp value={snapshot.lastAttemptAt} /></dd>
              <dt>Last successful poll</dt><dd><Timestamp value={snapshot.lastSuccessAt} /></dd>
            </>}
          </dl>
          {target && snapshot.lastError && <p className="watcher-notice" role="status">Last poll error · {snapshot.lastError}</p>}
          {target && snapshot.recoveryWarning && <p className="watcher-notice" role="status">{snapshot.recoveryWarning}</p>}
          {!target && <p>Reconnect to GitHub to manage the interval and view PR activity.</p>}
          {canConfigure && <p>{snapshot.state === "paused"
            ? "Resuming starts a fresh baseline. Changes made during the pause are skipped."
            : "Checks PRs while this Mac is awake and you are signed in, even after you quit Desktop."}</p>}
          <div className="watcher-controls">
            {canConfigure && snapshot.state !== "paused" && <label>Poll interval (minutes)
              <input type="number" className="input" min={1} max={1440} step={1} value={minutes}
                onChange={e => setDraftMinutes(e.target.value)} disabled={working} />
            </label>}
            {canConfigure && snapshot.state === "disabled" && <button className="btn btn-primary" disabled={!valid || working}
              onClick={applyInterval}>Enable watcher</button>}
            {canConfigure && running && (!snapshot.installed || value !== snapshot.intervalMinutes) && <button className="btn"
              disabled={!valid || working} onClick={applyInterval}>{snapshot.installed ? "Save interval" : "Restore timer"}</button>}
            {running && <button className="btn" disabled={working} onClick={() => void request({ kind: "pause" })}>Pause watcher</button>}
            {canConfigure && snapshot.state === "paused" && <button className="btn btn-primary" disabled={working}
              onClick={() => void request({ kind: "resume" })}>Resume watcher</button>}
          </div>
          {!valid && canConfigure && <p role="alert">Enter a whole number from 1 to 1440 minutes.</p>}
          {actionError && <p className="watcher-notice" role="alert">{actionError}</p>}
          {target && configured && <section className="watcher-history" aria-label="Recent PR activity">
            <h3>Recent PR activity</h3>
            {snapshot.historyAvailable === false ? <p>Reconnect to GitHub to view PR activity.</p> :
              snapshot.events.length ? <ol>{snapshot.events.map((event, i) => <li key={event.at + event.kind + event.number + i}>
              <span><strong>#{event.number}</strong> {event.description}</span><Timestamp value={event.at} />
            </li>)}</ol> : <p>{snapshot.lastSuccessAt ? "No changes recorded yet." : "The first complete poll establishes the baseline."}</p>}
          </section>}
        </>}
      </div>
    </Dialog>, document.body)}
  </>;
}
