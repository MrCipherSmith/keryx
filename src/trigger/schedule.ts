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

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { isCompiledBinaryEntry } from "../lib/self-invocation";
import { loadTriggersConfig, type TriggerEntry } from "./config";
import { cronToOnCalendar } from "./cron";

export interface KeryxInvocation {
  /** The interpreter actually running this process (`node` or `bun`), absolute — or, for a compiled binary, keryx itself. */
  readonly execPath: string;
  /** The entry script actually running this process, absolute. Absent for a compiled binary (see `invocationArgv`). */
  readonly scriptPath?: string;
}

/**
 * How THIS process was launched — the one thing a generated line can assert
 * without guessing. A compiled binary's entry lives in bun's embedded
 * filesystem and is not an argument to pass (`isCompiledBinaryEntry`).
 */
export function resolveKeryxInvocation(
  entry: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): KeryxInvocation {
  if (entry === undefined || entry.length === 0 || isCompiledBinaryEntry(entry)) return { execPath };
  return { execPath, scriptPath: path.resolve(entry) };
}

/** The argv prefix that runs keryx the way this process runs: `[interpreter, script]` or `[binary]`. */
export function invocationArgv(invocation: KeryxInvocation): string[] {
  return invocation.scriptPath === undefined ? [invocation.execPath] : [invocation.execPath, invocation.scriptPath];
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
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// REVIEW FIX (finding 2, T15): the printed schedule was not escaped the way
// `cronCommand` is.
//
//   1. systemd. `ExecStartPre=` and `ExecStart=` used to interpolate
//      `projectRoot`/`logDir`/`invocation.execPath`/`invocation.scriptPath`/
//      the trigger name RAW. Those two directives (plus `Environment=`) are
//      "command line" / list-typed values: systemd word-splits them on
//      unquoted whitespace into argv — exactly like a shell command line —
//      so any one of those containing a space (a project checked out under a
//      path with a space is common) produced the wrong argv.
//      `systemdQuote` fixes that (per systemd.syntax(7)'s unified quoting:
//      wrap in double quotes when the value contains whitespace or a
//      quote/backslash, escaping embedded `"`/`\`) — applied, via
//      `systemdValue`, ONLY to `ExecStartPre=`, `ExecStart=` and the
//      `Environment=PATH=…` line, the directives systemd.syntax(7)'s
//      quote-removal actually governs.
//
//      REVIEW FIX (finding, T16): that quoting was over-applied to
//      `WorkingDirectory=`, `StandardOutput=` and `StandardError=` too.
//      Those three take the rest of the line VERBATIM — systemd does not
//      run syntax(7)'s quote-removal on them (they are single-value, not
//      word-split/list-typed, unlike `Exec*=`/`Environment=`). A literal
//      `"` there is not stripped as quoting; it becomes part of the value.
//      For `WorkingDirectory="/srv/my project"` systemd reads the leading
//      `"` as part of the path, decides it is not absolute, and refuses the
//      whole unit. For `StandardOutput="append:/srv/my project/x.log"` the
//      `append:` prefix parse fails on the leading `"` and systemd silently
//      falls back to the journal — so the printed promise that output is
//      appended to the log file stops being true, without any error at
//      load time. So these three now get ONLY the `%` escaping below, never
//      `systemdQuote` — see `systemd-analyze verify` coverage in
//      `schedule.test.ts`, run against a project path containing a space,
//      which turns this class of regression into a structural CI failure
//      instead of a string-matching assertion on the intended (buggy)
//      output.
//
//      Separately from quoting, an unescaped `%` anywhere in a systemd unit
//      value is read as the start of a specifier (`%h`, `%n`, …), so a
//      literal `%` must be doubled (`%%`) or it silently expands to
//      something else, or systemd refuses the unit outright for an unknown
//      specifier. `systemdEscapePercent` fixes that, and — unlike quoting —
//      IS applied to every interpolated value below, quoted or not:
//      `Description=`, `WorkingDirectory=`, `ExecStartPre=`, `ExecStart=`,
//      `StandardOutput=`, `StandardError=` and the `Environment=PATH=…`
//      line, because specifier expansion runs regardless of a directive's
//      quoting rules.
//   2. cron. Independently of shell quoting, cron itself treats an unescaped
//      `%` in a crontab line as a literal newline — it splits the line there
//      and feeds everything after it to the command as stdin — before
//      `/bin/sh` ever sees the line. `cronEscapePercent` escapes `%` to
//      `\%` (cron unescapes it back to a literal `%` before invoking the
//      shell) but is applied ONLY to `cronLine` (what an operator pastes into
//      `crontab -e`), never to the standalone `cronCommand` field: that field
//      is also used to run the SAME command directly via `/bin/sh -c`,
//      bypassing crontab's own line-preprocessing entirely (see
//      `../commands/trigger-schedule.e2e.test.ts`, which extracts
//      `cronCommand` and spawns it straight through `/bin/sh -c`) — escaping
//      `%` there would hand the shell a literal backslash it was never meant
//      to see.

/**
 * Quote one systemd unit-file value per systemd.syntax(7)'s unified quoting
 * rules (which apply to every configuration value, not only `Exec*=`
 * command lines): wrap in double quotes, escaping embedded `"`/`\`, when the
 * value contains whitespace or either of those characters. Values with
 * neither are returned unchanged, so an already-clean project path renders
 * identically to before this fix.
 */
function systemdQuote(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Double a literal `%` for a systemd unit-file value — an unescaped `%` starts a specifier. */
function systemdEscapePercent(value: string): string {
  return value.replace(/%/g, "%%");
}

/** `systemdEscapePercent` then `systemdQuote`, in the order every interpolated systemd value below needs. */
export function systemdValue(value: string): string {
  return systemdQuote(systemdEscapePercent(value));
}

/**
 * Escape `%` for a literal crontab line — see the file-header note above for
 * why this is applied to `cronLine` only, never to the standalone
 * `cronCommand` field.
 */
function cronEscapePercent(value: string): string {
  return value.replace(/%/g, "\\%");
}

/**
 * Flow 295 (AC8): a short, stable hash of the project's real path. It makes unit, plist and
 * crontab names unique per project, so two projects that both have a schedule named
 * `check-github` never share a unit in `~/.config/systemd/user/`.
 */
export function projectScheduleHash(projectRoot: string): string {
  let real: string;
  try {
    real = realpathSync(projectRoot);
  } catch {
    real = path.resolve(projectRoot);
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 8);
}

/** `keryx-<projecthash>-<name>`: the base of every unit/plist/crontab-block name keryx installs. */
export function scheduleUnitBase(projectRoot: string, name: string): string {
  return `keryx-${projectScheduleHash(projectRoot)}-${name}`;
}

/** The header every file keryx installs carries; uninstall touches only files that carry it for this project. */
export function managedHeader(projectRoot: string, name: string): string {
  return `# keryx-managed ${projectScheduleHash(projectRoot)} ${name}`;
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
  /** Flow 295 (AC8): the translated `OnCalendar=` value, or why the cron cannot be translated. */
  readonly onCalendar: { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };
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
  /** Flow 295 (F4): run `trigger run --schedule <name>`, which resolves only the local schedule store. */
  readonly scheduleOnly?: boolean;
  /** Flow 295 (N4): extra environment pinned into the unit (e.g. `XDG_DATA_HOME`, so the timer finds the same signing key). */
  readonly environment?: Readonly<Record<string, string>>;
}): ScheduleLines {
  const { projectRoot, name, cron, invocation } = params;
  const runFlag = params.scheduleOnly === true ? "--schedule " : "";
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
  const extraEnv = Object.entries(params.environment ?? {});
  const cronEnv = extraEnv.map(([k, v]) => `${k}=${shQuote(v)} `).join("");
  const cronCommand =
    `cd ${shQuote(projectRoot)} && mkdir -p ${shQuote(logDir)} && ${cronEnv}PATH=${shQuote(assumedPath)} ` +
    `${invocationArgv(invocation).map(shQuote).join(" ")} trigger run ${runFlag}${shQuote(name)} ` +
    `>> ${shQuote(logPath)} 2>&1`;
  // `cronLine` (what actually goes into a crontab) gets cron's own `%`
  // escaping on top of `cronCommand`'s shell quoting — see the file-header
  // note. `cronCommand` itself stays as-is: it is also handed straight to
  // `/bin/sh -c` (the AC6 e2e test, and the "cron-command-only" line printed
  // below), which never runs cron's line-preprocessing at all.
  const cronLine = `${cron} ${cronEscapePercent(cronCommand)}`;

  const unitBase = scheduleUnitBase(projectRoot, name);
  const serviceUnitName = `${unitBase}.service`;
  const timerUnitName = `${unitBase}.timer`;
  const header = managedHeader(projectRoot, name);
  const onCalendar = cronToOnCalendar(cron);
  // Description= is free text (not word-split, not argv), so it only needs
  // `%` doubled — the literal decorative quotes around the name below stay
  // exactly as authored.
  const descriptionName = systemdEscapePercent(name);
  const descriptionProjectRoot = systemdEscapePercent(projectRoot);
  const systemdService = `${header}
# ${serviceUnitName} — a --user unit: ~/.config/systemd/user/ (keryx schedule installs it there for you)
[Unit]
Description=keryx trigger "${descriptionName}" (${descriptionProjectRoot})

[Service]
Type=oneshot
WorkingDirectory=${systemdEscapePercent(projectRoot)}
Environment=${systemdQuote(systemdEscapePercent(`PATH=${assumedPath}`))}
${extraEnv.map(([k, v]) => `Environment=${systemdQuote(systemdEscapePercent(`${k}=${v}`))}\n`).join("")}# Same reason as the cron line's own \`mkdir -p\`: StandardOutput=append: does
# not create a missing PARENT directory, only a missing file. The leading "-"
# means systemd ignores this step's own exit status.
ExecStartPre=-/bin/mkdir -p ${systemdValue(logDir)}
ExecStart=${invocationArgv(invocation).map(systemdValue).join(" ")} trigger run ${runFlag}${systemdValue(name)}
StandardOutput=append:${systemdEscapePercent(logPath)}
StandardError=append:${systemdEscapePercent(logPath)}
`;
  // Flow 295 (AC8): a real OnCalendar= translated from the cron. Flow 286 printed
  // only a commented placeholder here, so that timer never fired. An expression
  // with no systemd equivalent keeps the comment and says why, and it is never installed.
  const calendarLines = onCalendar.ok
    ? `# cron "${cron}", translated; check it with: systemd-analyze calendar '${onCalendar.value}'\nOnCalendar=${onCalendar.value}`
    : `# cron "${cron}" has no systemd equivalent: ${onCalendar.reason}\n# OnCalendar=`;
  const systemdTimer = `${header}
# ${timerUnitName} — install alongside ${serviceUnitName}
[Unit]
Description=Schedule for keryx trigger "${descriptionName}"

[Timer]
${calendarLines}
Persistent=true

[Install]
WantedBy=timers.target
`;

  return { assumedPath, cronCommand, cronLine, systemdService, systemdTimer, serviceUnitName, timerUnitName, logPath, onCalendar };
}
