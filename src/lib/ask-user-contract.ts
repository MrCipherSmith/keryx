export interface AskUserOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  /** Set by the decision journal (flow 400): whether the host starts with this option highlighted. Absent: the host preselects the recommended one. */
  preselected?: boolean;
}

export interface AskUserRequest {
  question: string;
  options: AskUserOption[];
  /** Why the recommended option is recommended: for the journal and the reveal after the answer, never shown with the question. */
  recommendationReason?: string;
  /** When true, the host may also accept free text (Enter with empty selection path). */
  allowFreeform?: boolean;
  /** The irreversible action this question decides (release, delete, push, publish, deploy, ...). */
  action?: string;
  /** True when the question decides an irreversible action. */
  irreversible?: boolean;
  /** Which surface asked (journal `source`), set by the host code that asks, never by the model. */
  source?: string;
  /**
   * Flow 425: the question's kind and the structured facts about the recommended option, for the review arbiter. It is
   * the only part of a question the arbiter reads; everything else in the request (question, labels, descriptions) is
   * free text and never reaches the arbiter's prompt. Unvalidated here: the arbiter validates it.
   */
  policy?: AskUserPolicy;
  /**
   * Set by the agent loop, never by the model: untrusted external content was read earlier in this turn, so the
   * question may have been shaped by it and no automatic answerer may decide it.
   */
  untrustedContent?: boolean;
}

export interface AskUserPolicy {
  kind: string;
  facts: Record<string, unknown>;
}

/**
 * Flow 401: what the host answers with. A bare string is an option id (or typed freeform text that
 * is no option's id), as it always was. `own` is the operator's own answer; `option` is a picked
 * option with a typed reason.
 */
export type AskUserAnswer = string | { kind: "option"; choice: string; reason?: string } | { kind: "own"; text: string };

export type AskUserFn = (request: AskUserRequest) => Promise<AskUserAnswer>;

/** A host answers this when the user saw the question and dismissed it. */
export const ASK_USER_CANCEL = "__cancel__";
