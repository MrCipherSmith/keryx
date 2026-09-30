import type { NormalizedMessage } from "../harness/provider/types";

export type ConversationRewind =
  | { ok: true; history: NormalizedMessage[]; archive: NormalizedMessage[]; removed: number }
  | { ok: false; reason: string };

function sameMessage(left: NormalizedMessage | undefined, right: NormalizedMessage | undefined): boolean {
  return left !== undefined && right !== undefined && left.role === right.role && left.content === right.content;
}

/**
 * Cut the conversation back to just before the user message at `archiveIndex`.
 * The archive is append-only, so its indexes survive `/compact`; the context is
 * cut at the same message when it still holds it, else rebuilt from the archive.
 * The caller syncs the archive with the history first.
 */
export function rewindConversation(input: {
  history: readonly NormalizedMessage[];
  archive: readonly NormalizedMessage[];
  archiveIndex: number;
}): ConversationRewind {
  const { history, archive, archiveIndex } = input;
  if (!Number.isInteger(archiveIndex) || archiveIndex < 0 || archiveIndex >= archive.length) {
    return { ok: false, reason: "That turn is no longer in this session's archive." };
  }
  const target = archive[archiveIndex]!;
  if (target.role !== "user") {
    return { ok: false, reason: "That archive entry is not a user message." };
  }
  const nextArchive = archive.slice(0, archiveIndex);
  const tailStart = history.length - (archive.length - archiveIndex);
  const nextHistory = tailStart >= 0 && sameMessage(history[tailStart], target) ? history.slice(0, tailStart) : nextArchive.slice();
  return { ok: true, history: nextHistory, archive: nextArchive, removed: archive.length - archiveIndex };
}

export type ConversationRewindOutcome = { ok: true; removed: number } | { ok: false; reason: string };

export const REWIND_LEASE_REFUSAL = "This session is held by another process, so a rewind cannot be saved. Nothing was changed.";

/** Persist first, then swap the truncation into the live arrays in place; any failure leaves them untouched. */
export function applyConversationRewind(input: {
  history: NormalizedMessage[];
  archive: NormalizedMessage[];
  archiveIndex: number;
  canPersist: () => boolean;
  persist: (history: readonly NormalizedMessage[], archive: readonly NormalizedMessage[]) => void;
}): ConversationRewindOutcome {
  if (!input.canPersist()) return { ok: false, reason: REWIND_LEASE_REFUSAL };
  const next = rewindConversation(input);
  if (!next.ok) return next;
  try {
    input.persist(next.history, next.archive);
  } catch (error) {
    return { ok: false, reason: `Could not save the rewound session: ${error instanceof Error ? error.message : String(error)}` };
  }
  input.history.splice(0, input.history.length, ...next.history);
  input.archive.splice(0, input.archive.length, ...next.archive);
  return { ok: true, removed: next.removed };
}
