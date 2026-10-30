import { canonicalDigest, runCommandDigest, sessionCommandDigest, type Control } from "../../remote-control/protocol";
import type { RunRow, StoredCommand } from "./model";
/** A continuing execution binds to the original immutable human operation, never to a refreshed delivery TTL. */
export function executionBinding(command: StoredCommand, run: RunRow): { controller: Control["ControllerBinding"]; association: Control["FlowAssociation"] } | undefined {
  const envelope = command.envelope;
  if (command.machineId !== run.machineId || command.projectId !== run.projectId || envelope.checkoutId !== run.checkoutId || envelope.commandDigest !== run.commandDigest) return undefined;
  if (command.frameType === "command" && envelope.kind === "start-turn") {
    if (envelope.runId !== run.runId || envelope.turnId !== run.turnId || envelope.sessionId !== run.sessionId || runCommandDigest(envelope) !== envelope.commandDigest || canonicalDigest(envelope.body.request.association) !== canonicalDigest(run.association)) return undefined;
    return { controller: envelope.controller, association: envelope.body.request.association };
  }
  if (command.frameType === "session-command" && envelope.kind === "invoke-command" && envelope.target.scope === "run") {
    if (envelope.target.runId !== run.runId || envelope.target.turnId !== run.turnId || envelope.target.sessionId !== run.sessionId || sessionCommandDigest(envelope) !== envelope.commandDigest || !envelope.body.association || canonicalDigest(envelope.body.association) !== canonicalDigest(run.association)) return undefined;
    return { controller: envelope.body.controller, association: envelope.body.association };
  }
  return undefined;
}
