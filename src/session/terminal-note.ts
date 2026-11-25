// The grammar of a Run's result note (flow 523): the lines keryx writes for one result of a command
// the operator ran from Keryx Desktop's Run button, and the reader of each. It has one home, below
// both layers that use it (review R2-AR-003): the ACP producer and parser (`src/acp/terminal-result.ts`)
// build and read the note with it, compaction (`compact.ts`) recognises and names a removed note with
// it, and the ACP host finds the run ids a session already stored with it. A rewording here changes
// all of them at once.
//
// Pure: strings and patterns only; importing this reads nothing.

import type { NormalizedMessage } from "../harness/provider/types";

/** A run's id: what a client may send, and what the head line carries. */
export const TERMINAL_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What keryx says about a run in the head line, from validated fields only. */
export type TerminalRunOutcome = { readonly state: "running" } | { readonly state: "exited"; readonly exitCode: number | null };

/** A head line read back into its fields. */
export interface TerminalNoteHead {
  readonly runId: string;
  readonly outcome: TerminalRunOutcome;
}

const OUTCOME_RUNNING = "still running";
const OUTCOME_SIGNAL = "ended by a signal";
const OUTCOME_EXIT = "exit ";
const HEAD_LINE = /^\[terminal run ([A-Za-z0-9_-]{1,64}) result: (?:exit (-?\d+)|(ended by a signal)|(still running))\]$/;

/** The command line of a note: this prefix, then the command as one JSON string. */
export const TERMINAL_NOTE_COMMAND_PREFIX = "command: ";
/** The duration line of a note: this prefix, the whole milliseconds, then {@link TERMINAL_NOTE_DURATION_SUFFIX}. */
export const TERMINAL_NOTE_DURATION_PREFIX = "duration: ";
export const TERMINAL_NOTE_DURATION_SUFFIX = " ms";
/** The line after which a note's output starts. */
export const TERMINAL_NOTE_OUTPUT_LINE = "output:";
/** The envelope tag's name before its nonce: `<terminal-result-<nonce>>`. */
export const TERMINAL_NOTE_TAG_PREFIX = "terminal-result-";

/** The outcome's words in the head line. */
function outcomeText(outcome: TerminalRunOutcome): string {
  if (outcome.state === "running") return OUTCOME_RUNNING;
  return outcome.exitCode === null ? OUTCOME_SIGNAL : `${OUTCOME_EXIT}${outcome.exitCode}`;
}

/** The first line of a note: `[terminal run <runId> result: exit 1 | ended by a signal | still running]`. */
export function terminalNoteHeadLine(runId: string, outcome: TerminalRunOutcome): string {
  return `[terminal run ${runId} result: ${outcomeText(outcome)}]`;
}

/** A head line read back into its fields; `undefined` for any other line. Pure. */
export function parseTerminalNoteHeadLine(line: string): TerminalNoteHead | undefined {
  const match = HEAD_LINE.exec(line);
  const runId = match?.[1];
  if (match === null || runId === undefined) return undefined;
  if (match[4] !== undefined) return { runId, outcome: { state: "running" } };
  if (match[3] !== undefined) return { runId, outcome: { state: "exited", exitCode: null } };
  const exitCode = Number(match[2]);
  return Number.isSafeInteger(exitCode) ? { runId, outcome: { state: "exited", exitCode } } : undefined;
}

/**
 * The head of a note keryx stored in a session's history: an injected harness user message whose
 * first line is a head line. A message the operator typed in that shape is not one, nor is any other
 * message. Pure.
 */
export function storedTerminalNoteHead(message: NormalizedMessage | undefined): TerminalNoteHead | undefined {
  if (message === undefined || message.role !== "user" || message.injected !== true || message.provenance !== "harness") return undefined;
  const newline = message.content.indexOf("\n");
  return parseTerminalNoteHeadLine(newline < 0 ? message.content : message.content.slice(0, newline));
}
