// Flow 295 (AC8, AC9): install, pause, resume and uninstall the OS timer for a
// confirmed schedule.
//
// Keryx still runs no daemon. It hands the schedule to the scheduler the
// operator's OS already has, and that scheduler calls `keryx trigger run <name>`
// from the project root:
//
//   systemd --user (Linux, primary). Two units in `~/.config/systemd/user/`,
//            named `keryx-<projecthash>-<name>.{service,timer}` and carrying a real
//            `OnCalendar=` and `Persistent=true` (one catch-up run after the machine
//            was off or asleep). Enabled with `systemctl --user enable --now`.
//   launchd  (macOS). A LaunchAgent plist in `~/Library/LaunchAgents/`, loaded
//            with `launchctl bootstrap gui/<uid>`.
//   cron     (fallback). A marked block in the user's crontab. There is no
//            catch-up for runs missed while the machine was off.
//
// What this module NEVER does:
//   - install anything the operator has not confirmed. Only the confirmed paths
//     (`../commands/schedule.ts`, the TUI card, `schedule_create`) call it.
//   - run `loginctl enable-linger`. It only READS the linger state, so the card
//     can say whether a schedule runs while the operator is logged out.
//   - touch a file it did not write. Every file it writes starts with
//     `# keryx-managed <projecthash> <name>` (an XML comment in a plist), and
//     uninstall deletes a file only when that header is present for this project.
//
// Idempotent: a unit file is rewritten only when its content differs, and a
// crontab block is replaced, never appended twice.
//
// Every external command goes through `ScheduleHost.run`, so tests use a fake
// `systemctl`/`launchctl`/`crontab` and a temporary unit directory. No test
// installs a real timer.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { isNotFound } from "../lib/fs";
import type { ConfirmedRunner } from "./config";
import { cronToLaunchdIntervals, cronToOnCalendar } from "./cron";
import {
  invocationArgv,
  managedHeader,
  projectScheduleHash,
  renderScheduleLines,
  resolveKeryxInvocation,
  scheduleUnitBase,
  shQuote,
  systemdValue,
  type KeryxInvocation,
} from "./schedule";

export type ScheduleBackend = "systemd" | "launchd" | "cron";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything that touches the host, injectable. */
export interface ScheduleHost {
  readonly platform?: string;
  /** Force a backend (tests; `--backend`). Default: detected. */
  readonly backend?: ScheduleBackend;
  readonly unitDir?: string;
  readonly launchAgentsDir?: string;
  readonly uid?: number;
  readonly user?: string;
  readonly invocation?: KeryxInvocation;
  readonly run?: (command: string, args: readonly string[], input?: string) => Promise<CommandResult>;
}

function defaultRun(command: string, args: readonly string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(command, [...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 127;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (error as Error | null)?.message ?? "") });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

function runner(host: ScheduleHost): NonNullable<ScheduleHost["run"]> {
  return host.run ?? defaultRun;
}

/**
 * L4: the probe's answer, cached per host for this process (one key for the default host).
 * Every list reload (the sidebar, `/schedules`) plans each schedule's install, and without
 * the cache each reload spawned `systemctl --user is-system-running` once per schedule.
 */
let backendCache = new WeakMap<object, Promise<ScheduleBackend>>();
const DEFAULT_HOST_KEY = {};

/** Test seam: forget every cached backend. */
export function resetDetectedBackendCache(): void {
  backendCache = new WeakMap();
}

async function probeBackend(host: ScheduleHost): Promise<ScheduleBackend> {
  const platform = host.platform ?? process.platform;
  if (platform === "darwin") return "launchd";
  if (platform === "linux") {
    const probe = await runner(host)("systemctl", ["--user", "is-system-running"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
    const state = probe.stdout.trim();
    if (["running", "degraded", "starting", "initializing"].includes(state)) return "systemd";
  }
  return "cron";
}

/** Which scheduler this host uses. Probed once per host object (once per process for the default host). */
export async function detectBackend(host: ScheduleHost = {}): Promise<ScheduleBackend> {
  if (host.backend !== undefined) return host.backend;
  const key = host.run === undefined && host.platform === undefined ? DEFAULT_HOST_KEY : host;
  let cached = backendCache.get(key);
  if (cached === undefined) {
    cached = probeBackend(host);
    backendCache.set(key, cached);
  }
  return cached;
}

/**
 * Flow 295 (M1): the keryx invocation and pinned environment of THIS process, as the draft
 * records it. It is used only when a schedule is drafted; after confirmation every install,
 * resume and reinstall uses the signed copy in the entry.
 */
export function currentRunner(host: ScheduleHost = {}): ConfirmedRunner {
  const invocation = host.invocation ?? resolveKeryxInvocation();
  const xdg = process.env["XDG_DATA_HOME"];
  return { argv: invocationArgv(invocation), env: xdg !== undefined && xdg.length > 0 ? { XDG_DATA_HOME: xdg } : {} };
}

function runnerInvocation(confirmed: ConfirmedRunner): KeryxInvocation {
  const [execPath, scriptPath] = confirmed.argv;
  return scriptPath === undefined ? { execPath: execPath! } : { execPath: execPath!, scriptPath };
}

export function systemdUserUnitDir(host: ScheduleHost = {}): string {
  return host.unitDir ?? path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(homedir(), ".config"), "systemd", "user");
}

function launchAgentsDir(host: ScheduleHost): string {
  return host.launchAgentsDir ?? path.join(homedir(), "Library", "LaunchAgents");
}

function uidOf(host: ScheduleHost): number {
  return host.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
}

/** Linger decides whether a systemd --user timer runs while the operator is logged out. READ only, never changed. */
export async function lingerStatus(host: ScheduleHost = {}): Promise<"yes" | "no" | "unknown"> {
  const user = host.user ?? userInfo().username;
  const result = await runner(host)("loginctl", ["show-user", user, "-p", "Linger"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
  const match = /^Linger=(yes|no)$/m.exec(result.stdout);
  return match === null ? "unknown" : (match[1] as "yes" | "no");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One file the install writes. */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/** What installing a schedule means on this host: shown on the confirmation card, then carried out. */
export interface InstallPlan {
  readonly backend: ScheduleBackend;
  readonly files: readonly PlannedFile[];
  /** The crontab block (cron backend only). */
  readonly cronBlock?: string;
  /** What the scheduler will execute, exactly. */
  readonly execStart: string;
  /** Where it lands, for the card: unit/plist paths or "crontab". */
  readonly location: string;
  /** The scheduler identifier (timer unit / launchd label / crontab marker). */
  readonly unit: string;
  /** Set when this cadence cannot be installed on this backend; nothing is installed. */
  readonly problem?: string;
}

function cronMarkers(projectRoot: string, name: string): { begin: string; end: string } {
  const id = `keryx-managed ${projectScheduleHash(projectRoot)} ${name}`;
  return { begin: `# >>> ${id} >>>`, end: `# <<< ${id} <<<` };
}

/**
 * Build the install plan. Pure apart from reading `host` defaults. `confirmed` is the signed
 * runner stored with the entry (M1); without it (drafting) this process's own runner is used.
 */
export async function planInstall(
  projectRoot: string,
  name: string,
  cron: string,
  host: ScheduleHost = {},
  confirmed: ConfirmedRunner = currentRunner(host),
): Promise<InstallPlan> {
  const backend = await detectBackend(host);
  const invocation = runnerInvocation(confirmed);
  // N4: pin where keryx's config dir (and so the signing key) is, so the systemd --user
  // manager, launchd or cron (none of which has the operator's shell environment) finds
  // the same key the schedule was signed with. M1: the CONFIRMED value, never this process's.
  const pinned: Record<string, string> = { ...confirmed.env };
  // Every value below lands in a unit file, a plist or a crontab line. A newline or
  // another control character in one of them would start a new directive or a new
  // crontab line, so such a path is refused rather than escaped.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point (flow 295 F7/installer)
  const unsafe = [projectRoot, ...invocationArgv(invocation), name, ...Object.values(pinned)].find((v) => /[\u0000-\u001f\u007f]/.test(v));
  if (unsafe !== undefined) {
    return {
      backend,
      files: [],
      execStart: "",
      location: "",
      unit: "",
      problem: `a path or name contains a newline or control character (${JSON.stringify(unsafe)}); keryx will not write it into a scheduler file`,
    };
  }
  const lines = renderScheduleLines({ projectRoot, name, cron, invocation, scheduleOnly: true, environment: pinned });
  const base = scheduleUnitBase(projectRoot, name);
  // L4: the card shows the command quoted exactly the way the unit (or plist argv) carries it.
  const execStart =
    backend === "systemd"
      ? `${invocationArgv(invocation).map(systemdValue).join(" ")} trigger run --schedule ${systemdValue(name)}`
      : `${invocationArgv(invocation).map(shQuote).join(" ")} trigger run --schedule ${shQuote(name)}`;
  if (backend === "systemd") {
    const dir = systemdUserUnitDir(host);
    const calendar = cronToOnCalendar(cron);
    return {
      backend,
      files: [
        { path: path.join(dir, lines.serviceUnitName), content: lines.systemdService },
        { path: path.join(dir, lines.timerUnitName), content: lines.systemdTimer },
      ],
      execStart,
      location: `${path.join(dir, lines.serviceUnitName)} + .timer`,
      unit: lines.timerUnitName,
      ...(calendar.ok ? {} : { problem: calendar.reason }),
    };
  }
  if (backend === "launchd") {
    const label = `ai.keryx.${projectScheduleHash(projectRoot)}.${name}`;
    const intervals = cronToLaunchdIntervals(cron);
    const plistPath = path.join(launchAgentsDir(host), `${label}.plist`);
    const dicts = intervals.ok
      ? intervals.value
          .map((d) => `    <dict>${Object.entries(d).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join("")}</dict>`)
          .join("\n")
      : "";
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${managedHeader(projectRoot, name).slice(2)} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${invocationArgv(invocation).map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
    <string>trigger</string>
    <string>run</string>
    <string>--schedule</string>
    <string>${xml(name)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(lines.assumedPath)}</string>${Object.entries(pinned).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>StartCalendarInterval</key>
  <array>
${dicts}
  </array>
  <key>StandardOutPath</key><string>${xml(lines.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(lines.logPath)}</string>
</dict>
</plist>
`;
    return {
      backend,
      files: [{ path: plistPath, content }],
      execStart,
      location: plistPath,
      unit: label,
      ...(intervals.ok ? {} : { problem: intervals.reason }),
    };
  }
  const { begin, end } = cronMarkers(projectRoot, name);
  return {
    backend,
    files: [],
    cronBlock: `${begin}\n${lines.cronLine}\n${end}\n`,
    execStart: lines.cronCommand,
    location: "crontab (user)",
    unit: base,
  };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Does `content` carry this project's managed header for `name`? */
function isManagedBy(content: string | undefined, projectRoot: string, name: string): boolean {
  if (content === undefined) return false;
  const header = managedHeader(projectRoot, name);
  return content.startsWith(`${header}\n`) || content.includes(`<!-- ${header.slice(2)} -->`);
}

async function currentCrontab(host: ScheduleHost): Promise<string> {
  const listed = await runner(host)("crontab", ["-l"]);
  if (listed.code !== 0) {
    if (/no crontab/i.test(listed.stderr)) return "";
    throw new Error(`crontab -l failed: ${listed.stderr.trim()}`);
  }
  return listed.stdout;
}

function withoutBlock(crontab: string, projectRoot: string, name: string): string {
  const { begin, end } = cronMarkers(projectRoot, name);
  const lines = crontab.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line === begin) {
      skipping = true;
      continue;
    }
    if (skipping && line === end) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  if (skipping) {
    // A begin marker with no end marker: removing "the block" would delete every
    // line after it, including the operator's own. Refuse and let them fix the file.
    throw new Error(`your crontab has "${begin}" with no matching end marker — fix it by hand (crontab -e); keryx changed nothing`);
  }
  return out.join("\n").replace(/\n+$/, "") + (out.some((l) => l.length > 0) ? "\n" : "");
}

async function check(result: CommandResult, what: string): Promise<void> {
  if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
}

export interface InstallResult {
  readonly backend: ScheduleBackend;
  /** Files written this time (unchanged files are not rewritten). */
  readonly wrote: readonly string[];
  readonly unit: string;
}

/**
 * Install (or re-install) the timer for a confirmed schedule. Idempotent. Refuses when the
 * plan has a `problem` (for example a cadence the backend cannot express).
 */
export async function installSchedule(
  projectRoot: string,
  name: string,
  cron: string,
  host: ScheduleHost = {},
  confirmed?: ConfirmedRunner,
): Promise<InstallResult> {
  const plan = await planInstall(projectRoot, name, cron, host, confirmed ?? currentRunner(host));
  if (plan.problem !== undefined) throw new Error(`cannot install "${name}" on ${plan.backend}: ${plan.problem}`);
  const run = runner(host);
  const wrote: string[] = [];
  for (const file of plan.files) {
    const existing = await readText(file.path);
    if (existing !== undefined && !isManagedBy(existing, projectRoot, name)) {
      throw new Error(`${file.path} exists and was not written by keryx for this project — refusing to overwrite it`);
    }
    if (existing !== file.content) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, "utf8");
      wrote.push(file.path);
    }
  }
  if (plan.backend === "systemd") {
    await check(await run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
    await check(await run("systemctl", ["--user", "enable", "--now", plan.unit]), `systemctl --user enable --now ${plan.unit}`);
  } else if (plan.backend === "launchd") {
    const domain = `gui/${uidOf(host)}`;
    await run("launchctl", ["bootout", `${domain}/${plan.unit}`]);
    await check(await run("launchctl", ["bootstrap", domain, plan.files[0]!.path]), `launchctl bootstrap ${domain}`);
  } else {
    const crontab = await currentCrontab(host);
    const next = `${withoutBlock(crontab, projectRoot, name)}${plan.cronBlock}`;
    if (next !== crontab) {
      await check(await run("crontab", ["-"], next), "crontab -");
      wrote.push("crontab");
    }
  }
  return { backend: plan.backend, wrote, unit: plan.unit };
}

/** Pause: stop the timer, and keep its files so resume needs no new confirmation. Cron removes the block (resume re-adds it). */
export async function pauseSchedule(projectRoot: string, name: string, cron: string, host: ScheduleHost = {}, confirmed?: ConfirmedRunner): Promise<void> {
  const plan = await planInstall(projectRoot, name, cron, host, confirmed ?? currentRunner(host));
  const run = runner(host);
  if (plan.backend === "systemd") {
    await check(await run("systemctl", ["--user", "disable", "--now", plan.unit]), `systemctl --user disable --now ${plan.unit}`);
  } else if (plan.backend === "launchd") {
    await run("launchctl", ["bootout", `gui/${uidOf(host)}/${plan.unit}`]);
  } else {
    const crontab = await currentCrontab(host);
    const next = withoutBlock(crontab, projectRoot, name);
    if (next !== crontab) await check(await run("crontab", ["-"], next), "crontab -");
  }
}

/** Resume: the reverse of pause. It installs the same confirmed content, with the confirmed runner (M1), again. */
export async function resumeSchedule(projectRoot: string, name: string, cron: string, host: ScheduleHost, confirmed: ConfirmedRunner): Promise<void> {
  await installSchedule(projectRoot, name, cron, host, confirmed);
}

export interface UninstallResult {
  readonly removed: readonly string[];
  /** Files found at the expected path that keryx did not write — left untouched. */
  readonly skipped: readonly string[];
}

/** Uninstall: stop the timer and delete ONLY files carrying this project's managed header. */
export async function uninstallSchedule(
  projectRoot: string,
  name: string,
  cron: string,
  host: ScheduleHost = {},
  confirmed?: ConfirmedRunner,
): Promise<UninstallResult> {
  const plan = await planInstall(projectRoot, name, cron, host, confirmed ?? currentRunner(host));
  const run = runner(host);
  const removed: string[] = [];
  const skipped: string[] = [];
  if (plan.backend === "systemd") {
    await run("systemctl", ["--user", "disable", "--now", plan.unit]);
  } else if (plan.backend === "launchd") {
    await run("launchctl", ["bootout", `gui/${uidOf(host)}/${plan.unit}`]);
  }
  for (const file of plan.files) {
    const existing = await readText(file.path);
    if (existing === undefined) continue;
    if (!isManagedBy(existing, projectRoot, name)) {
      skipped.push(file.path);
      continue;
    }
    await rm(file.path, { force: true });
    removed.push(file.path);
  }
  if (plan.backend === "systemd") {
    await run("systemctl", ["--user", "daemon-reload"]);
  } else if (plan.backend === "cron") {
    const crontab = await currentCrontab(host);
    const next = withoutBlock(crontab, projectRoot, name);
    if (next !== crontab) {
      await check(await run("crontab", ["-"], next), "crontab -");
      removed.push("crontab block");
    }
  }
  return { removed, skipped };
}

/** Is the timer's content installed (files with our header, or the crontab block)? Cheap: no scheduler query. */
export async function isScheduleInstalled(
  projectRoot: string,
  name: string,
  cron: string,
  host: ScheduleHost = {},
  confirmed?: ConfirmedRunner,
): Promise<boolean> {
  const plan = await planInstall(projectRoot, name, cron, host, confirmed ?? currentRunner(host));
  if (plan.backend === "cron") {
    const crontab = await currentCrontab(host).catch(() => "");
    return crontab.includes(cronMarkers(projectRoot, name).begin);
  }
  for (const file of plan.files) {
    if (!isManagedBy(await readText(file.path), projectRoot, name)) return false;
  }
  return plan.files.length > 0;
}
