// Flow 392: the journal around keryx's own `ask_user` question surface.
//
// `journalAsk(ask, deps)` returns an `ask` with the same shape. Before the host
// shows the question it opens a journal record (so the recommendation is on disk
// first), and in blind mode it hides the mark and shuffles the options. After the
// answer it records the choice, reveals the recommendation, and returns the
// choice AT ONCE. On a deviation it only says, in the transcript, that a reason
// can be added (`/decisions reason <why>`, or `keryx decisions reason`); it never
// holds the answer for it, and never asks a second question the agent did not ask.
// A blind answer can be changed after the reveal (`/decisions change <option>`).
//
// The journal never gets in the way of the question: every journaling step is in
// a try/catch that leaves a note and falls back to the plain question. Only the
// host's own `ask` can throw, exactly as without the journal.
//
// The types are structural copies of the harness' `AskUserFn`, because the core
// zone cannot import the client zone; they are assignable both ways.

import { answerDecision, openDecision } from "./journal";
import type { FlowContext } from "./context";
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
  /** The irreversible action this question decides (release, delete, push, publish, deploy, ...). Any tag keeps the question out of blind mode. */
  action?: string;
  /** True when the question decides an irreversible action. Keeps it out of blind mode. */
  irreversible?: boolean;
}

export type AskFn = (request: AskRequest) => Promise<string>;

export interface JournalAskDeps {
  cwd: string;
  /** The flow the question belongs to, when it is asked inside one. Wins over `context`. */
  flow?: string | undefined;
  stage?: string | undefined;
  /** Derives the flow and stage when they are not given (see `resolveFlowContext`). */
  context?: (() => Promise<FlowContext>) | undefined;
  /** Where the reveal and the follow-up hints are shown (the transcript). Optional. */
  notify?: ((text: string) => void) | undefined;
  /** A note when journaling failed and the question went on without it. */
  onNote?: ((text: string) => void) | undefined;
  /** Called with the decision id once an answer is on record (what `/decisions reason|change` default to). */
  onDecision?: ((id: string) => void) | undefined;
  /** The session asking: recorded on every record, so `/decisions change` can be held to this session's own decisions. */
  session?: string | undefined;
  random?: (() => number) | undefined;
  now?: (() => Date) | undefined;
}

export const CANCEL_ANSWER = "__cancel__";

function note(deps: JournalAskDeps, text: string): void {
  try {
    deps.onNote?.(text);
  } catch {
    // a failing note sink must not matter either
  }
}

function notify(deps: JournalAskDeps, text: string): void {
  try {
    deps.notify?.(text);
  } catch {
    // nor must a failing transcript
  }
}

const RECOMMEND_WORD = "(?:recommend\\p{L}*|рекоменд\\p{L}*|preferred|suggested)";

/**
 * A "(Recommended)" kind of mark in a label or description: parenthesised or
 * bracketed, a leading "Recommended:", a trailing "- recommended", a star. In
 * blind mode the structured flag is hidden, and so must these be, or the mark is
 * simply shown another way.
 */
export function stripRecommendedMarks(text: string): string {
  const stripped = text
    .replace(new RegExp(`\\s*[\\(\\[\\{][^\\)\\]\\}]*${RECOMMEND_WORD}[^\\)\\]\\}]*[\\)\\]\\}]`, "giu"), "")
    .replace(new RegExp(`^\\s*${RECOMMEND_WORD}\\s*[:\\-\u2013\u2014]\\s*`, "iu"), "")
    .replace(new RegExp(`(?:\\s*[:,\\-\u2013\u2014]\\s*|\\s+)${RECOMMEND_WORD}\\s*[.!]?\\s*$`, "iu"), "")
    .replace(/\s*[\u2B50\u2605\u2606\u2728\u{1F44D}]+\s*/gu, " ");
  return stripped.replace(/\s{2,}/g, " ").trim();
}

function present(request: AskRequest, opened: OpenResult): AskRequest {
  const byId = new Map(request.options.map((option) => [option.id, option]));
  const ordered = opened.order.map((id) => byId.get(id)).filter((option): option is AskOption => option !== undefined);
  const options = ordered.map((option): AskOption => {
    if (opened.showMark) return option;
    const { recommended: _hidden, ...rest } = option;
    const label = stripRecommendedMarks(rest.label);
    return { ...rest, label: label.length > 0 ? label : rest.id, description: stripRecommendedMarks(rest.description) };
  });
  return { ...request, options };
}

export function journalAsk(ask: AskFn, deps: JournalAskDeps): AskFn {
  return async (request) => {
    let opened: OpenResult | undefined;
    try {
      let context: FlowContext = {};
      if (deps.context !== undefined && (deps.flow === undefined || deps.stage === undefined)) {
        try {
          context = await deps.context();
        } catch {
          context = {};
        }
      }
      const recommended = request.options.find((option) => option.recommended === true);
      opened = await openDecision({
        cwd: deps.cwd,
        question: request.question,
        options: request.options.map((option) => ({ id: option.id, label: option.label, description: option.description })),
        // ask_user options carry a description of the option, not a reason for recommending it: no reason is recorded
        recommendation: recommended === undefined ? undefined : { optionId: recommended.id, reason: "" },
        stage: deps.stage ?? context.stage ?? "ask_user",
        flow: deps.flow ?? context.flow,
        flowSource: deps.flow === undefined ? context.flowSource : undefined,
        action: request.action,
        irreversible: request.irreversible,
        session: deps.session,
        random: deps.random,
        now: deps.now,
      });
    } catch (cause) {
      note(deps, `decision journal: could not open a record (${cause instanceof Error ? cause.message : String(cause)})`);
    }

    const chosen = await ask(opened === undefined ? request : present(request, opened));
    if (opened === undefined || chosen === CANCEL_ANSWER) return chosen;

    try {
      const other = !request.options.some((option) => option.id === chosen);
      const result = await answerDecision({ cwd: deps.cwd, id: opened.id, choice: chosen, other, now: deps.now });
      deps.onDecision?.(opened.id);
      const parts: string[] = [];
      if (result.recommendation !== null && opened.mode === "blind") {
        const label = request.options.find((option) => option.id === result.recommendation?.optionId)?.label ?? result.recommendation.optionId;
        const why = result.recommendation.reason.length > 0 ? `: ${result.recommendation.reason}` : "";
        parts.push(`Blind question. The agent recommended "${label}"${why}.`);
        parts.push(result.matched === true ? "You chose the recommended option." : "You chose differently.");
        parts.push("To change your answer: /decisions change <option>.");
      } else if (result.deviation) {
        parts.push("You chose differently from the recommendation.");
      }
      if (parts.length > 0) notify(deps, parts.join(" "));
      // The one, non-blocking offer of a reason (AC6): its own transcript line, shown once per decision
      // (`askReason` is false for any later answer to the same decision), and only after the answer has returned its value path.
      if (result.askReason) notify(deps, `Add a reason for choosing differently, if you want (asked once): /decisions reason <why>`);
    } catch (cause) {
      note(deps, `decision journal: could not record the answer (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    return chosen;
  };
}
