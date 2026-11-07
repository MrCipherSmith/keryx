// `keryx herdr <install|remove|status>` (flow 481, T9).
//
// Opt-in registration of Keryx with the Herdr desktop app and herdr-core. Three
// user-global targets, none of them inside a project:
//
//   programs  <herdr-app home>/programs.json            programs.keryx entry (merged)
//   icon      <herdr-app home>/keryx/keryx.svg           the glyph the entry points at
//   template  <herdr-core home>/templates/keryx.md      the herdr-core agent template
//
// The conventions are those of `keryx skills sync --global` (own the files you
// wrote, never the user's) and the merge-safe JSON edit in `mcp/client-config.ts`:
// ownership is by CONTENT. A programs.keryx entry or file that still equals what
// this module writes is ours and may be updated or removed; anything else is the
// user's and is `kept` unless `--force`. Never run from `keryx update`.
//
// A target whose home directory does not exist is `skipped` and nothing is
// created: Herdr not being installed is not something `keryx` should paper over.

import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, readFile, readlink, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isNotFound, writeFileAtomic } from "../lib/fs";

export type HerdrTarget = "programs" | "icon" | "template";
export type HerdrCommandName = "install" | "remove" | "status";
export type HerdrAction =
  | "created"
  | "updated"
  | "unchanged"
  | "kept"
  | "skipped"
  | "removed"
  | "absent"
  | "installed"
  | "modified"
  | "outdated"
  | "error";

export interface HerdrRow {
  target: HerdrTarget;
  path: string;
  action: HerdrAction;
  reason?: string;
}

export interface HerdrReport {
  command: HerdrCommandName;
  dryRun: boolean;
  targets: HerdrRow[];
}

export interface HerdrOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface HerdrDeps {
  env?: Record<string, string | undefined>;
  platform?: string;
  home?: string;
}

/** The entry Keryx owns in `programs.json`. Ownership is deep equality with this. */
export const HERDR_PROGRAM_ENTRY = {
  name: "Keryx",
  icon: "keryx/keryx.svg",
  tint: true,
  run: ["keryx", "shell"],
} as const;

/**
 * The glyph from `vscode-extension/media/keryx.svg`, embedded: the npm package
 * does not ship `vscode-extension/`. A test keeps the two byte-identical.
 */
export const HERDR_ICON_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <line x1="7" y1="6" x2="17" y2="6" stroke="currentColor" stroke-width="1.6"/>
  <line x1="7" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="1.6"/>
  <line x1="17" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="7" cy="6" r="2.1" fill="currentColor"/>
  <circle cx="17" cy="6" r="2.1" fill="currentColor"/>
  <circle cx="12" cy="18" r="2.1" fill="currentColor"/>
</svg>
`;

/** The herdr-core template. `ready` stays at its default (first OSC 7501 report). */
export const HERDR_TEMPLATE_MD = `---
description: Keryx agent shell. Give it one task and the files in scope.
command: keryx shell
---
You are a Keryx agent started through herdr-core by another agent.
Work only on the task below and stay inside the scope it names. Do not start other agents unless the task asks for it.
If another agent assigned this task, report the result or the blocker when you are done or stuck, not just to acknowledge. Its address is in the \`from\` of the \`<hc from="...">\` message; otherwise \`hc get "$HC_TERMINAL_ID" --json\` shows your parent.
Report over the bus first: with a bus name, use bus_send to \`@<bus name>\`, or from a non-keryx agent \`keryx report --to @<bus name> --from <your name> "<result>"\` (long text in a file, send its path). Use plain \`hc send <its address> "<result>"\` only when you are not on a bus.
Never answer another terminal's dialog. \`hc keys\` and \`hc send --force\` only when the operator asks.
`;

/**
 * Template texts an earlier keryx wrote. A file that still equals one of these is keryx's own, older copy:
 * install updates it without --force, remove deletes it, status calls it out of date. Append the text a
 * release replaces when HERDR_TEMPLATE_MD changes; never edit an entry.
 */
const HERDR_TEMPLATE_PREVIOUS: readonly string[] = [
  `---
description: Keryx agent shell. Give it one task and the files in scope.
command: keryx shell
---
You are a Keryx agent started through herdr-core by another agent.
Work only on the task below and stay inside the scope it names. Do not start other agents unless the task asks for it.
If another agent assigned this task, report the result or the blocker with \`hc send <its address>\` when you are done or stuck, not just to acknowledge. Its address is in the \`from\` of the \`<hc from="...">\` message; otherwise \`hc get "$HC_TERMINAL_ID" --json\` shows your parent.
`,
];

/** Older keryx copies, by target: only the template has had more than one text. */
function olderCopies(target: HerdrTarget): readonly string[] {
  return target === "template" ? HERDR_TEMPLATE_PREVIOUS : [];
}

const BACKUP_SUFFIX = ".keryx-backup";

interface Paths {
  appHome: string;
  coreHome: string;
  programs: string;
  icon: string;
  template: string;
}

function resolvePaths(deps: HerdrDeps): Paths {
  const env = deps.env ?? process.env;
  const xdg = env.XDG_CONFIG_HOME;
  const home = deps.home ?? env.HOME ?? homedir();
  const configHome = xdg !== undefined && xdg !== "" ? xdg : path.join(home, ".config");
  const appHome = path.join(configHome, "herdr-app");
  const coreHome = path.join(configHome, "herdr-core");
  return {
    appHome,
    coreHome,
    programs: path.join(appHome, "programs.json"),
    icon: path.join(appHome, "keryx", "keryx.svg"),
    template: path.join(coreHome, "templates", "keryx.md"),
  };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-insensitive deep equality over JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

type ProgramsDoc =
  | { kind: "missing" }
  | { kind: "ok"; doc: Record<string, unknown>; programs: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

async function loadPrograms(file: string): Promise<ProgramsDoc> {
  const raw = await readIfExists(file);
  if (raw === undefined) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "invalid", reason: `${file} is not valid JSON (${describeError(error)}); left untouched` };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "invalid", reason: `${file} is not a JSON object; left untouched` };
  }
  const programs = parsed.programs;
  if (programs !== undefined && !isPlainObject(programs)) {
    return { kind: "invalid", reason: `${file}: "programs" is not an object; left untouched` };
  }
  return { kind: "ok", doc: parsed, programs: programs ?? {} };
}

function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Copy the current file beside itself once, before the first modification. Any existing entry at
 * the backup path counts, a dangling symlink included (lstat, not a read), and the copy refuses
 * to replace whatever appears there in between (COPYFILE_EXCL), so it never writes through a link.
 */
async function backupOnce(file: string): Promise<void> {
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (await lstat(backup).then(() => true, () => false)) return;
  await copyFile(file, backup, fsConstants.COPYFILE_EXCL);
}

/**
 * Where a write to `file` should land: its link target when it is a symlink (dotfile managers), so
 * the link survives. A dangling link resolves to the path it points at, which the write then creates.
 */
async function writeTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    // Not resolvable: either missing (write `file` itself) or a dangling link chain; follow it by hand.
  }
  let current = file;
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try {
      link = await readlink(current);
    } catch {
      return current; // not a link (or missing): this is where the write lands
    }
    current = path.resolve(path.dirname(current), link);
  }
  throw new Error(`${file}: too many levels of symbolic links`);
}

/** Every write onto a user path goes through here, so none can replace a symlink with a plain file. */
async function writeLinked(file: string, content: string): Promise<void> {
  await writeFileAtomic(await writeTarget(file), content);
}

function skipReason(home: string, what: string): string {
  return `${home} does not exist (${what} not installed or never run); nothing created`;
}

// ---- install ----------------------------------------------------------------

async function installPrograms(p: Paths, opts: HerdrOptions): Promise<HerdrRow> {
  const row = (action: HerdrAction, reason?: string): HerdrRow => ({
    target: "programs",
    path: p.programs,
    action,
    ...(reason === undefined ? {} : { reason }),
  });
  const loaded = await loadPrograms(p.programs);
  if (loaded.kind === "invalid") return row("error", loaded.reason);

  if (loaded.kind === "missing") {
    if (!opts.dryRun) await writeLinked(p.programs, serialize({ programs: { keryx: HERDR_PROGRAM_ENTRY } }));
    return row("created");
  }
  const existing = loaded.programs.keryx;
  if (existing !== undefined && deepEqual(existing, HERDR_PROGRAM_ENTRY)) return row("unchanged");
  if (existing !== undefined && opts.force !== true) {
    return row("kept", "programs.keryx differs from keryx's entry (user-modified); re-run with --force to overwrite");
  }
  if (!opts.dryRun) {
    await backupOnce(p.programs);
    const next = { ...loaded.doc, programs: { ...loaded.programs, keryx: HERDR_PROGRAM_ENTRY } };
    await writeLinked(p.programs, serialize(next));
  }
  return row("updated", existing === undefined ? "added programs.keryx" : "overwrote programs.keryx (--force)");
}

async function installFile(target: HerdrTarget, file: string, content: string, what: string, opts: HerdrOptions): Promise<HerdrRow> {
  const row = (action: HerdrAction, reason?: string): HerdrRow => ({
    target,
    path: file,
    action,
    ...(reason === undefined ? {} : { reason }),
  });
  const current = await readIfExists(file);
  if (current === content) return row("unchanged");
  const older = current !== undefined && olderCopies(target).includes(current);
  if (current !== undefined && !older && opts.force !== true) {
    return row("kept", `${what} differs from keryx's (user-modified); re-run with --force to overwrite`);
  }
  if (!opts.dryRun) await writeLinked(file, content);
  if (older) return row("updated", `replaced the ${what} an earlier keryx wrote`);
  return row(current === undefined ? "created" : "updated", current === undefined ? undefined : `overwrote ${what} (--force)`);
}

// ---- remove -----------------------------------------------------------------

async function removePrograms(p: Paths, opts: HerdrOptions): Promise<HerdrRow> {
  const row = (action: HerdrAction, reason?: string): HerdrRow => ({
    target: "programs",
    path: p.programs,
    action,
    ...(reason === undefined ? {} : { reason }),
  });
  const loaded = await loadPrograms(p.programs);
  if (loaded.kind === "invalid") return row("error", loaded.reason);
  if (loaded.kind === "missing") return row("absent");
  const existing = loaded.programs.keryx;
  if (existing === undefined) return row("absent");
  if (!deepEqual(existing, HERDR_PROGRAM_ENTRY)) return row("kept", "programs.keryx differs from keryx's entry (user-modified)");
  if (!opts.dryRun) {
    await backupOnce(p.programs);
    const { keryx: _own, ...rest } = loaded.programs;
    await writeLinked(p.programs, serialize({ ...loaded.doc, programs: rest }));
  }
  return row("removed", "deleted programs.keryx; programs.json itself is kept");
}

async function removeFile(target: HerdrTarget, file: string, content: string, what: string, opts: HerdrOptions): Promise<HerdrRow> {
  const row = (action: HerdrAction, reason?: string): HerdrRow => ({
    target,
    path: file,
    action,
    ...(reason === undefined ? {} : { reason }),
  });
  const current = await readIfExists(file);
  if (current === undefined) return row("absent");
  if (current !== content && !olderCopies(target).includes(current)) return row("kept", `${what} differs from keryx's (user-modified)`);
  if (!opts.dryRun) {
    await unlink(file);
    // The `keryx/` directory we created: drop it only when nothing else lives there.
    // (`templates/` is herdr-core's own directory and is never removed.)
    if (target === "icon") await rmdir(path.dirname(file)).catch(() => undefined);
  }
  return row("removed");
}

// ---- status -----------------------------------------------------------------

async function statusPrograms(p: Paths): Promise<HerdrRow> {
  const loaded = await loadPrograms(p.programs);
  const mk = (action: HerdrAction, reason?: string): HerdrRow => ({
    target: "programs",
    path: p.programs,
    action,
    ...(reason === undefined ? {} : { reason }),
  });
  if (loaded.kind === "invalid") return mk("error", loaded.reason);
  if (loaded.kind === "missing") return mk("absent");
  const existing = loaded.programs.keryx;
  if (existing === undefined) return mk("absent");
  return deepEqual(existing, HERDR_PROGRAM_ENTRY) ? mk("installed") : mk("modified", "programs.keryx differs from keryx's entry");
}

async function statusFile(target: HerdrTarget, file: string, content: string): Promise<HerdrRow> {
  const current = await readIfExists(file);
  if (current === undefined) return { target, path: file, action: "absent" };
  if (olderCopies(target).includes(current)) {
    return { target, path: file, action: "outdated", reason: "written by an earlier keryx; `keryx herdr install` updates it" };
  }
  return current === content
    ? { target, path: file, action: "installed" }
    : { target, path: file, action: "modified", reason: "content differs from keryx's" };
}

// ---- orchestration ----------------------------------------------------------

async function guarded(target: HerdrTarget, file: string, run: () => Promise<HerdrRow>): Promise<HerdrRow> {
  try {
    return await run();
  } catch (error) {
    return { target, path: file, action: "error", reason: describeError(error) };
  }
}

export async function runHerdr(command: HerdrCommandName, opts: HerdrOptions = {}, deps: HerdrDeps = {}): Promise<HerdrReport> {
  const platform = deps.platform ?? process.platform;
  const p = resolvePaths(deps);
  const dryRun = command !== "status" && opts.dryRun === true;
  const eff: HerdrOptions = { dryRun, force: opts.force === true };
  const report = (targets: HerdrRow[]): HerdrReport => ({ command, dryRun, targets });

  if (platform === "win32") {
    const reason = "herdr-core keeps its config under %APPDATA% on Windows; keryx does not guess those paths";
    return report([
      { target: "programs", path: p.programs, action: "skipped", reason },
      { target: "icon", path: p.icon, action: "skipped", reason },
      { target: "template", path: p.template, action: "skipped", reason },
    ]);
  }

  const appOk = await isDirectory(p.appHome);
  const coreOk = await isDirectory(p.coreHome);
  const appSkip = (target: HerdrTarget, file: string): HerdrRow => ({
    target,
    path: file,
    action: "skipped",
    reason: skipReason(p.appHome, "Herdr app"),
  });
  const coreSkip: HerdrRow = {
    target: "template",
    path: p.template,
    action: "skipped",
    reason: skipReason(p.coreHome, "herdr-core"),
  };

  const rows: HerdrRow[] = [];
  // An invalid programs.json stops install and remove before anything else is written, so the
  // run either changes the set as a whole or names the one file that blocked it.
  const stopped = (target: HerdrTarget, file: string): HerdrRow => ({
    target,
    path: file,
    action: "skipped",
    reason: "not written: programs.json could not be changed (see above)",
  });
  let programsFailed = false;
  // install and remove: run the programs step, and stop before the icon when it failed.
  const programsThenIcon = async (
    programsStep: () => Promise<HerdrRow>,
    iconStep: () => Promise<HerdrRow>,
  ): Promise<void> => {
    const programs = await guarded("programs", p.programs, programsStep);
    programsFailed = programs.action === "error";
    rows.push(programs);
    rows.push(programsFailed ? stopped("icon", p.icon) : await guarded("icon", p.icon, iconStep));
  };
  if (!appOk) {
    rows.push(appSkip("programs", p.programs), appSkip("icon", p.icon));
  } else if (command === "install") {
    await programsThenIcon(() => installPrograms(p, eff), () => installFile("icon", p.icon, HERDR_ICON_SVG, "keryx.svg", eff));
  } else if (command === "remove") {
    await programsThenIcon(() => removePrograms(p, eff), () => removeFile("icon", p.icon, HERDR_ICON_SVG, "keryx.svg", eff));
  } else {
    rows.push(await guarded("programs", p.programs, () => statusPrograms(p)));
    rows.push(await guarded("icon", p.icon, () => statusFile("icon", p.icon, HERDR_ICON_SVG)));
  }

  if (!coreOk) {
    rows.push(coreSkip);
  } else if (programsFailed) {
    rows.push(stopped("template", p.template));
  } else if (command === "install") {
    rows.push(await guarded("template", p.template, () => installFile("template", p.template, HERDR_TEMPLATE_MD, "keryx.md", eff)));
  } else if (command === "remove") {
    rows.push(await guarded("template", p.template, () => removeFile("template", p.template, HERDR_TEMPLATE_MD, "keryx.md", eff)));
  } else {
    rows.push(await guarded("template", p.template, () => statusFile("template", p.template, HERDR_TEMPLATE_MD)));
  }
  return report(rows);
}

// ---- rendering and CLI ------------------------------------------------------

export function hasHerdrError(report: HerdrReport): boolean {
  return report.targets.some((row) => row.action === "error");
}

export function renderHerdrReport(report: HerdrReport): string {
  const lines: string[] = [`keryx herdr ${report.command}${report.dryRun ? " (dry run, nothing written)" : ""}`, ""];
  for (const row of report.targets) {
    lines.push(`  ${row.target.padEnd(9)} ${row.action.padEnd(10)} ${row.path}`);
    if (row.reason !== undefined) lines.push(`            ${row.reason}`);
  }
  lines.push("");
  const actions = report.targets.map((row) => row.action);
  if (hasHerdrError(report)) {
    lines.push("Finished with errors; each target marked error was left untouched.");
  } else if (report.command === "install" && actions.every((a) => a === "unchanged")) {
    lines.push("Already installed: nothing to change.");
  } else if (report.command === "install" && actions.includes("kept")) {
    lines.push("Some targets were kept because they differ from keryx's; --force overwrites them.");
  }
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`keryx herdr — register Keryx with the Herdr desktop app and herdr-core (opt-in)

Usage:
  keryx herdr install [--dry-run] [--force] [--json]
  keryx herdr remove  [--dry-run] [--json]
  keryx herdr status  [--json]

Targets (config home honours XDG_CONFIG_HOME, default ~/.config):
  programs  herdr-app/programs.json         merges programs.keryx; other keys are preserved
  icon      herdr-app/keryx/keryx.svg       the glyph programs.keryx points at
  template  herdr-core/templates/keryx.md   herdr-core agent template (command: keryx shell)

A target whose herdr-app or herdr-core directory does not exist is skipped and
nothing is created. An invalid programs.json stops install and remove with a
non-zero exit before anything is written, and is left byte-identical. A programs.keryx entry, keryx.svg or keryx.md that
differs from keryx's own is kept unless --force. The first change to an existing
programs.json leaves programs.json${BACKUP_SUFFIX} beside it. remove deletes only
what still equals keryx's own and never deletes programs.json itself.
`);
}

/** The flags each subcommand takes, as its usage line lists them; anything else is refused. */
const FLAGS: Record<HerdrCommandName, ReadonlySet<string>> = {
  install: new Set(["--dry-run", "--force", "--json"]),
  remove: new Set(["--dry-run", "--json"]),
  status: new Set(["--json"]),
};

export async function herdrCommand(args: string[] = [], deps: HerdrDeps = {}): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub !== "install" && sub !== "remove" && sub !== "status") {
    console.error(`Unknown herdr command: ${sub}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  const rest = args.slice(1);
  const unknown = rest.find((arg) => !FLAGS[sub].has(arg));
  if (unknown !== undefined) {
    console.error(`Unknown option for herdr ${sub}: ${unknown}`);
    process.exitCode = 1;
    return;
  }
  const report = await runHerdr(sub, { dryRun: rest.includes("--dry-run"), force: rest.includes("--force") }, deps);
  console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : renderHerdrReport(report));
  if (hasHerdrError(report)) process.exitCode = 1;
}
