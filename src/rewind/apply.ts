import type { NormalizedMessage } from "../harness/provider/types";
import { applyConversationRewind, REWIND_LEASE_REFUSAL } from "./history";
import type { RewindRecorder } from "./recorder";

export type RewindMode = "files" | "history" | "both";

export interface RewindApplyInput {
  recorder: RewindRecorder;
  seq: number;
  mode: RewindMode;
  history: NormalizedMessage[];
  archive: NormalizedMessage[];
  canPersist: () => boolean;
  persist: (history: readonly NormalizedMessage[], archive: readonly NormalizedMessage[]) => void;
}

export interface RewindApplyOutcome {
  ok: boolean;
  historyRewound: boolean;
  filesRestored: boolean;
  lines: string[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Files first: a failure there stops before the conversation is touched, and a
 * file rewind can be undone through its pre-rewind snapshot, a history cut cannot.
 */
export async function applyRewind(input: RewindApplyInput): Promise<RewindApplyOutcome> {
  const lines: string[] = [];
  const wantsHistory = input.mode !== "files";
  const wantsFiles = input.mode !== "history";
  if (!input.canPersist()) return { ok: false, historyRewound: false, filesRestored: false, lines: [REWIND_LEASE_REFUSAL] };
  const target = input.recorder.entries().find((entry) => entry.seq === input.seq);
  if (target === undefined) return { ok: false, historyRewound: false, filesRestored: false, lines: [`Snapshot ${input.seq} no longer exists.`] };
  if (wantsHistory && target.archiveIndex === null) {
    return { ok: false, historyRewound: false, filesRestored: false, lines: ["That snapshot has no conversation position, so only files can be rolled back."] };
  }

  let filesRestored = false;
  if (wantsFiles) {
    const files = await input.recorder.restoreFiles(input.seq);
    if (!files.ok) return { ok: false, historyRewound: false, filesRestored: false, lines: [files.reason] };
    filesRestored = true;
    const parts = [
      files.restored.length > 0 ? `restored ${plural(files.restored.length, "file")}` : "",
      files.recreated.length > 0 ? `recreated ${plural(files.recreated.length, "file")}` : "",
      files.removed.length > 0 ? `removed ${plural(files.removed.length, "file")}` : "",
    ].filter((part) => part.length > 0);
    lines.push(parts.length > 0 ? `Files: ${parts.join(", ")}.` : "Files: already matched that snapshot.");
    lines.push(`Undo point: snapshot ${files.preRewindSeq} holds the tree from just before this rewind.`);
    if (files.skipped.length > 0) lines.push(`Left as they are (over 5 MB): ${files.skipped.join(", ")}`);
  }

  let historyRewound = false;
  if (wantsHistory) {
    const conversation = applyConversationRewind({
      history: input.history,
      archive: input.archive,
      archiveIndex: target.archiveIndex!,
      canPersist: input.canPersist,
      persist: input.persist,
    });
    if (!conversation.ok) {
      lines.push(`History: ${conversation.reason}`);
      return { ok: false, historyRewound: false, filesRestored, lines };
    }
    historyRewound = true;
    lines.push(`History: removed ${plural(conversation.removed, "message")} from the conversation.`);
  }
  return { ok: true, historyRewound, filesRestored, lines };
}
