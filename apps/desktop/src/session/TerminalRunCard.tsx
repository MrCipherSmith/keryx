import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { formatDuration } from "./duration";
import type { TerminalRunItem, TerminalRunState } from "./reducer";
import { sendTerminalRunNow, showTerminalRunTab } from "./terminalRunBus";

/** Where the run's result stands, in words. */
export function runStatusText(item: Pick<TerminalRunItem, "state" | "error">): string {
  switch (item.state) {
    case "starting":
      return "starting…";
    case "running":
      return "running…";
    case "waiting":
      return "waiting for the agent's turn to end";
    case "sent":
      return "sent to the agent";
    case "sent-while-running":
      return "output sent to the agent while it was running";
    case "closed":
      return "closed before it finished";
    case "start-failed":
      return `could not start: ${item.error ?? "unknown error"}`;
    case "not-sent":
      return `not sent: ${item.error ?? "unknown reason"}`;
  }
}

/** States whose result never reaches the agent: a change into one is said at once (assertive), the rest politely. */
const UNSENT: ReadonlySet<TerminalRunState> = new Set<TerminalRunState>(["closed", "start-failed", "not-sent"]);

/**
 * A Run from this session (flow 523): the command, where its result stands, the exit code and duration,
 * the output tail behind a toggle, and the run's actions. Every field is the command's or the host's own
 * text, rendered as text, never as markup. A card replayed from history has no actions and no live
 * region. A live card's status line is a live region (`role="status"`) in every state, present from its
 * mount: a screen reader says its text when the run's state changes, never because the card mounted (a
 * reload keeps live cards under new ids and a session switch remounts the transcript, and neither may read
 * old statuses out). A change into a state whose result will not reach the agent is said assertively.
 */
export function TerminalRunCard({ item }: { item: TerminalRunItem }) {
  const [open, setOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  /** "Send output now" was used: when its button goes away the keyboard focus stays in the card. */
  const sendNowUsed = useRef(false);
  const ended = item.exitCode !== undefined;
  const ok = item.exitCode === 0;
  const live = item.replayed !== true;
  const canSendNow = live && item.state === "running" && !ended && item.tabOpen;
  useLayoutEffect(() => {
    if (canSendNow || !sendNowUsed.current) return;
    sendNowUsed.current = false;
    // Only a focus that went nowhere (the removed button's) is taken; one the user moved elsewhere stays.
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) statusRef.current?.focus({ preventScroll: true });
  }, [canSendNow]);
  return (
    <section className="run-card" data-run={item.runId} data-run-state={item.state}>
      <header className="run-card-head">
        <Icon name="terminal" size={14} />
        <code className="run-card-command">{item.command}</code>
        {ended ? (
          <span className={`badge ${ok ? "badge-ok" : "badge-danger"}`} data-run-exit>
            {item.exitCode === null ? "ended by a signal" : `exit ${item.exitCode}`}
          </span>
        ) : null}
        {item.durationMs !== undefined ? (
          <span className="run-card-dur" data-run-duration>
            {formatDuration(item.durationMs)}
          </span>
        ) : null}
      </header>
      <div
        ref={statusRef}
        tabIndex={-1}
        className={`run-card-status run-${item.state}`}
        data-run-status
        role={live ? "status" : undefined}
        aria-live={live ? (UNSENT.has(item.state) ? "assertive" : "polite") : undefined}
      >
        {runStatusText(item)}
      </div>
      {item.output !== undefined ? (
        <div className="run-card-body">
          <button type="button" className="btn btn-sm btn-ghost" data-run-output-toggle aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> Output
          </button>
          {open ? (
            <pre className="out-pre run-card-output" data-run-output>
              {item.output}
            </pre>
          ) : null}
        </div>
      ) : null}
      {live && (item.tabOpen || canSendNow) ? (
        <footer className="run-card-actions">
          {item.tabOpen ? (
            <button type="button" className="btn btn-sm btn-ghost" data-run-show title="Show the run's terminal tab" onClick={() => void showTerminalRunTab(item.runId)}>
              Show tab
            </button>
          ) : null}
          {canSendNow ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-run-send-now
              title="Send the output so far to the agent"
              onClick={() => {
                sendNowUsed.current = true;
                sendTerminalRunNow(item.runId);
              }}
            >
              Send output now
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
