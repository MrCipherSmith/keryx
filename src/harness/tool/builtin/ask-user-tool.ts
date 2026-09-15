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
}

export interface AskUserRequest {
  question: string;
  options: AskUserOption[];
  /** When true, the host may also accept free text (Enter with empty selection path). */
  allowFreeform?: boolean;
}

export type AskUserFn = (request: AskUserRequest) => Promise<string>;

/**
 * The answer a host returns when the user pressed Esc on a question the host
 * DID show. A real dismissal: the human saw the options and declined to pick.
 */
export const ASK_USER_CANCEL = "__cancel__";

/**
 * The answer a host returns when the question could NOT reach a human at all —
 * no host registered on this surface (`src/tui/ask-user-bridge.ts`), a picker
 * that could not be mounted, or a host torn down mid-turn.
 *
 * A distinct sentinel rather than a reuse of {@link ASK_USER_CANCEL}, and the
 * reason matters: the two demand opposite next moves. After a real dismissal the
 * honest move is to report the decline; after a question NOBODY ever saw the
 * honest move is to say so. Collapsing them is how a session comes to look like
 * it "answered its own questions": on every surface that registers no host
 * (readline `--no-tui`, a non-TTY, any TUI init fallback) the tool answered
 * "User cancelled the question", the model picked an option itself, and the
 * transcript claimed the user had declined. Fail closed — no answer, and the
 * NAME OF THE CAUSE travels with the result.
 */
export const ASK_USER_UNANSWERABLE = "__unanswerable__";

/** The no-host-registered cause of {@link ASK_USER_UNANSWERABLE}. */
export const ASK_USER_NO_HOST = "__no_host__";

/**
 * Which option an `auto`-mode self-answer picks, when no human will.
 *
 * Extracted and pure so the rule is testable without a terminal or a session:
 * a reviewer inverted an equivalent comparison elsewhere in this repository
 * (`return id === "allow"` making "Deny" approve) and the full suite stayed
 * green. The rule is deliberately narrow — prefer the model's own
 * `recommended` option, else the FIRST one — and it never invents an option,
 * because a fabricated choice is worse than an honest "nobody answered".
 *
 * Returns `undefined` when there is nothing to choose from, which the caller
 * must render as `ASK_USER_UNANSWERABLE` rather than as an answer.
 */
export function chooseSelfAnswer(options: readonly AskUserOption[]): AskUserOption | undefined {
  const recommended = options.find((option) => option.recommended === true);
  return recommended ?? options[0];
}

/**
 * The marker an `auto`-mode self-answer carries into the tool result, so the
 * MODEL also knows nobody answered. Worded as a fact about provenance, not a
 * fake quotation: attributing a choice to a user who never made it is the bug
 * this whole axis exists to close.
 */
export const SELF_ANSWERED_MARKER = "[auto mode] chose this without asking the user";

/**
 * Build the `ask_user` tool. `ask` is injected by the host (TUI wires the
 * composer-dock picker; tests inject a stub).
 */
export function createAskUserTool(ask: AskUserFn): InteractiveTool {
  return {
    definition: {
      name: "ask_user",
      description:
        "Ask the user an interactive multiple-choice question (Claude-style interview). " +
        "Use when requirements are unclear, for interview steps, or to confirm a plan. " +
        "Provide 2–6 options with short descriptions; mark one recommended when sensible. " +
        "Input: { question: string, options: [{ id, label, description, recommended? }], allow_freeform?: boolean }. " +
        "Returns the chosen option id (or freeform text if allow_freeform).",
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
            minItems: 2,
            maxItems: 8,
          },
          allow_freeform: { type: "boolean" },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const question = typeof input.question === "string" ? input.question.trim() : "";
      if (question.length === 0) {
        return { output: "ask_user requires a non-empty 'question'", isError: true };
      }
      const rawOpts = input.options;
      if (!Array.isArray(rawOpts) || rawOpts.length < 2) {
        return { output: "ask_user requires at least 2 options", isError: true };
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
      if (options.length < 2) {
        return { output: "ask_user: need at least 2 valid options with id+label", isError: true };
      }
      try {
        const chosen = await ask({
          question,
          options,
          ...(input.allow_freeform === true ? { allowFreeform: true } : {}),
        });
        const match = options.find((o) => o.id === chosen);
        if (match !== undefined) {
          return {
            output: `User selected id="${match.id}" label="${match.label}"${match.recommended === true ? " (recommended)" : ""}`,
            isError: false,
          };
        }
        if (chosen === ASK_USER_NO_HOST || chosen === ASK_USER_UNANSWERABLE) {
          return {
            output:
              `ask_user was NOT shown to anyone (${
                chosen === ASK_USER_NO_HOST
                  ? "this surface has no question host"
                  : "the question could not be displayed"
              }) — NO answer exists. Do NOT infer, assume, or choose an option on the user's behalf: ` +
              "state the assumption in your reply and proceed, or stop and ask in your reply text.",
            isError: true,
          };
        }
        if (chosen === ASK_USER_CANCEL) {
          return {
            output:
              "The question was dismissed without an answer (Esc), or its picker could not be mounted. " +
              "No option was selected — do not treat this as a user choice.",
            isError: true,
          };
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
