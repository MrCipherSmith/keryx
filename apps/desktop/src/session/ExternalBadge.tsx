import { Icon } from "../components/Icon";

/**
 * Marks a subagent run by a vendor CLI (Claude, Codex, Antigravity) rather than keryx's own model loop. Tinted with the
 * accent and carrying a terminal glyph, so it reads apart from the grey model and status badges beside it.
 */
export function ExternalBadge({ agentId }: { agentId?: string | undefined }) {
  const who = agentId ? ` (${agentId})` : "";
  return (
    <span className="badge badge-external" title={`Runs an external agent CLI${who}, outside keryx's own model loop`}>
      <Icon name="terminal" size={10} />
      external
    </span>
  );
}
