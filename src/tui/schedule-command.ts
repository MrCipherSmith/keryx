// Flow 295 (AC6): `/schedule` in `keryx shell`. It creates a scheduled
// background task from the shell with the same draft, card and confirmation as
// `keryx schedule add` and the agent's `schedule_create`.
//
//   /schedule --name check-github --every "every 4 hours" --rates 3,15 --ceiling 0.5 \
//             --tool gh.pr.list --repo owner/name -- Check my open PRs and summarise
//
// Everything after a bare `--` is the prompt (quotes optional). The provider and
// model default to the session's. It collects the cadence, prompt and grants,
// shows ONE confirmation card through `confirm`, and only on a yes stores the entry
// and installs the timer. Declining writes nothing and installs nothing.
//
// A plain function behind injected `print`/`confirm`, so the handler is tested
// without a terminal. `tui-shell.ts` passes its transcript and card dialog.

import { requestFromArgs } from "../commands/schedule";
import type { ScheduleHost } from "../trigger/install";
import { confirmSchedule, draftSchedule, nestedAgentScheduleRefusal, type DraftContext } from "../trigger/schedules";

export const SCHEDULE_SLASH_USAGE = [
  "usage: /schedule --name <name> --every \"<cadence>\" --rates <in>,<out> --ceiling <usd> [--tool <id>]... [--repo owner/name]...",
  "       [--mode ask|trust] [--network off|full] [--max-seconds N] [--provider P --model M] -- <what the agent should do>",
  'cadence: cron, "every N hours", "every N minutes", "daily at HH:MM", "weekdays at HH:MM"; tools: gh.pr.list, gh.pr.view, gh.pr.checks, gh.issue.list, gh.issue.view, gh.run.list',
  "or just ask the agent: \"schedule a task every 4 hours to check my open PRs\" — it proposes one, you confirm the same card.",
];

/** Split a slash-command argument string like a shell would (quotes, no expansion). */
export function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let has = false;
  for (const ch of raw) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current.length > 0) out.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current.length > 0) out.push(current);
  return out;
}

export interface ScheduleSlashDeps {
  readonly cwd: string;
  readonly defaults: () => { readonly provider: string; readonly model: string };
  readonly print: (line: string, tone?: "ok" | "error" | "dim") => void;
  /** Show the card; resolve true only on the operator's explicit yes. */
  readonly confirm: (card: readonly string[]) => Promise<boolean>;
  readonly host?: ScheduleHost;
  readonly now?: () => Date;
  readonly resolveProgram?: DraftContext["resolveProgram"];
  readonly accountOf?: DraftContext["accountOf"];
  /** M3a: the process environment (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Run `/schedule <raw>`. Returns whether a schedule was created. */
export async function runScheduleSlashCommand(raw: string, deps: ScheduleSlashDeps): Promise<boolean> {
  const nested = nestedAgentScheduleRefusal(deps.env);
  if (nested !== undefined) {
    deps.print(`/schedule: ${nested}`, "error");
    return false;
  }
  const tokens = tokenizeArgs(raw);
  if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
    for (const line of SCHEDULE_SLASH_USAGE) deps.print(line, "dim");
    return false;
  }
  const dash = tokens.indexOf("--");
  const flags = dash >= 0 ? tokens.slice(0, dash) : tokens;
  const promptWords = dash >= 0 ? tokens.slice(dash + 1) : [];
  const defaults = deps.defaults();
  const args = [
    ...flags,
    ...(promptWords.length > 0 ? ["--prompt", promptWords.join(" ")] : []),
    ...(flags.includes("--provider") ? [] : ["--provider", defaults.provider]),
    ...(flags.includes("--model") ? [] : ["--model", defaults.model]),
  ];
  let request;
  try {
    request = requestFromArgs(args);
  } catch (error) {
    deps.print(`/schedule: ${error instanceof Error ? error.message.replace("keryx schedule --help", "/schedule --help") : String(error)}`, "error");
    return false;
  }
  const drafted = await draftSchedule(request, {
    projectRoot: deps.cwd,
    ...(deps.host !== undefined ? { host: deps.host } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.resolveProgram !== undefined ? { resolveProgram: deps.resolveProgram } : {}),
    ...(deps.accountOf !== undefined ? { accountOf: deps.accountOf } : {}),
  });
  if (!drafted.ok) {
    deps.print("/schedule: refused —", "error");
    for (const problem of drafted.problems) deps.print(`  - ${problem}`, "error");
    return false;
  }
  if (!(await deps.confirm(drafted.draft.card))) {
    deps.print("/schedule: not confirmed — nothing was written or installed.", "dim");
    return false;
  }
  try {
    const created = await confirmSchedule(deps.cwd, drafted.draft, deps.host ?? {});
    deps.print(`/schedule: "${created.name}" stored and installed (${created.backend}: ${created.unit}).`, "ok");
    return true;
  } catch (error) {
    deps.print(`/schedule: failed — nothing is scheduled: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}
