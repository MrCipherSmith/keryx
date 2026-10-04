// Flow 392: the journal around keryx's own `ask_user` question surface.
//
// `journalAsk(ask, deps)` returns an `ask` with the same shape. Before the host
// shows the question it opens a journal record (so the recommendation is on disk
// first), and in blind mode it hides the mark and shuffles the options. After the
// answer it records the choice and reveals the recommendation. On a deviation it
// asks the human ONCE for an optional reason and the tool result waits for it (no
// timeout; an empty answer is recorded as absent and releases the wait): that is
// the one deliberate wait, by operator decision. The reason can also be added or
// changed later with `/decisions reason <why>`. A blind answer can be changed after
// the reveal (`/decisions change <option>`).
//
// Journaling itself never gets in the way of the question: every journaling step is
// in a try/catch that leaves a note and falls back to the plain question. Only the
// host's own `ask` can throw, exactly as without the journal.
//
// The types are structural copies of the harness' `AskUserFn`, because the core
// zone cannot import the client zone; they are assignable both ways.

import { answerDecision, openDecision, recordReason } from "./journal";
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

/**
 * Flow 401: what a host answers with. A plain string is what it always was (an option id, or typed
 * freeform text that is no option's id). The two objects are the operator's own words said outright:
 * `own` is their own answer (never an option, even when the words equal an option id), `option` is a
 * picked option with a typed reason attached.
 */
export type AskAnswer = string | { kind: "option"; choice: string; reason?: string } | { kind: "own"; text: string };

export type AskFn = (request: AskRequest) => Promise<AskAnswer>;

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
const SKIP_REASON = "skip";
const LATER_REASON = "later";

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

    const given = await ask(opened === undefined ? request : present(request, opened));
    if (opened === undefined || given === CANCEL_ANSWER) return given;
    // the structured forms (flow 401) say outright what a bare string only implies
    const chosen = typeof given === "string" ? given : given.kind === "own" ? given.text : given.choice;
    const reasonGiven = typeof given !== "string" && given.kind === "option" && given.reason !== undefined && given.reason.trim().length > 0 ? given.reason : undefined;

    try {
      const other = typeof given !== "string" && given.kind === "own" ? true : typeof given !== "string" ? false : !request.options.some((option) => option.id === chosen);
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
      // The one deliberate wait (AC6, operator decision): after a deviation the human is asked ONCE for an
      // optional reason and the tool result waits for it. `askReason` is false for any later answer to the
      // same decision, so it is never asked twice. Everything else here stays non-blocking.
      if (reasonGiven !== undefined) {
        // flow 401: the operator typed a reason with the pick, so there is nothing left to ask; the latest reason wins
        await recordReason(deps.cwd, opened.id, reasonGiven, deps.now, { replace: true });
      } else if (result.askReason) {
        await askReasonOnce(ask, deps, opened.id);
      }
    } catch (cause) {
      note(deps, `decision journal: could not record the answer (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    return given;
  };
}

/**
 * Ask for the optional reason, wait for the answer (no timeout), record it. An empty
 * or skipped answer, a cancel, or a failing prompt is recorded as "no reason given":
 * it releases the wait and counts as the one ask. `/decisions reason <why>` can still
 * add or change a reason later. A failure to record is a note, never an error.
 */
async function askReasonOnce(ask: AskFn, deps: JournalAskDeps, id: string): Promise<void> {
  let text: string | undefined;
  try {
    const answer = await ask({
      question: "You chose differently from the recommendation. Why? (optional, asked once)",
      options: [
        { id: SKIP_REASON, label: "No reason", description: "Leave it empty" },
        { id: LATER_REASON, label: "Not now", description: "Skip; you will not be asked again for this question (add one later with /decisions reason <why>)" },
      ],
      allowFreeform: true,
    });
    // the prompt's own row (flow 401) answers with the operator's text; a picked row with its id
    if (typeof answer !== "string") text = answer.kind === "own" ? answer.text : undefined;
    else if (answer !== SKIP_REASON && answer !== LATER_REASON && answer !== CANCEL_ANSWER) text = answer;
  } catch {
    text = undefined;
  }
  try {
    await recordReason(deps.cwd, id, text, deps.now);
  } catch (cause) {
    note(deps, `decision journal: could not record the reason (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}
