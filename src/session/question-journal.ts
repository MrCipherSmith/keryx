// Native sessions journal their human questions through the same owner and format the TUI uses (tui/ask-user-bridge.ts
// journaledAskUser, decisions/ask.ts journalAsk): the record is opened, with its arm and recommendation, before the question is
// shown, and the answer is recorded after it, so `/decisions reason|change` and `keryx decisions report` see native decisions too.
// The session's own question service still shows, holds, bounds and expires every question exactly as without the journal.
import { CANCEL_ANSWER, journalAsk } from "../decisions/service";
import { ASK_USER_NO_HOST, type AskUserFn, type AskUserRequest } from "../harness/tool/builtin/ask-user-tool";

/** Where a native question is answered: through Hub (or this session's terminal adapter), never a TUI picker. */
export const NATIVE_DECISION_CHANNEL = "hub";

export interface NativeQuestionJournalOptions {
  cwd: string;
  /** Recorded on every record: a follow-up without a decision id only ever touches this session's own decisions. */
  session: string;
  /** The session's question service. */
  ask: AskUserFn;
  /** Whether `ask` would show this question now; one it would not show is passed through unrecorded, as the TUI passes a hostless one. */
  admissible(request: AskUserRequest): boolean;
  /** The reveal after an answer, which the TUI prints in its transcript. */
  notify(text: string): void;
  /** A journaling step failed; the question went on without it (the journal's own note can name local paths, so it is not passed on). */
  note(): void;
}

export interface NativeQuestionJournal {
  ask: AskUserFn;
  session: string;
  /** The latest decision answered through the journal in this session: what `/decisions reason|change` act on. */
  lastDecisionId(): string | undefined;
}

export function createNativeQuestionJournal(options: NativeQuestionJournalOptions): NativeQuestionJournal {
  let lastDecisionId: string | undefined;
  const ask: AskUserFn = async (request) => {
    if (!options.admissible(request)) return options.ask(request);
    let unshown = false;
    const journaled = journalAsk(async (presented) => {
      const answer = await options.ask(presented);
      // The service refused it after all (a race on its bounds): the question was never shown, so no answer is recorded for it.
      if (answer === ASK_USER_NO_HOST) { unshown = true; return CANCEL_ANSWER; }
      return answer;
    }, {
      cwd: options.cwd, session: options.session, channel: NATIVE_DECISION_CHANNEL,
      // One question per ask_user call: no second, held reason question. The reason comes with the pick, or later through /decisions reason.
      askReason: false,
      notify: options.notify, onNote: () => options.note(), onDecision: (id) => { lastDecisionId = id; },
    });
    const answer = await journaled(request);
    return unshown ? ASK_USER_NO_HOST : answer;
  };
  return { ask, session: options.session, lastDecisionId: () => lastDecisionId };
}
