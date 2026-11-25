import { useState } from "react";
import { Icon } from "../components/Icon";
import { formatDuration } from "./duration";
import type { TerminalRunItem } from "./reducer";
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

/**
 * A Run from this session (flow 523): the command, where its result stands, the exit code and duration,
 * the output tail behind a toggle, and the run's actions. Every field is the command's or the host's own
 * text, rendered as text, never as markup. A card replayed from history has no actions.
 */
export function TerminalRunCard({ item }: { item: TerminalRunItem }) {
  const [open, setOpen] = useState(false);
  const ended = item.exitCode !== undefined;
  const ok = item.exitCode === 0;
  const live = item.replayed !== true;
  const canSendNow = live && item.state === "running" && !ended && item.tabOpen;
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
      <div className={`run-card-status run-${item.state}`} data-run-status>
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
            <button type="button" className="btn btn-sm btn-ghost" data-run-send-now title="Send the output so far to the agent" onClick={() => sendTerminalRunNow(item.runId)}>
              Send output now
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
