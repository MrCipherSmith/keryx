import type { NormalizedMessage } from "../harness/provider/types";
import { applyRewind, type RewindMode } from "./apply";
import { availableRewindModes, formatRewindConfirmLines, formatRewindListLines } from "./format";
import { REWIND_LEASE_REFUSAL } from "./history";
import { rewindDisabledByEnv, type RewindRecorder } from "./recorder";

export interface RewindReadlineContext {
  recorder: RewindRecorder;
  hasSession: () => boolean;
  history: () => NormalizedMessage[];
  archive: () => NormalizedMessage[];
  syncArchive: () => void;
  canPersist: () => boolean;
  persist: (history: readonly NormalizedMessage[], archive: readonly NormalizedMessage[]) => void;
  /** Called after the conversation was cut, so the host can re-anchor its archive cursor. */
  afterHistoryRewind: () => void;
}

export interface RewindReadlineCommand {
  run(rest: string): Promise<string>;
  /** Any other input line withdraws a pending confirmation. */
  cancelPending(): void;
}

const USAGE = "Usage: /rewind [N [files|history|both]] · /rewind confirm";
const MODES: readonly RewindMode[] = ["files", "history", "both"];

/** `/rewind` for the plain shell: list, preview a pick, then `/rewind confirm` applies it. */
export function createRewindReadlineCommand(ctx: RewindReadlineContext): RewindReadlineCommand {
  let pending: { seq: number; mode: RewindMode } | undefined;

  const list = async (): Promise<string> => {
    const listings = await ctx.recorder.describe();
    const lines = formatRewindListLines(listings, -1, { numbered: true });
    if (listings.length === 0) return `${lines.join("\n")}\n`;
    return `${lines.join("\n")}\n\nPick one: /rewind N [files|history|both] — default is files.\n`;
  };

  const preview = async (seq: number, mode: RewindMode): Promise<string> => {
    const listing = (await ctx.recorder.describe()).find((entry) => entry.seq === seq);
    if (listing === undefined) return `No snapshot ${seq}. Run /rewind to see the list.\n`;
    if (!availableRewindModes(listing).includes(mode)) return "That snapshot can only roll back files. Use: /rewind N files\n";
    pending = { seq, mode };
    return `${formatRewindConfirmLines(listing, mode, "Type /rewind confirm to apply. Any other input cancels.").join("\n")}\n`;
  };

  const confirm = async (): Promise<string> => {
    const choice = pending;
    pending = undefined;
    if (choice === undefined) return "Nothing to confirm. Pick a snapshot first: /rewind N [files|history|both]\n";
    if (!ctx.canPersist()) return `${REWIND_LEASE_REFUSAL}\n`;
    ctx.syncArchive();
    const outcome = await applyRewind({
      recorder: ctx.recorder,
      seq: choice.seq,
      mode: choice.mode,
      history: ctx.history(),
      archive: ctx.archive(),
      canPersist: ctx.canPersist,
      persist: ctx.persist,
    });
    if (outcome.historyRewound) ctx.afterHistoryRewind();
    return `${outcome.lines.join("\n")}\n`;
  };

  return {
    cancelPending() {
      pending = undefined;
    },
    async run(rest) {
      if (rewindDisabledByEnv()) return "Rewind is off (KERYX_REWIND=off), so no snapshots are recorded.\n";
      if (!ctx.hasSession()) return "No persistent session, so nothing is snapshotted.\n";
      if (!ctx.canPersist()) return `${REWIND_LEASE_REFUSAL}\n`;
      const words = rest.trim().split(/\s+/).filter((word) => word.length > 0);
      if (words.length === 0) {
        pending = undefined;
        return list();
      }
      if (words[0] === "confirm" && words.length === 1) return confirm();
      const seq = Number(words[0]);
      const mode = (words[1] ?? "files") as RewindMode;
      if (!Number.isInteger(seq) || seq < 1 || words.length > 2 || !MODES.includes(mode)) {
        pending = undefined;
        return `${USAGE}\n`;
      }
      return preview(seq, mode);
    },
  };
}
