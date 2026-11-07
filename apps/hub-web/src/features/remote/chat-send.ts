import { ApiError } from "../../api/client";
import { remoteGet, type Control } from "../../api/remote";

type Session = Control["SessionRecord"];
type Receipt = Control["TurnReceipt"];

export type OwnChatTurn = {
  before: Session;
  runId: string;
  turnId: string;
  ordinal: number;
};

export function ownChatTurn(before: Session, receipt: Receipt): OwnChatTurn | undefined {
  if (receipt.status !== "admitted" || receipt.sessionId !== before.sessionId ||
      receipt.sessionVersion !== before.version || before.state !== "idle" ||
      before.activeRunId !== null || before.activeTurnId !== null ||
      !receipt.runId || !receipt.turnId || receipt.turnOrdinal !== before.nextTurnOrdinal) return;
  return { before, runId: receipt.runId, turnId: receipt.turnId, ordinal: receipt.turnOrdinal };
}

function sameChatContext(before: Session, current: Session): boolean {
  const a = before.controller;
  const b = current.controller;
  return before.sessionId === current.sessionId && before.projectId === current.projectId &&
    before.machineId === current.machineId && before.checkoutId === current.checkoutId &&
    before.agentProfileId === current.agentProfileId &&
    before.config.configVersion === current.config.configVersion &&
    before.config.policyDigest === current.config.policyDigest &&
    before.config.capabilityDigest === current.config.capabilityDigest &&
    before.queueVersion === current.queueVersion &&
    !!a && !!b && a.state === "held" && b.state === "held" &&
    a.controllerLeaseId === b.controllerLeaseId && a.version === b.version &&
    a.actorId === b.actorId && a.actorKind === b.actorKind;
}

function activeOwnTurn(turn: OwnChatTurn, record: Session) {
  return record.state === "busy" && record.activeRunId === turn.runId && record.activeTurnId === turn.turnId &&
    record.workspaceBaseline === turn.before.workspaceBaseline;
}

export function ownChatTurnCandidate(turn: OwnChatTurn, current: Session): boolean {
  return sameChatContext(turn.before, current) && current.nextTurnOrdinal === turn.ordinal + 1 &&
    current.version > turn.before.version &&
    (activeOwnTurn(turn, current) ||
      current.state === "idle" && current.activeRunId === null && current.activeTurnId === null);
}

/** Only advance across this run's native admission, its idle checkpoint and same-lease renewals.
 * An idle projection with the right ordinal alone could belong to a different run. */
export async function proveOwnChatTurn(
  turn: OwnChatTurn, current: Session, sessionUrl: string, signal?: AbortSignal,
): Promise<boolean> {
  if (!ownChatTurnCandidate(turn, current)) return false;
  const before = turn.before;
  let cursor = before.sessionEventCursor;
  let projection = before;
  let stage: "before" | "busy" | "finished" = "before";
  let renewal: Control["ControllerReceipt"] | undefined;
  for (let pageNumber = 0; pageNumber < 8 && cursor < current.sessionEventCursor; pageNumber++) {
    const page = await remoteGet<Control["SessionEventPage"]>(sessionUrl + "/events?after=" + cursor, signal);
    if (page.gap || !page.events.length) return false;
    for (const event of page.events) {
      if (event.sessionEventSeq > current.sessionEventCursor) break;
      if (event.sessionEventSeq !== cursor + 1 || event.sessionId !== before.sessionId ||
          event.projectId !== before.projectId || event.checkoutId !== before.checkoutId) return false;
      cursor = event.sessionEventSeq;
      if (renewal && event.kind !== "session-state") return false;
      if (event.kind === "controller-changed") {
        const receipt = event.receipt;
        const lease = projection.controller;
        if (stage === "before" || !lease || receipt.sessionVersion !== projection.version + 1 ||
            !sameChatContext(projection, { ...projection, controller: receipt.lease }) ||
            receipt.lease.sessionId !== lease.sessionId ||
            !(Date.parse(receipt.lease.expiresAt) >= Date.parse(lease.expiresAt))) return false;
        renewal = receipt;
      } else if (event.kind === "session-state") {
        const next = event.session;
        if (!sameChatContext(before, next) || next.nextTurnOrdinal !== turn.ordinal + 1 ||
            next.version !== projection.version + 1) return false;
        if (renewal) {
          if (next.controller?.expiresAt !== renewal.lease.expiresAt || next.state !== projection.state ||
              next.activeRunId !== projection.activeRunId || next.activeTurnId !== projection.activeTurnId ||
              next.workspaceBaseline !== projection.workspaceBaseline) return false;
          renewal = undefined;
        } else {
          if (next.controller?.expiresAt !== projection.controller?.expiresAt) return false;
          if (stage === "before" && activeOwnTurn(turn, next)) stage = "busy";
          else if (stage === "busy" && next.state === "idle" &&
              next.activeRunId === null && next.activeTurnId === null) stage = "finished";
          else return false;
        }
        projection = next;
      } else if (event.kind === "turn-admitted") {
        if (stage !== "before" || event.runId !== turn.runId || event.turnId !== turn.turnId ||
            event.turnOrdinal !== turn.ordinal) return false;
      } else if (event.kind === "queue-changed" ||
          event.kind === "message" && (event.message.runId !== turn.runId || event.message.turnId !== turn.turnId)) {
        return false;
      }
    }
    if (!page.hasMore) break;
  }
  return !renewal && cursor === current.sessionEventCursor && projection.version === current.version &&
    projection.workspaceBaseline === current.workspaceBaseline &&
    projection.controller?.expiresAt === current.controller?.expiresAt &&
    (current.state === "idle" ? stage === "finished" : stage === "busy");
}

export function chatTurnProofKey(scope: number, turn: OwnChatTurn, current: Session) {
  return [scope, current.projectId, "chat-turn-proof", current.sessionId, turn.runId, current.version, current.sessionEventCursor];
}

export function isStaleChatSend(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "stale-version";
}

export function isUncertainChatSend(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}
