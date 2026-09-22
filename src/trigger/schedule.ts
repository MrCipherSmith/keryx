// Flow 286 T10, AC6: "For a schedule, keryx prints the cron line or the
// systemd timer unit to install and does not run a daemon of its own; the
// printed line is exercised by a test that runs it as the scheduler would."
//
// "Correct by construction" means the printed command must not depend on
// anything a scheduler's own environment does not actually give it:
//
//   - NOT on `keryx` being resolvable on PATH. `command -v keryx` is fine
//     inside a git hook (`../lib/managed-hook.ts`'s hook bodies), because git
//     hooks inherit the invoking shell's PATH, which for an interactive user
//     has usually already sourced nvm/asdf/etc. cron and systemd do not: cron
//     runs each line via `/bin/sh -c '<line>'` with a MINIMAL PATH (commonly
//     `/usr/bin:/bin`, sometimes unset entirely) and no login-shell startup
//     files, and a systemd unit's `ExecStart=` is looked up with no PATH at
//     all unless the unit sets one. This project's own `keryx` is frequently
//     NOT on that minimal PATH — installed via nvm/bun into a user-specific
//     directory (`~/.nvm/versions/node/.../bin/keryx`,
//     `~/.bun/install/global/bin/keryx`), not `/usr/bin`. So the printed
//     command never says bare `keryx`: it resolves and bakes in the ABSOLUTE
//     path to the interpreter actually running THIS process
//     (`process.execPath` — `node` or `bun`) and the absolute path to the
//     entry script actually running (`process.argv[1]`), and invokes that
//     pair directly. Whatever launched `keryx trigger schedule` is, by
//     definition, a working way to run keryx — baking in ITS OWN resolved
//     paths is the one thing this function can assert about the environment
//     without guessing.
//   - The action itself still shells out (`git`, inside `sync --apply` /
//     `gdgraph build`) and needs a PATH for that — this file sets an explicit
//     one rather than trusting the ambient PATH cron actually clears. See
//     `renderScheduleLines`'s `assumedPath`.
//
// What this assumes, stated rather than hidden (also printed in the output
// and repeated in the flow's context.md and the T13 docs task):
//
//   1. The interpreter and script paths resolved at the moment `keryx trigger
//      schedule` ran are STABLE — the same absolute paths keryx will still be
//      at when the scheduler later invokes them. An nvm install that gets
//      pruned, or a version-manager `use` that later points `node`/`bun`
//      elsewhere, breaks this the same way it breaks any other tool pinned
//      into a cron line by absolute path — regenerate and reinstall the line
//      after such a change.
//   2. `git` is reachable on `assumedPath`. Every action this project's
//      triggers can run today (`reconcile` -> `sync --apply`, `rebuild` ->
//      `gdgraph build`) shells out to `git`; `/usr/local/bin:/usr/bin:/bin`
//      covers every mainstream Linux/macOS package manager's install
//      location. A `git` installed somewhere else needs that directory added
//      to the PATH this module emits.
//   3. The working directory is set explicitly (`cd`/`WorkingDirectory=`) to
//      the project root resolved at generation time — neither cron nor
//      systemd otherwise runs a job from inside the project.

import path from "node:path";
import { loadTriggersConfig, type TriggerEntry } from "./config";

export interface KeryxInvocation {
  /** The interpreter actually running this process (`node` or `bun`), absolute. */
  readonly execPath: string;
  /** The entry script actually running this process, absolute. */
  readonly scriptPath: string;
}

/** How THIS process was launched — the one thing a generated line can assert without guessing. */
export function resolveKeryxInvocation(): KeryxInvocation {
  const script = process.argv[1];
  return {
    execPath: process.execPath,
    scriptPath: script ? path.resolve(script) : process.execPath,
  };
}

export type ScheduleResolution =
  | { readonly kind: "config-absent" }
  | { readonly kind: "unknown-name"; readonly known: readonly string[] }
  | { readonly kind: "not-a-schedule"; readonly entry: TriggerEntry }
  | { readonly kind: "ready"; readonly entry: TriggerEntry & { fire: { kind: "schedule"; cron: string } } };

/** Resolve `name` to a schedule-fired entry for `keryx trigger schedule <name>`. Pure, never throws. */
export function resolveScheduleEntry(projectRoot: string, name: string): ScheduleResolution {
  const { triggers, fileProblem } = loadTriggersConfig(projectRoot);
  if (fileProblem !== undefined) return { kind: "config-absent" };
  const entry = triggers.find((candidate) => candidate.name === name);
  if (entry === undefined) return { kind: "unknown-name", known: triggers.map((t) => t.name) };
  if (entry.fire.kind !== "schedule") return { kind: "not-a-schedule", entry };
  return { kind: "ready", entry: entry as TriggerEntry & { fire: { kind: "schedule"; cron: string } } };
}

/** Quote one shell word single-quoted, safe for any byte a path or name can contain. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ScheduleLines {
  /** The PATH baked into every generated command — see the file header. */
  readonly assumedPath: string;
  /** The command portion alone (no cron fields) — a scheduler runs exactly this via `/bin/sh -c`. Exposed separately so a test can run precisely what cron would, without re-parsing the full crontab line. */
  readonly cronCommand: string;
  /** `<cron> <cronCommand>` — the full crontab line ready to paste (or `crontab -e` + append). */
  readonly cronLine: string;
  readonly systemdService: string;
  readonly systemdTimer: string;
  readonly serviceUnitName: string;
  readonly timerUnitName: string;
  readonly logPath: string;
}

/**
 * Render the cron line and the systemd unit pair for one schedule-fired
 * entry. Pure text generation — this function runs no command and starts no
 * daemon; that is the whole point of AC6.
 */
export function renderScheduleLines(params: {
  readonly projectRoot: string;
  readonly name: string;
  readonly cron: string;
  readonly invocation: KeryxInvocation;
}): ScheduleLines {
  const { projectRoot, name, cron, invocation } = params;
  const interpreterDir = path.dirname(invocation.execPath);
  // Interpreter's own directory first (so THIS keryx resolves even if
  // something it shells out to looks up "node"/"bun" by bare name), then the
  // mainstream package-manager install locations `git` lives in.
  const assumedPath = [interpreterDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const logDir = path.join(projectRoot, ".metaproject", "data", "trigger");
  const logPath = path.join(logDir, `${name}.schedule.log`);

  // `>> logPath` fails outright (the shell sets up redirection before it ever
  // execs anything) when `logDir` does not exist yet — the ordinary state of
  // a FRESH project that has never had `keryx trigger run` create
  // `.metaproject/data/trigger/` for its own lock file. A `mkdir -p` ahead of
  // the redirect is what makes the first-ever scheduled fire, not just every
  // one after it, actually perform the pass — measured by this task's own
  // AC6 test failing exactly this way before this line was added.
  const cronCommand =
    `cd ${shQuote(projectRoot)} && mkdir -p ${shQuote(logDir)} && PATH=${shQuote(assumedPath)} ` +
    `${shQuote(invocation.execPath)} ${shQuote(invocation.scriptPath)} trigger run ${shQuote(name)} ` +
    `>> ${shQuote(logPath)} 2>&1`;
  const cronLine = `${cron} ${cronCommand}`;

  const serviceUnitName = `keryx-trigger-${name}.service`;
  const timerUnitName = `keryx-trigger-${name}.timer`;
  const systemdService = `# ${serviceUnitName} — install under /etc/systemd/system/ (or ~/.config/systemd/user/ for --user)
[Unit]
Description=keryx trigger "${name}" (${projectRoot})

[Service]
Type=oneshot
WorkingDirectory=${projectRoot}
Environment=PATH=${assumedPath}
# Same reason as the cron line's own \`mkdir -p\`: StandardOutput=append: does
# not create a missing PARENT directory, only a missing file. The leading "-"
# means systemd ignores this step's own exit status.
ExecStartPre=-/bin/mkdir -p ${logDir}
ExecStart=${invocation.execPath} ${invocation.scriptPath} trigger run ${name}
StandardOutput=append:${logPath}
StandardError=append:${logPath}
`;
  const systemdTimer = `# ${timerUnitName} — install alongside ${serviceUnitName}
[Unit]
Description=Schedule for keryx trigger "${name}"

[Timer]
# Translate the cron expression "${cron}" into OnCalendar= syntax, e.g. with
# \`systemd-analyze calendar '<expression>'\` to verify it, then uncomment:
# OnCalendar=
Persistent=true

[Install]
WantedBy=timers.target
`;

  return { assumedPath, cronCommand, cronLine, systemdService, systemdTimer, serviceUnitName, timerUnitName, logPath };
}
