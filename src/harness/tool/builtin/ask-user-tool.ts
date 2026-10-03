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
}

export type AskUserFn = (request: AskUserRequest) => Promise<string>;

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
        "Provide 2–6 options with short descriptions; mark at most ONE option recommended when sensible (more than one is rejected). " +
        "Whenever you mark an option recommended, ALWAYS set recommendationReason: one sentence on why it is the better choice. " +
        "Input: { question: string, options: [{ id, label, description, recommended? }], recommendationReason?: string, allow_freeform?: boolean, action?: string, irreversible?: boolean }. " +
        "Returns the chosen option id (or freeform text if allow_freeform). " +
        "If the question decides anything irreversible (release, publish, deploy, delete, push, merge to a shared branch, drop, force, reset, tag a version), " +
        "you MUST set irreversible: true, or name it in action (e.g. action: \"release\"): a question without either may be shown blind, with the recommendation hidden.",
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
          recommendationReason: { type: "string" },
          allow_freeform: { type: "boolean" },
          action: { type: "string" },
          irreversible: { type: "boolean" },
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
      // at most one option may carry recommended: true (checked on the raw input, before invalid rows are dropped)
      const flagged = rawOpts.filter((raw) => raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).recommended === true);
      if (flagged.length > 1) {
        return { output: `ask_user: ${flagged.length} options are marked recommended; mark at most one and explain it in recommendationReason`, isError: true };
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
        const reason = typeof input.recommendationReason === "string" ? input.recommendationReason.trim() : "";
        const chosen = await ask({
          question,
          options,
          ...(reason.length > 0 && options.some((o) => o.recommended === true) ? { recommendationReason: reason } : {}),
          ...(input.allow_freeform === true ? { allowFreeform: true } : {}),
          ...(typeof input.action === "string" && input.action.trim().length > 0 ? { action: input.action.trim() } : {}),
          ...(input.irreversible === true ? { irreversible: true } : {}),
        });
        const match = options.find((o) => o.id === chosen);
        if (match !== undefined) {
          return {
            output: `User selected id="${match.id}" label="${match.label}"${match.recommended === true ? " (recommended)" : ""}`,
            isError: false,
          };
        }
        if (chosen === "__cancel__") {
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
