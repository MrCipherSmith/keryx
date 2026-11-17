// `/goal <text>` over `keryx acp --profile shell` (specification §3.9.5a).
//
// A command is not a turn: it holds no prompt slot and adds no user message. `/goal` is a
// command that STARTS a turn, so it does what the shells do before the model is called (parse,
// validate `--workspace`, open the slate, bind the workspace — `prepareGoalRun`, the very code
// `runGoalCommand` runs) and then hands the turn text back to the client, which sends it as an
// ordinary `session/prompt` on the same session. The turn it starts is the one that enters history.
//
// `--auto` is refused: its continuation loop and verifier run inside `runGoalCommand`, as turns
// the shell drives itself; here every turn is the client's `session/prompt`.

import { parseGoalArgs, prepareGoalRun } from "../commands/goal-command";
import type { AgentIO } from "../commands/agent";
import type { NormalizedMessage } from "../harness/provider/types";
import { mintTimestampAttemptId, type SlateSessionRef } from "../session/slate-lifecycle";

export interface AcpGoalHost {
  readonly cwd: string;
  readonly history: NormalizedMessage[];
  /** `undefined` when the session has no directory to keep a slate in. */
  slate(): SlateSessionRef | undefined;
  modelIds(): { providerId: string; modelId: string };
  /** The history changed (an Anchors announcement): the archive is synced the way a turn syncs it. */
  onHistoryChange(): void;
  /** The turn text the client is about to send, so the turn that carries it skips the close-phrase check. */
  goalStarted(prompt: string): void;
}

export interface AcpGoalAnswer {
  readonly text: string;
  readonly refused?: true;
  /** Present when the client must start a turn with exactly this text. */
  readonly prompt?: string;
}

export const GOAL_AUTO_REFUSAL =
  "/goal --auto drives its own continuation rounds and verifier turn, which only keryx shell runs; send the goal without --auto and continue from the transcript.";

export async function runAcpGoal(host: AcpGoalHost, args: string): Promise<AcpGoalAnswer> {
  const parsed = parseGoalArgs(args);
  if ("error" in parsed) return { text: `/goal: ${parsed.error}\n`, refused: true };
  if (parsed.auto !== undefined) return { text: `${GOAL_AUTO_REFUSAL}\n`, refused: true };

  const lines: string[] = [];
  const say = (text: string): void => {
    lines.push(text);
  };
  const io: AgentIO = {
    write: say,
    onSystem: say,
    onHistoryChange: () => host.onHistoryChange(),
  };
  const { providerId, modelId } = host.modelIds();
  const prepared = await prepareGoalRun({
    raw: args,
    parsed,
    cwd: host.cwd,
    io,
    model: { providerId, modelId },
    history: host.history,
    slateSession: host.slate(),
    mintAttemptId: mintTimestampAttemptId,
  });
  const notes = lines.join("");
  // Refused before the first turn (a rejected `--workspace`): the reason is what the shell printed.
  if (prepared === undefined) return { text: notes.length > 0 ? notes : "/goal was not started.\n", refused: true };
  host.goalStarted(prepared.parsed.text);
  return { text: `${notes}Starting a turn on the goal.\n`, prompt: prepared.parsed.text };
}
