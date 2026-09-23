// Flow 295 (AC7): the agent tools that let the operator ask for a schedule in plain
// language: "schedule me a task every 4 hours to check GitHub".
//
//   schedule_create (risk `write`, operator-confirmed). The model fills the request:
//     cadence, prompt, grants, budget. The tool builds the SAME draft and card as
//     `keryx schedule add` and `/schedule` (`../trigger/schedules.ts`), and the
//     driver shows that card and ASKS the operator. `InteractiveTool.confirmation`
//     makes this a floor that no permission mode lifts: `auto` asks too, the answer
//     is never remembered, and "always" is never offered. Only after the operator's
//     yes does `invoke` store the entry and install the timer. It stores exactly
//     the draft whose card was shown, never a re-draft.
//   schedule_list (risk `read`). What is scheduled, when it runs next, and how it last went.
//
// These tools are offered only to the interactive TUI agent (`binding` present).
// They are never offered to a subagent, an external child, a side worker, or an
// unattended run. `schedule_create` is on the unattended exclusion list as well.

import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { GRANTED_TOOL_CATALOGUE } from "../trigger/granted-tools";
import type { ScheduleHost } from "../trigger/install";
import { confirmSchedule, draftSchedule, listSchedules, type DraftContext, type ScheduleDraft, type ScheduleRequest } from "../trigger/schedules";

export interface ScheduleToolBinding {
  readonly projectRoot: string;
  /** The session's current provider/model, used when the model omits them. */
  readonly defaults?: () => { readonly provider: string; readonly model: string };
  readonly host?: ScheduleHost;
  readonly now?: () => Date;
  readonly resolveProgram?: DraftContext["resolveProgram"];
  readonly accountOf?: DraftContext["accountOf"];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Turn the model's input into a request, or say what is missing. */
export function requestFromToolInput(input: Record<string, unknown>, binding: ScheduleToolBinding): ScheduleRequest | { error: string } {
  const defaults = binding.defaults?.();
  const rates = (input["rates"] ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  const name = str(input["name"]);
  const cadence = str(input["cadence"]);
  const prompt = str(input["prompt"]);
  const provider = str(input["provider"]) ?? defaults?.provider;
  const model = str(input["model"]) ?? defaults?.model;
  const inRate = num(rates["inputUsdPerMTok"]);
  const outRate = num(rates["outputUsdPerMTok"]);
  const ceiling = num(input["ceilingUsd"]);
  if (name === undefined) missing.push("name");
  if (cadence === undefined) missing.push("cadence");
  if (prompt === undefined) missing.push("prompt");
  if (provider === undefined) missing.push("provider");
  if (model === undefined) missing.push("model");
  if (inRate === undefined || outRate === undefined) missing.push("rates {inputUsdPerMTok, outputUsdPerMTok}");
  if (ceiling === undefined) missing.push("ceilingUsd");
  if (missing.length > 0) return { error: `missing ${missing.join(", ")} — ask the operator for what you do not know` };
  const mode = input["permissionMode"];
  const network = input["network"];
  const maxSeconds = num(input["maxSeconds"]);
  return {
    name: name!,
    cadence: cadence!,
    prompt: prompt!,
    provider: provider!,
    model: model!,
    rates: { inputUsdPerMTok: inRate!, outputUsdPerMTok: outRate! },
    ceilingUsd: ceiling!,
    ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    ...(mode === "ask" || mode === "trust" ? { permissionMode: mode } : {}),
    ...(network === "off" || network === "full" ? { network } : {}),
    tools: strings(input["tools"]),
    repos: strings(input["repos"]),
  };
}

export function scheduleTools(binding: ScheduleToolBinding): InteractiveTool[] {
  // The draft whose card the operator saw, keyed by the exact input. Invoke uses
  // it and never re-drafts, so what is stored is what was confirmed.
  const drafts = new Map<string, ScheduleDraft>();
  const key = (input: Record<string, unknown>): string => JSON.stringify(input);

  const create: InteractiveTool = {
    definition: {
      name: "schedule_create",
      description:
        "Propose a SCHEDULED background task: keryx runs an unattended agent on `prompt` at `cadence` and leaves a report " +
        "the operator reads later (the shell's Schedules section, /schedules). The operator ALWAYS sees a confirmation card " +
        "(cadence and next runs, prompt, runner, budget, network, granted tools with the account they act as, what gets " +
        "installed) and must say yes — you cannot confirm it. Granted tools run the operator's own credentials OUTSIDE the " +
        "sandbox and return only redacted output; grant only what the task needs. Ask the operator for rates and a ceiling " +
        "if you do not know them.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "short id: letters, digits, - _ . (max 64)" },
          cadence: { type: "string", description: 'cron, or "every N hours", "every N minutes", "daily at HH:MM", "weekdays at HH:MM"' },
          prompt: { type: "string", description: "the task, in the operator's words, for the scheduled agent" },
          provider: { type: "string", description: "default: this session's provider" },
          model: { type: "string", description: "default: this session's model" },
          rates: {
            type: "object",
            properties: { inputUsdPerMTok: { type: "number" }, outputUsdPerMTok: { type: "number" } },
            required: ["inputUsdPerMTok", "outputUsdPerMTok"],
          },
          ceilingUsd: { type: "number", description: "this schedule's own spend ceiling in USD" },
          maxSeconds: { type: "number", description: "per-run wall-clock limit (default 600)" },
          permissionMode: { type: "string", enum: ["ask", "trust"], description: "ask (default, read-only) or trust" },
          network: { type: "string", enum: ["off", "full"], description: "the scheduled agent's shell network; default off" },
          tools: { type: "array", items: { type: "string", enum: GRANTED_TOOL_CATALOGUE.map((s) => s.id) } },
          repos: { type: "array", items: { type: "string" }, description: "owner/name repositories the granted tools may touch" },
        },
        required: ["name", "cadence", "prompt", "rates", "ceilingUsd"],
        additionalProperties: false,
      },
      risk: "write",
    },
    confirmation: async (input) => {
      const request = requestFromToolInput(input, binding);
      if ("error" in request) return request;
      const drafted = await draftSchedule(request, {
        projectRoot: binding.projectRoot,
        ...(binding.host !== undefined ? { host: binding.host } : {}),
        ...(binding.now !== undefined ? { now: binding.now } : {}),
        ...(binding.resolveProgram !== undefined ? { resolveProgram: binding.resolveProgram } : {}),
        ...(binding.accountOf !== undefined ? { accountOf: binding.accountOf } : {}),
      });
      if (!drafted.ok) return { error: drafted.problems.join("; ") };
      drafts.set(key(input), drafted.draft);
      return { card: drafted.draft.card };
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const draft = drafts.get(key(input));
      drafts.delete(key(input));
      if (draft === undefined) {
        return { output: "schedule_create: no confirmed draft for this request — nothing was written or installed", isError: true };
      }
      try {
        const created = await confirmSchedule(binding.projectRoot, draft, binding.host ?? {});
        return {
          output:
            `Schedule "${created.name}" is stored and installed (${created.backend}: ${created.unit}). It runs at ` +
            `"${draft.cron}"; next: ${draft.nextRuns[0]?.toISOString() ?? "—"}. Reports land in the shell's Schedules section.`,
          isError: false,
        };
      } catch (error) {
        return { output: `schedule_create failed — nothing is scheduled: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };

  const list: InteractiveTool = {
    definition: {
      name: "schedule_list",
      description: "List this project's scheduled background tasks: cadence, enabled or paused, next run, last outcome and cost, last report path.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async (): Promise<InteractiveToolResult> => {
      const rows = await listSchedules(binding.projectRoot, {
        ...(binding.host !== undefined ? { host: binding.host } : {}),
        ...(binding.now !== undefined ? { now: binding.now } : {}),
      });
      if (rows.length === 0) return { output: "no schedules", isError: false };
      return {
        output: rows
          .map(
            (r) =>
              `${r.name} [${r.enabled ? "enabled" : "paused"}] cron "${r.cron}" next ${r.nextRun?.toISOString() ?? "—"} ` +
              `last ${r.last === undefined ? "never" : `${r.last.outcome}${r.last.usd !== undefined ? ` $${r.last.usd.toFixed(4)}` : ""}`} ` +
              `report ${r.reportPath ?? "none"}`,
          )
          .join("\n"),
        isError: false,
      };
    },
  };
  return [create, list];
}
