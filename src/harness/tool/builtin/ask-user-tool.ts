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
  /** The irreversible action this question decides (release, delete, push, publish, deploy, ...). */
  action?: string;
  /** True when the question decides an irreversible action. */
  irreversible?: boolean;
}

/**
 * Flow 401: what the host answers with. A bare string is an option id (or typed freeform text that
 * is no option's id), as it always was. `own` is the operator's own answer; `option` is a picked
 * option with a typed reason. A structural copy of the decisions core's `AskAnswer`.
 */
export type AskUserAnswer = string | { kind: "option"; choice: string; reason?: string } | { kind: "own"; text: string };

export type AskUserFn = (request: AskUserRequest) => Promise<AskUserAnswer>;

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
        "Input: { question: string, options: [{ id, label, description, recommended? }], allow_freeform?: boolean, action?: string, irreversible?: boolean }. " +
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
        const given = await ask({
          question,
          options,
          ...(input.allow_freeform === true ? { allowFreeform: true } : {}),
          ...(typeof input.action === "string" && input.action.trim().length > 0 ? { action: input.action.trim() } : {}),
          ...(input.irreversible === true ? { irreversible: true } : {}),
        });
        if (typeof given !== "string" && given.kind === "own") {
          const text = given.text.trim();
          if (text.length === 0) return { output: "User gave an empty own answer; ask again if an answer is needed.", isError: true };
          // said outright, so the model cannot take it for a pick: this is the operator's own answer, not one of the options
          return { output: `User gave their OWN answer (none of the offered options): ${text}`, isError: false };
        }
        const chosen = typeof given === "string" ? given : given.choice;
        const reason = typeof given !== "string" && given.reason !== undefined && given.reason.trim().length > 0 ? given.reason.trim() : undefined;
        const match = options.find((o) => o.id === chosen);
        if (match !== undefined) {
          return {
            output:
              `User selected id="${match.id}" label="${match.label}"${match.recommended === true ? " (recommended)" : ""}` +
              (reason === undefined ? "" : `. The user's reason: ${reason}`),
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
