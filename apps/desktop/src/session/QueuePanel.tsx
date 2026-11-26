import { Icon } from "../components/Icon";
import type { QueuedPrompt } from "./reducer";

interface Props {
  queue: readonly QueuedPrompt[];
  /** A turn is running: Send now stops it first. */
  busy: boolean;
  /** Makes the message the next one sent, stopping the running turn. */
  onForce: (index: number) => void;
  /** Takes the message out of the queue and into the composer. */
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}

/**
 * The messages waiting for the running turn to end, in the order they go out, as `keryx shell` shows its queue:
 * each with Send now, Edit and Delete. A message the app queued itself (an issue launch, resumed issue questions)
 * carries more than its text, so it has no Edit.
 */
export function QueuePanel({ queue, busy, onForce, onEdit, onRemove }: Props) {
  if (queue.length === 0) return null;
  return (
    <section className="queue-panel" aria-label="Queued messages">
      <header className="queue-panel-head">
        <span className="queue-panel-title">Queued · {queue.length}</span>
        <span className="queue-panel-help">
          {busy ? "Sent in order when the turn ends. Send now stops the turn and sends that message." : "Sent in order."}
        </span>
      </header>
      <ol className="queue-panel-list">
        {queue.map((q, i) => {
          const n = i + 1;
          const own = !q.issueLaunchId && !q.resumeIssueQuestions;
          return (
            <li key={q.id} className="queue-row">
              <span className="queue-row-n">{n}</span>
              <span className="queue-row-text" title={q.text} dir="auto">{q.text}</span>
              <span className="queue-row-actions">
                <button className="btn btn-sm" onClick={() => onForce(i)} aria-label={`Send queued message ${n} now`}
                  title={busy ? "Stop the current turn and send this message" : "Send this message next"}>
                  <Icon name="arrowUp" size={12} />Send now
                </button>
                {own ? (
                  <button className="btn btn-sm" onClick={() => onEdit(i)} aria-label={`Edit queued message ${n}`} title="Move back into the message box">
                    <Icon name="pencil" size={12} />Edit
                  </button>
                ) : null}
                <button className="icon-btn icon-btn-sm" onClick={() => onRemove(i)} aria-label={`Delete queued message ${n}`} title="Delete">
                  <Icon name="x" size={12} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
