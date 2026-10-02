// Flow 392: the journal around keryx's own `ask_user` question surface.
//
// `journalAsk(ask, deps)` returns an `ask` with the same shape. Before the host
// shows the question it opens a journal record (so the recommendation is on disk
// first), and in blind mode it hides the mark and shuffles the options. After the
// answer it records the choice, reveals the recommendation, and, on a deviation,
// asks the human ONCE for an optional reason.
//
// The journal never gets in the way of the question: every journaling step is in
// a try/catch that leaves a note and falls back to the plain question. Only the
// host's own `ask` can throw, exactly as without the journal.
//
// The types are structural copies of the harness' `AskUserFn`, because the core
// zone cannot import the client zone; they are assignable both ways.

import { answerDecision, openDecision, recordReason } from "./journal";
import type { OpenResult } from "./types";

export interface AskOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface AskRequest {
  question: string;
  options: AskOption[];
  allowFreeform?: boolean;
}

export type AskFn = (request: AskRequest) => Promise<string>;

export interface JournalAskDeps {
  cwd: string;
  /** The flow the question belongs to, when it is asked inside one. */
  flow?: string | undefined;
  stage?: string | undefined;
  /** Where the reveal and notes are shown (the transcript). Optional. */
  notify?: ((text: string) => void) | undefined;
  /** A note when journaling failed and the question went on without it. */
  onNote?: ((text: string) => void) | undefined;
  random?: (() => number) | undefined;
  now?: (() => Date) | undefined;
}

export const CANCEL_ANSWER = "__cancel__";
const SKIP_REASON = "skip";
const LATER_REASON = "later";

function note(deps: JournalAskDeps, text: string): void {
  try {
    deps.onNote?.(text);
  } catch {
    // a failing note sink must not matter either
  }
}

function present(request: AskRequest, opened: OpenResult): AskRequest {
  const byId = new Map(request.options.map((option) => [option.id, option]));
  const ordered = opened.order.map((id) => byId.get(id)).filter((option): option is AskOption => option !== undefined);
  const options = ordered.map((option): AskOption => {
    if (opened.showMark) return option;
    const { recommended: _hidden, ...rest } = option;
    return rest;
  });
  return { ...request, options };
}

export function journalAsk(ask: AskFn, deps: JournalAskDeps): AskFn {
  return async (request) => {
    let opened: OpenResult | undefined;
    try {
      const recommended = request.options.find((option) => option.recommended === true);
      opened = await openDecision({
        cwd: deps.cwd,
        question: request.question,
        options: request.options.map((option) => ({ id: option.id, label: option.label, description: option.description })),
        recommendation: recommended === undefined ? undefined : { optionId: recommended.id, reason: recommended.description },
        stage: deps.stage ?? "ask_user",
        flow: deps.flow,
        random: deps.random,
        now: deps.now,
      });
    } catch (cause) {
      note(deps, `decision journal: could not open a record (${cause instanceof Error ? cause.message : String(cause)})`);
    }

    const chosen = await ask(opened === undefined ? request : present(request, opened));
    if (opened === undefined || chosen === CANCEL_ANSWER) return chosen;

    try {
      const result = await answerDecision({ cwd: deps.cwd, id: opened.id, choice: chosen, now: deps.now });
      if (result.recommendation !== null && opened.mode === "blind") {
        const label = request.options.find((option) => option.id === result.recommendation?.optionId)?.label ?? result.recommendation.optionId;
        const verdict = result.matched === true ? "You chose the recommended option." : "You chose differently.";
        const reason = result.recommendation.reason.length > 0 ? `: ${result.recommendation.reason}` : "";
        deps.notify?.(`Blind question. The agent recommended "${label}"${reason}. ${verdict}`);
      }
      if (result.askReason) await askReasonOnce(ask, deps, opened.id);
    } catch (cause) {
      note(deps, `decision journal: could not record the answer (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    return chosen;
  };
}

async function askReasonOnce(ask: AskFn, deps: JournalAskDeps, id: string): Promise<void> {
  let text: string | undefined;
  try {
    const answer = await ask({
      question: "You chose differently from the recommendation. Why? (optional, asked once)",
      options: [
        { id: SKIP_REASON, label: "No reason", description: "Leave it empty" },
        { id: LATER_REASON, label: "Not now", description: "Skip; you will not be asked again for this question" },
      ],
      allowFreeform: true,
    });
    if (answer !== SKIP_REASON && answer !== LATER_REASON && answer !== CANCEL_ANSWER) text = answer;
  } catch {
    text = undefined;
  }
  try {
    await recordReason(deps.cwd, id, text, deps.now);
  } catch (cause) {
    note(deps, `decision journal: could not record the reason (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}
