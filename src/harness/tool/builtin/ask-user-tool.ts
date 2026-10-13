// Interactive multiple-choice question tool (Claude Code interview style).
//
// The model proposes a question + options with short descriptions; the TUI
// (or any host) renders a composer-dock picker via the injected `ask` callback
// and returns the chosen option id (or freeform text). Risk `read` — no shell
// mutation — but it blocks the agent turn until the user answers.

import type { InteractiveTool } from "./interactive-tools";

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
 * option with a typed reason. A structural copy of the decisions core's `AskAnswer`.
 */
export type AskUserAnswer = string | { kind: "option"; choice: string; reason?: string } | { kind: "own"; text: string };

export type AskUserFn = (request: AskUserRequest) => Promise<AskUserAnswer>;

/**
 * What the model is told about `ask_user`. It says what each field means and nothing about how the host presents a
 * question: the model must not be able to steer, or guess, how its own question is shown (flow 400, review S-1).
 */
export const ASK_USER_DESCRIPTION =
  "Ask the user an interactive multiple-choice question (Claude-style interview). " +
  "Use when requirements are unclear, for interview steps, or to confirm a plan. " +
  "Provide 2–6 options with short descriptions; mark at most ONE option recommended when sensible (more than one is rejected). " +
  "Whenever you mark an option recommended, ALWAYS set recommendationReason: one sentence on why it is the better choice. " +
  "Input: { question: string, options: [{ id, label, description, recommended? }], recommendationReason?: string, allow_freeform?: boolean, action?: string, irreversible?: boolean, emergency?: string }. " +
  "Returns the chosen option id (or freeform text if allow_freeform). " +
  "irreversible: true means the question decides something that cannot be undone (release, publish, deploy, delete, push, merge to a shared branch, drop, force, reset, tag a version). " +
  "action names that irreversible action (e.g. action: \"release\"). " +
  "policy: { kind, facts } optionally tags a review question with its kind (scope, budget, option_choice, partial_coverage, smaller_slice, slice_order) " +
  "and numeric or boolean facts about the recommended option; only the automatic answerer reads it, as numbers and flags, never as text. " +
  "emergency: \"gate-waiver\" (a gate refusal needs the operator's quote) or \"reduced-reviewer-set\"; the only two cases an automatic review may put to the operator.";

function policyOf(raw: unknown): AskUserPolicy | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { kind, facts } = raw as Record<string, unknown>;
  if (typeof kind !== "string" || kind.trim().length === 0 || kind.length > 64) return undefined;
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return undefined;
  return { kind: kind.trim(), facts: facts as Record<string, unknown> };
}

/**
 * The only two questions an automatic review may put to the operator through
 * `ask_user`: a gate refusal that needs an operator quote (a waiver), and a
 * reduced-reviewer-set decision. Any other question is answered by the host.
 */
export const ASK_USER_EMERGENCIES = ["gate-waiver", "reduced-reviewer-set"] as const;

/** The fewest options a question may carry: with one there is nothing to choose. */
export const MIN_ASK_USER_OPTIONS = 2;

/** A host answers this when the user saw the question and dismissed it. */
export const ASK_USER_CANCEL = "__cancel__";

/** The surface has no way to show a question at all (`--no-tui`, a non-TTY, the readline fallback): nobody was asked. */
export const ASK_USER_NO_HOST = "__no_host__";

export type ParsedAskUser = { ok: true; request: AskUserRequest } | { ok: false; output: string };

/** The validated request a tool call carries, or the error text the model is told. Shared by `invoke` and the auto-mode self-answer. */
export function parseAskUserInput(input: Record<string, unknown>): ParsedAskUser {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question.length === 0) {
    return { ok: false, output: "ask_user requires a non-empty 'question'" };
  }
  const rawOpts = input.options;
  if (!Array.isArray(rawOpts) || rawOpts.length < MIN_ASK_USER_OPTIONS) {
    return { ok: false, output: `ask_user requires at least ${MIN_ASK_USER_OPTIONS} options` };
  }
  // at most one option may carry recommended: true (checked on the raw input, before invalid rows are dropped)
  const flagged = rawOpts.filter((raw) => raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).recommended === true);
  if (flagged.length > 1) {
    return { ok: false, output: `ask_user: ${flagged.length} options are marked recommended; mark at most one and explain it in recommendationReason` };
  }
  const options: AskUserOption[] = [];
  for (const raw of rawOpts) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (id.length === 0 || label.length === 0) {
      continue;
    }
    const description = typeof o.description === "string" ? o.description : "";
    options.push({
      id,
      label,
      description,
      ...(o.recommended === true ? { recommended: true } : {}),
    });
  }
  if (options.length < MIN_ASK_USER_OPTIONS) {
    return { ok: false, output: `ask_user: need at least ${MIN_ASK_USER_OPTIONS} valid options with id+label` };
  }
  const reason = typeof input.recommendationReason === "string" ? input.recommendationReason.trim() : "";
  const policy = policyOf(input.policy);
  return {
    ok: true,
    request: {
      question,
      options,
      ...(reason.length > 0 && options.some((o) => o.recommended === true) ? { recommendationReason: reason } : {}),
      ...(input.allow_freeform === true ? { allowFreeform: true } : {}),
      ...(typeof input.action === "string" && input.action.trim().length > 0 ? { action: input.action.trim() } : {}),
      ...(input.irreversible === true ? { irreversible: true } : {}),
      ...(policy === undefined ? {} : { policy }),
    },
  };
}

/** What `auto` mode chose in place of the user: the model's own recommended option, else the first. Never invented. */
export function selfAnswerAskUser(request: AskUserRequest): { question: string; option: AskUserOption; result: { output: string; isError: false } } {
  const option = request.options.find((o) => o.recommended === true) ?? request.options[0]!;
  return {
    question: request.question,
    option,
    result: {
      output: `[auto mode] chose this without asking the user: id="${option.id}" label="${option.label}"${option.recommended === true ? " (recommended)" : ""}. The user did not answer this question.`,
      isError: false,
    },
  };
}

/**
 * Build the `ask_user` tool. `ask` is injected by the host (TUI wires the
 * composer-dock picker; tests inject a stub).
 */
export function createAskUserTool(ask: AskUserFn): InteractiveTool {
  return {
    definition: {
      name: "ask_user",
      description: ASK_USER_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                recommended: { type: "boolean" },
              },
              required: ["id", "label"],
              additionalProperties: false,
            },
            minItems: MIN_ASK_USER_OPTIONS,
            maxItems: 8,
          },
          recommendationReason: { type: "string" },
          allow_freeform: { type: "boolean" },
          action: { type: "string" },
          irreversible: { type: "boolean" },
          policy: {
            type: "object",
            properties: {
              kind: { type: "string" },
              facts: { type: "object" },
            },
            required: ["kind", "facts"],
            additionalProperties: false,
          },
          emergency: { type: "string", enum: [...ASK_USER_EMERGENCIES] },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input, ctx) => {
      const parsed = parseAskUserInput(input);
      if (!parsed.ok) {
        return { output: parsed.output, isError: true };
      }
      const { options } = parsed.request;
      try {
        const given = await ask({
          ...parsed.request,
          ...(ctx?.untrustedContentSeen === true ? { untrustedContent: true } : {}),
        });
        if (typeof given !== "string" && given.kind === "own") {
          const text = given.text.trim();
          if (text.length === 0) return { output: "User gave an empty own answer; ask again if an answer is needed.", isError: true };
          // said outright, so the model cannot take it for a pick: this is the operator's own answer, not one of the options
          return { output: `User gave their OWN answer (none of the offered options): ${text}`, isError: false };
        }
        const chosen = typeof given === "string" ? given : given.choice;
        const operatorReason = typeof given !== "string" && given.reason !== undefined && given.reason.trim().length > 0 ? given.reason.trim() : undefined;
        const match = options.find((o) => o.id === chosen);
        if (match !== undefined) {
          return {
            output:
              `User selected id="${match.id}" label="${match.label}"${match.recommended === true ? " (recommended)" : ""}` +
              (operatorReason === undefined ? "" : `. The user's reason: ${operatorReason}`),
            isError: false,
          };
        }
        if (chosen === ASK_USER_NO_HOST) {
          return {
            output:
              "No one was asked: this session has no way to show a question to the user. The user did not answer and did not decline. " +
              "Decide with what you have and say which assumption you made, or stop and state what you need.",
            isError: true,
          };
        }
        if (chosen === ASK_USER_CANCEL) {
          return { output: "User cancelled the question (Esc).", isError: true };
        }
        return { output: `User answered (freeform): ${chosen}`, isError: false };
      } catch (cause) {
        return {
          output: `ask_user failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        };
      }
    },
  };
}
