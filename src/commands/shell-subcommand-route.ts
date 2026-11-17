// Routing of the shared text subcommands into the terminal shells (Keryx Desktop Client M2a,
// specification §3.9.1, decision D-10).
//
// `shell-subcommands.ts` holds the actions the modals used to own; `src/acp/shell-views-*.ts`
// calls them for the desktop. This module is the terminal's side: it recognizes the same
// command lines (`/schedules pause nightly`, `/routing set coding anthropic/sonnet`, ...),
// says whether the action needs a yes first, and runs it. The full-screen shell and the
// readline REPL each bring their own confirmation surface; the vocabulary and the questions
// asked live here once, so the two cannot drift apart.
//
// A bare command (`/schedules`, `/routing`, ...) and a command with a name or an unknown word
// are not matched: they keep opening their modal exactly as before.

import { loadTriggerLedgerView } from "../tui/trigger-ledger";
import { readRoutingSettings, type RoutingLocation } from "../harness/routing/settings";
import { describeLayerForApproval } from "../harness/routing/trust";
import {
  acRecheck,
  ciTriage,
  conformRun,
  governanceCheck,
  governanceClose,
  governanceRun,
  jevProfileApply,
  jevProfileSet,
  reviewDecide,
  routingSet,
  routingTrust,
  scheduleDelete,
  schedulePause,
  scheduleResume,
  taskSubmit,
  triggerRunNow,
  type ActionResult,
} from "./shell-subcommands";

/** The actions a match runs. Production code uses the real ones; a test passes recorders. */
export interface SharedSubcommandActions {
  readonly routingSet: typeof routingSet;
  readonly routingTrust: typeof routingTrust;
  readonly jevProfileSet: typeof jevProfileSet;
  readonly jevProfileApply: typeof jevProfileApply;
  readonly reviewDecide: typeof reviewDecide;
  readonly triggerRunNow: typeof triggerRunNow;
  readonly schedulePause: typeof schedulePause;
  readonly scheduleResume: typeof scheduleResume;
  readonly scheduleDelete: typeof scheduleDelete;
  readonly governanceRun: typeof governanceRun;
  readonly governanceCheck: typeof governanceCheck;
  readonly governanceClose: typeof governanceClose;
  readonly acRecheck: typeof acRecheck;
  readonly ciTriage: typeof ciTriage;
  readonly conformRun: typeof conformRun;
  readonly taskSubmit: typeof taskSubmit;
}

export const DEFAULT_SHARED_SUBCOMMAND_ACTIONS: SharedSubcommandActions = {
  routingSet,
  routingTrust,
  jevProfileSet,
  jevProfileApply,
  reviewDecide,
  triggerRunNow,
  schedulePause,
  scheduleResume,
  scheduleDelete,
  governanceRun,
  governanceCheck,
  governanceClose,
  acRecheck,
  ciTriage,
  conformRun,
  taskSubmit,
};

export interface SharedSubcommandContext {
  readonly cwd: string;
  /** The user config directory routing settings are read from (default: the standard one). */
  readonly configDir?: string | undefined;
  readonly actions?: SharedSubcommandActions;
}

export interface SharedSubcommand {
  /** The command, lower-cased, with its slash: `/schedules`. */
  readonly command: string;
  /** The word after it: `pause`. */
  readonly verb: string;
  /**
   * The question to answer before the action runs, or absent when it needs none. Destructive,
   * costly and data-sending actions have one; the shell shows it on its own yes/no surface and
   * never runs the action unasked.
   */
  readonly confirm?: () => Promise<string>;
  readonly run: () => Promise<ActionResult>;
}

/** The subcommand words each command takes (everything else keeps its modal or its own parser). */
const VERBS: Readonly<Record<string, readonly string[]>> = {
  "/routing": ["set", "trust"],
  "/jevprofile": ["set", "apply"],
  "/review": ["accept", "accept-ack", "decline"],
  "/triggers": ["run"],
  "/schedules": ["pause", "resume", "delete", "run"],
  "/governance": ["run", "check", "close"],
  "/ac": ["recheck"],
  "/ci": ["triage"],
  "/conform": ["run"],
};

const CI_CONFIRM = "Triage sends a redacted, bounded excerpt of this job's failed log to the configured Jev/OpenRouter model. Continue?";
const CONFORM_CONFIRM = "Conformance sends the reference clauses and the diff's hunks to the configured Jev/OpenRouter model. Continue?";

/**
 * The forms this shell takes on the command line that the full-screen shell also opens as modals,
 * for the readline `/help`: those commands have no bare form here, only these.
 */
export const SHARED_SUBCOMMAND_HELP = [
  "Also typed as one line (asks [y/N] first when it deletes, spends or decides):",
  "  /schedules pause|resume|run|delete <name> · /triggers run <name> · /governance run | check <flow> | close <flow>",
  "  /routing set <category> <provider/model | baseline> · /routing trust · /jevprofile set <key> on|off · /jevprofile apply",
  "  /review accept|accept-ack|decline <workspace id> <proposal id> · /ac recheck <flow> · /ci triage <run> [job]",
  "  /conform run <target> <document> · /task <mode> <description> [|| criterion; criterion]",
  "",
].join("\n");

/** The command words this module can answer, for a caller that wants to look before parsing. */
export function sharedSubcommandCommands(): readonly string[] {
  return [...Object.keys(VERBS), "/task"];
}

/**
 * Whether `line` is one of the shared forms. Undefined for a bare command, a command with an
 * argument that is not one of its subcommand words (a schedule or trigger name, a bad word), and
 * any line that is not a command at all.
 */
export function matchSharedSubcommand(line: string, context: SharedSubcommandContext): SharedSubcommand | undefined {
  const words = line.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined || !first.startsWith("/")) return undefined;
  const command = first.toLowerCase();
  const rest = words.slice(1);
  const actions = context.actions ?? DEFAULT_SHARED_SUBCOMMAND_ACTIONS;
  const { cwd } = context;
  const location: RoutingLocation = { cwd, ...(context.configDir !== undefined ? { configDir: context.configDir } : {}) };

  if (command === "/task") {
    if (rest.length === 0) return undefined;
    const args = line.trim().slice(first.length).trim();
    return {
      command,
      verb: rest[0] as string,
      confirm: async () => "Start this task on the Team Hub this checkout is connected to?",
      run: () => actions.taskSubmit(cwd, args),
    };
  }

  const verbs = VERBS[command];
  const verb = rest[0]?.toLowerCase();
  if (verbs === undefined || verb === undefined || !verbs.includes(verb)) return undefined;
  const args = rest.slice(1).join(" ");
  // A form with a missing argument answers its usage line: nothing to ask about, nothing to run.
  const takesNoArgs = `${command} ${verb}` === "/routing trust" || `${command} ${verb}` === "/jevprofile apply" || `${command} ${verb}` === "/governance run";
  const make = (run: () => Promise<ActionResult>, confirm?: () => Promise<string>): SharedSubcommand => ({
    command,
    verb,
    ...(confirm !== undefined && (takesNoArgs || args.length > 0) ? { confirm } : {}),
    run,
  });
  const ask = (text: string) => async (): Promise<string> => text;

  switch (`${command} ${verb}`) {
    case "/routing set":
      return make(() => actions.routingSet(location, args));
    case "/routing trust":
      return make(
        async () => actions.routingTrust(location),
        async () => {
          const lines = routingTrustLines(location);
          return `Approve routing.config.json?${lines.length > 0 ? `\n${lines.join("\n")}` : ""}`;
        },
      );
    case "/jevprofile set":
      return make(() => actions.jevProfileSet(cwd, args));
    case "/jevprofile apply":
      return make(() => actions.jevProfileApply(cwd), ask("Apply the recommended review.jev profile to this project's tasks.config.json?"));
    case "/review accept": {
      const proposal = args.split(/\s+/)[1] ?? "this proposal";
      return make(() => actions.reviewDecide(cwd, verb, args), ask(`Accept proposal ${proposal}? This writes to the owning wiki, memory or skill.`));
    }
    case "/review accept-ack": {
      const proposal = args.split(/\s+/)[1] ?? "this proposal";
      return make(() => actions.reviewDecide(cwd, verb, args), ask(`Accept ${proposal} and state that you read the evidence's security findings?`));
    }
    case "/review decline": {
      const proposal = args.split(/\s+/)[1] ?? "this proposal";
      return make(() => actions.reviewDecide(cwd, verb, args), ask(`Decline proposal ${proposal}?`));
    }
    case "/triggers run":
      return make(() => actions.triggerRunNow(cwd, args), () => runNowQuestion(cwd, args, false));
    case "/schedules run":
      return make(() => actions.triggerRunNow(cwd, args, { schedule: true }), () => runNowQuestion(cwd, args, true));
    case "/schedules pause":
      return make(() => actions.schedulePause(cwd, args));
    case "/schedules resume":
      return make(() => actions.scheduleResume(cwd, args));
    case "/schedules delete":
      return make(() => actions.scheduleDelete(cwd, args), ask(`Delete schedule ${args}? This uninstalls its timer and removes the entry.`));
    case "/governance run":
      return make(() => actions.governanceRun(cwd));
    case "/governance check":
      return make(() => actions.governanceCheck(cwd, args));
    case "/governance close":
      return make(
        () => actions.governanceClose(cwd, args),
        ask(`Complete flow ${args}? This runs \`keryx flow complete\` and marks the flow done if every gate passes.`),
      );
    case "/ac recheck":
      return make(
        () => actions.acRecheck(cwd, args),
        ask(`Re-check flow ${args}'s frozen criteria against its diff? This may ask the configured Jev model.`),
      );
    case "/ci triage":
      return make(() => actions.ciTriage(cwd, args), ask(CI_CONFIRM));
    case "/conform run":
      return make(() => actions.conformRun(cwd, args), ask(CONFORM_CONFIRM));
    default:
      return undefined;
  }
}

function routingTrustLines(location: RoutingLocation): readonly string[] {
  try {
    const settings = readRoutingSettings(location);
    if (settings.project.trusted || settings.project.layer === undefined) return [];
    return describeLayerForApproval(settings.project.layer);
  } catch {
    return [];
  }
}

/** `Run X now?`, with the dispatch ceiling when the entry spends money. */
async function runNowQuestion(cwd: string, name: string, schedule: boolean): Promise<string> {
  const base = `Run ${name} now (keryx trigger run${schedule ? " --schedule" : ""} ${name})?`;
  try {
    const found = (await loadTriggerLedgerView(cwd)).entries.find((item) => item.entry.name === name);
    const act = found?.entry.action;
    const dispatch = act === undefined ? undefined : act.kind === "flow-next" || act.kind === "agent-task" ? act.dispatch : undefined;
    return dispatch === undefined ? base : `${base} It dispatches ${dispatch.provider}/${dispatch.model} with a $${dispatch.ceilingUsd} ceiling.`;
  } catch {
    return base;
  }
}

/**
 * Asks (when the match has a question), runs, and prints. `confirm` is the shell's own yes/no
 * surface; anything but a true answer leaves the action unrun. Never throws: a failure is printed.
 */
export async function runSharedSubcommand(
  match: SharedSubcommand,
  surface: { readonly confirm: (question: string) => Promise<boolean>; readonly print: (text: string) => void },
): Promise<ActionResult | undefined> {
  try {
    if (match.confirm !== undefined) {
      const question = await match.confirm();
      if (!(await surface.confirm(question))) {
        surface.print(`${match.command} ${match.verb}: cancelled, nothing changed.\n`);
        return undefined;
      }
    }
    const result = await match.run();
    surface.print(result.text);
    return result;
  } catch (error) {
    surface.print(`${match.command} ${match.verb}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

/**
 * One call for a shell's dispatcher: the pending work when `line` is a shared form (the shell tracks
 * it however it tracks its own async commands), undefined when it is not and the line goes on to the
 * modal or handler it had before.
 */
export function routeSharedSubcommandLine(
  line: string,
  context: SharedSubcommandContext,
  surface: Parameters<typeof runSharedSubcommand>[1],
): Promise<unknown> | undefined {
  const match = matchSharedSubcommand(line, context);
  return match === undefined ? undefined : runSharedSubcommand(match, surface);
}
