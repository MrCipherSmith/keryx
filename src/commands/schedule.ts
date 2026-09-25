// Flow 295 (AC9): `keryx schedule …` — the operator's CLI over scheduled agent
// tasks. Everything here goes through `../trigger/schedules.ts`, the same
// service `/schedule`, `/schedules` and the `schedule_create` tool use, and every
// run lands in the one trigger ledger (`runs.jsonl`), so `keryx trigger status`
// and `keryx governance report` see scheduled runs with no second bookkeeping.
//
//   add      draft → print the confirmation card → confirm (TTY y/N, or --yes) → store + install
//   list     name, cadence, enabled/paused, installed, next run, last outcome + cost, last report
//   show     one schedule: the card-like detail, its last runs, the latest report
//   pause    disable the timer and mark the entry disabled
//   resume   re-enable both
//   run      one pass now (`keryx trigger run <name>`)
//   remove   uninstall the timer (only keryx-written files) and delete the entry, after a confirmation

import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runTriggerOnce } from "./trigger";
import { providerHasUsableCredential, providerReportsUsage as dispatchProviderReportsUsage } from "./trigger-dispatch";
import { readTriggerRuns } from "../trigger/record";
import type { ScheduleBackend, ScheduleHost } from "../trigger/install";
import {
  confirmSchedule,
  draftSchedule,
  listSchedules,
  pauseStoredSchedule,
  removeSchedule,
  resumeStoredSchedule,
  type DraftContext,
  type ScheduleRequest,
  type ScheduleSummary,
} from "../trigger/schedules";
import { GRANTED_TOOL_CATALOGUE } from "../trigger/granted-tools";

/** Flow 302: the real checks, reused so a draft agrees with what `keryx trigger run` would do. Production's default; tests inject a fake to stay hermetic. */
async function defaultCheckCredential(provider: string, model: string): ReturnType<NonNullable<DraftContext["checkCredential"]>> {
  return providerHasUsableCredential({ provider, model });
}

/** Seams for tests. Production passes none. */
export interface ScheduleCommandDeps {
  readonly host?: ScheduleHost;
  readonly now?: () => Date;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly resolveProgram?: DraftContext["resolveProgram"];
  readonly accountOf?: DraftContext["accountOf"];
  /** Default: `providerReportsUsage` (`./trigger-dispatch`) — the same the dispatcher checks at run time. */
  readonly providerReportsUsage?: DraftContext["providerReportsUsage"];
  /** Default: `providerHasUsableCredential` (`./trigger-dispatch`) — the same construction the dispatcher uses at run time. */
  readonly checkCredential?: DraftContext["checkCredential"];
  readonly cwd?: string;
  /** The environment to read the agent-shell marker from (default `process.env`). */
  readonly env?: Record<string, string | undefined>;
  /** Both stdin and stdout are terminals. Default: `process.stdin.isTTY && process.stdout.isTTY` (flow 295 N1). */
  readonly isTerminal?: boolean;
}

/**
 * Flow 295 (N1): subcommands that ADD to what runs unattended (create, re-enable, run
 * now) need the operator at a real terminal, on both stdin and stdout, the way flow 299's
 * `flow confirm` does. An agent's `shell_exec`, an MCP or ACP client and a pipe have no
 * terminal, so `--yes` from any of them is refused whatever the command text looked
 * like to the approval floor. `remove` and `pause` only reduce what runs, so they need
 * no terminal (the approval floor still asks about them).
 */
const NEEDS_TERMINAL = new Set(["add", "resume", "run"]);

/** Subcommands that create, change or run a schedule: never from inside an agent's shell (flow 295 F2). */
const OPERATOR_ONLY = new Set(["add", "remove", "pause", "resume", "run"]);

async function ttyConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const NO_TERMINAL_REASON =
  "needs an interactive terminal on both stdin and stdout, and refuses to run from a pipe, an agent's shell, " +
  "an MCP or ACP client, or an unattended run (--yes included). Run it yourself in a terminal, or confirm the card " +
  "that /schedule or the schedule_create tool shows in `keryx shell`.";

function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, i) => {
    if (arg === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
    else if (arg.startsWith(`${flag}=`)) out.push(arg.slice(flag.length + 1));
  });
  return out;
}

function flag(args: readonly string[], name: string): string | undefined {
  return flagValues(args, name).at(-1);
}

function hostFrom(args: readonly string[], deps: ScheduleCommandDeps): ScheduleHost {
  const backend = flag(args, "--backend");
  if (backend !== undefined && !["systemd", "launchd", "cron"].includes(backend)) {
    throw new Error(`--backend must be systemd, launchd or cron, not "${backend}"`);
  }
  return { ...deps.host, ...(backend !== undefined ? { backend: backend as ScheduleBackend } : {}) };
}

const USAGE = `keryx schedule — scheduled agent tasks that run in the background

Usage:
  keryx schedule add --name <name> --every "<cadence>" --prompt "<task>" \\
      --provider <p> --model <m> --rates <in>,<out> --ceiling <usd> \\
      [--max-seconds 600] [--mode ask|trust] [--network off|full|allowlist] \\
      [--domain example.com]... [--port 443]... [--tool <id>]... [--repo owner/name]... [--backend systemd|launchd|cron] [--yes]
  keryx schedule list
  keryx schedule show <name>
  keryx schedule pause <name>
  keryx schedule resume <name>
  keryx schedule run <name>
  keryx schedule remove <name> [--yes]

"add" prints a confirmation card: the cadence and next runs, the prompt, the runner and its
budget, the network mode, every granted tool with the binary and account it acts as, and
exactly what will be installed. Nothing is written until you confirm: y at the prompt, or
--yes. Without a TTY and without --yes it refuses.

Cadence: a 5-field cron expression, "every N hours", "every N minutes", "hourly",
"daily at HH:MM", "weekdays at HH:MM", "every monday at HH:MM".
Granted tools (run by keryx OUTSIDE the sandbox with your credentials; the model sees
only redacted output): ${GRANTED_TOOL_CATALOGUE.map((s) => s.id).join(", ")}.
Network: "off" (default), "full" (the host's whole network) or "allowlist" (the agent's
shell reaches only --domain names, through a loopback proxy keryx runs; Linux only).
"allowlist" governs ONLY the agent's own shell_exec commands inside the sandbox — the
model call and every granted tool already run outside the sandbox on your network.
The allowlist restricts host AND port: 443 (CONNECT/HTTPS) and 80 (plain HTTP) by
default, or exactly the --port list when you give one (applies to every --domain).

Keryx runs no daemon. The OS scheduler (systemd --user, launchd, or cron) calls
\`keryx trigger run <name>\`. The machine must be on. systemd and launchd catch up one
missed run after a boot or wake; cron does not. Without linger, a systemd --user timer
does not run while you are logged out, and keryx never enables linger for you.
`;

export async function scheduleCommand(args: string[], deps: ScheduleCommandDeps = {}): Promise<void> {
  const sub = args[0];
  const cwd = deps.cwd ?? process.cwd();
  // Flow 295 (F2): `shell_exec` children carry KERYX_TOOL_CALL=1. A schedule is
  // created or changed only by the operator, at a terminal or through the shell's
  // card. `--yes` from an agent's shell would skip that card, so it is refused.
  if (sub !== undefined && OPERATOR_ONLY.has(sub) && (deps.env ?? process.env)["KERYX_TOOL_CALL"] === "1") {
    console.error(
      `keryx schedule ${sub}: refused inside an agent's shell (KERYX_TOOL_CALL=1). A schedule is created or changed only by ` +
        "the operator: run this in your own terminal, or confirm the card that /schedule or the schedule_create tool shows.",
    );
    process.exitCode = 1;
    return;
  }
  if (sub !== undefined && NEEDS_TERMINAL.has(sub) && !args.includes("--help")) {
    const terminal = deps.isTerminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!terminal) {
      console.error(`keryx schedule ${sub}: ${NO_TERMINAL_REASON}`);
      process.exitCode = 1;
      return;
    }
  }
  try {
    switch (sub) {
      case undefined:
      case "--help":
      case "-h":
        console.log(USAGE);
        return;
      case "add":
        return await addSubcommand(cwd, args.slice(1), deps);
      case "list":
        return await listSubcommand(cwd, hostFrom(args, deps), deps);
      case "show":
        return await showSubcommand(cwd, args[1], hostFrom(args, deps), deps);
      case "pause":
        return await simpleAction(cwd, args[1], "pause", async (name) => pauseStoredSchedule(cwd, name, hostFrom(args, deps)));
      case "resume":
        return await simpleAction(cwd, args[1], "resume", async (name) => resumeStoredSchedule(cwd, name, hostFrom(args, deps)));
      case "run": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: keryx schedule run <name>");
        await runTriggerOnce(cwd, name, {}, { scheduleOnly: true });
        return;
      }
      case "remove":
        return await removeSubcommand(cwd, args.slice(1), deps);
      default:
        console.error(`Unknown schedule command: ${sub}. See \`keryx schedule --help\`.`);
        process.exitCode = 1;
        return;
    }
  } catch (error) {
    console.error(`keryx schedule ${sub}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function numberFlag(args: readonly string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, not "${raw}"`);
  return value;
}

/** Parse `keryx schedule add` flags into a request. Missing required flags are reported together. */
export function requestFromArgs(args: readonly string[]): ScheduleRequest {
  const missing = ["--name", "--prompt", "--provider", "--model", "--rates", "--ceiling"].filter((f) => flag(args, f) === undefined);
  const cadence = flag(args, "--every") ?? flag(args, "--cron");
  if (cadence === undefined) missing.push("--every (or --cron)");
  if (missing.length > 0) throw new Error(`missing ${missing.join(", ")} — see \`keryx schedule --help\``);
  const [inRate, outRate] = flag(args, "--rates")!.split(",").map(Number);
  if (!(Number.isFinite(inRate) && Number.isFinite(outRate))) throw new Error('--rates must be "<in>,<out>" USD per million tokens');
  const mode = flag(args, "--mode");
  if (mode !== undefined && mode !== "ask" && mode !== "trust") throw new Error('--mode must be "ask" or "trust" ("auto" is never allowed unattended)');
  const network = flag(args, "--network");
  if (network !== undefined && network !== "off" && network !== "full" && network !== "allowlist") {
    throw new Error('--network must be "off", "full" or "allowlist"');
  }
  const tools = flagValues(args, "--tool").flatMap((t) => t.split(",")).filter((t) => t.length > 0);
  const repos = flagValues(args, "--repo").flatMap((t) => t.split(",")).filter((t) => t.length > 0);
  const domains = flagValues(args, "--domain").flatMap((t) => t.split(",")).filter((t) => t.length > 0);
  const portStrings = flagValues(args, "--port").flatMap((t) => t.split(",")).filter((t) => t.length > 0);
  const ports = portStrings.map((p) => Number(p));
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error("--port must be an integer 1-65535 (repeatable, or comma-separated)");
  }
  const maxSeconds = numberFlag(args, "--max-seconds");
  return {
    name: flag(args, "--name")!,
    cadence: cadence!,
    prompt: flag(args, "--prompt")!,
    provider: flag(args, "--provider")!,
    model: flag(args, "--model")!,
    rates: { inputUsdPerMTok: inRate!, outputUsdPerMTok: outRate! },
    ceilingUsd: numberFlag(args, "--ceiling")!,
    ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    ...(mode !== undefined ? { permissionMode: mode } : {}),
    ...(network !== undefined ? { network } : {}),
    tools,
    repos,
    ...(domains.length > 0 ? { domains } : {}),
    ...(ports.length > 0 ? { ports } : {}),
  };
}

async function addSubcommand(cwd: string, args: string[], deps: ScheduleCommandDeps): Promise<void> {
  const request = requestFromArgs(args);
  const host = hostFrom(args, deps);
  const drafted = await draftSchedule(request, {
    projectRoot: cwd,
    host,
    providerReportsUsage: deps.providerReportsUsage ?? dispatchProviderReportsUsage,
    checkCredential: deps.checkCredential ?? defaultCheckCredential,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.resolveProgram !== undefined ? { resolveProgram: deps.resolveProgram } : {}),
    ...(deps.accountOf !== undefined ? { accountOf: deps.accountOf } : {}),
  });
  if (!drafted.ok) {
    console.error("keryx schedule add: refused —");
    for (const problem of drafted.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  for (const line of drafted.draft.card) console.log(line);
  const yes = args.includes("--yes");
  const confirmed = yes || (await (deps.confirm ?? ttyConfirm)("Create this schedule and install its timer?"));
  if (!confirmed) {
    console.log("keryx schedule add: not confirmed — nothing was written or installed.");
    if (!yes && !process.stdin.isTTY && deps.confirm === undefined) process.exitCode = 1;
    return;
  }
  const created = await confirmSchedule(cwd, drafted.draft, host);
  console.log(`keryx schedule add: "${created.name}" stored and installed (${created.backend}: ${created.unit}).`);
}

function formatSummary(s: ScheduleSummary): string {
  const last =
    s.last === undefined
      ? "never ran"
      : `${s.last.outcome}${s.last.refusal !== undefined ? ` (${s.last.refusal})` : ""} at ${s.last.at}${s.last.usd !== undefined ? `, $${s.last.usd.toFixed(4)}` : ""}`;
  return (
    `  - ${s.name}  [${s.enabled ? "enabled" : "paused"}]  cron "${s.cron}"  ${s.installed ? "installed" : "NOT installed"}` +
    `  next: ${s.nextRun?.toISOString() ?? "—"}  last: ${last}  report: ${s.reportPath ?? "none yet"}`
  );
}

async function listSubcommand(cwd: string, host: ScheduleHost, deps: ScheduleCommandDeps): Promise<void> {
  const rows = await listSchedules(cwd, { host, ...(deps.now !== undefined ? { now: deps.now } : {}) });
  if (rows.length === 0) {
    console.log("keryx schedule list: no schedules. Create one with `keryx schedule add` or /schedule in `keryx shell`.");
    return;
  }
  console.log(`keryx schedule list (${rows.length}):`);
  for (const row of rows) console.log(formatSummary(row));
}

async function showSubcommand(cwd: string, name: string | undefined, host: ScheduleHost, deps: ScheduleCommandDeps): Promise<void> {
  if (name === undefined) throw new Error("usage: keryx schedule show <name>");
  const row = (await listSchedules(cwd, { host, ...(deps.now !== undefined ? { now: deps.now } : {}) })).find((r) => r.name === name);
  if (row === undefined) throw new Error(`no schedule named "${name}"`);
  const a = row.entry.action;
  console.log(formatSummary(row));
  console.log(`    prompt: ${a.prompt}`);
  console.log(`    runner: ${a.dispatch.provider}/${a.dispatch.model}, mode ${a.dispatch.permissionMode}, ceiling $${a.dispatch.ceilingUsd}, max ${a.dispatch.maxSeconds}s`);
  console.log(
    `    network: ${a.grants.network}${a.grants.network === "allowlist" ? ` [${a.grants.domains.join(", ")}] port ${a.grants.ports !== undefined && a.grants.ports.length > 0 ? a.grants.ports.join("/") : "443/80 default"}` : ""}; ` +
      `granted tools: ${a.grants.tools.join(", ") || "none"}; repos: ${a.grants.repos.join(", ") || "none"}`,
  );
  const read = await readTriggerRuns(cwd);
  const runs = read.state === "present" ? read.records.filter((r) => r.trigger === name && r.outcome !== "reserved").slice(-5) : [];
  for (const r of runs) console.log(`    run ${r.at}: ${r.outcome}${r.agentTask?.refusal ? ` (${r.agentTask.refusal})` : ""} — ${r.detail}`);
  if (row.reportPath !== undefined) {
    console.log(`\n--- ${row.reportPath} ---`);
    console.log(await readFile(path.join(cwd, row.reportPath), "utf8").catch(() => "(the report could not be read)"));
  }
}

async function simpleAction(cwd: string, name: string | undefined, verb: string, action: (name: string) => Promise<void>): Promise<void> {
  if (name === undefined) throw new Error(`usage: keryx schedule ${verb} <name>`);
  await action(name);
  console.log(`keryx schedule ${verb}: "${name}" ${verb === "pause" ? "paused (timer disabled, entry disabled)" : "resumed (timer enabled)"}.`);
  void cwd;
}

async function removeSubcommand(cwd: string, args: string[], deps: ScheduleCommandDeps): Promise<void> {
  const name = args[0];
  if (name === undefined) throw new Error("usage: keryx schedule remove <name> [--yes]");
  const yes = args.includes("--yes");
  const confirmed = yes || (await (deps.confirm ?? ttyConfirm)(`Remove schedule "${name}" and uninstall its timer?`));
  if (!confirmed) {
    console.log("keryx schedule remove: not confirmed — nothing was changed.");
    if (!yes && !process.stdin.isTTY && deps.confirm === undefined) process.exitCode = 1;
    return;
  }
  const result = await removeSchedule(cwd, name, hostFrom(args, deps));
  console.log(`keryx schedule remove: "${name}" removed${result.removed.length > 0 ? ` (${result.removed.join(", ")})` : ""}.`);
  if (result.skipped.length > 0) {
    console.log(`  left untouched (not written by keryx for this project): ${result.skipped.join(", ")}`);
  }
}
