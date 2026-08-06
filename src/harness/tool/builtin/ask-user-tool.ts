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
 * Build the `ask_user` tool. `ask` is injected by the host (TUI wires the
 * composer-dock picker; tests inject a stub).
 */
export function createAskUserTool(ask: AskUserFn): InteractiveTool {
  return {
    // Risk `read` and still not offerable without a person: `invoke` awaits the
    // host's picker, so in a run with no operator it hangs instead of failing.
    // Declared here rather than inferred, because no risk class expresses it.
    requiresApprover: true,
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
