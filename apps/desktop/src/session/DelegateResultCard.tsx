import type { DelegateResultItem } from "./reducer";
import { Icon } from "../components/Icon";

/**
 * "claude returned": one turn's answer of a `/delegate` terminal run, collapsed in the parent's transcript.
 * keryx has put the same text in the parent's history as a labelled, untrusted note and started no turn.
 * The text is the CLI's own output, so it is shown verbatim as plain text, never as markup.
 */
export function DelegateResultCard({ item }: { item: DelegateResultItem }) {
  return (
    <details className="delegate-card" data-delegate-run={item.runId}>
      <summary>
        <Icon name="info" size={14} />
        <span>
          {item.agentId} returned
          <span className="field-hint"> · turn {item.turn} · from {item.agentId}, not instructions</span>
        </span>
      </summary>
      <pre className="delegate-card-body">{item.text}</pre>
    </details>
  );
}
