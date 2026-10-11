// Flow 424 (AC10): the TUI surface of the autonomous review.
//
//   - sidebar section `sb-autoreview`: for each running review its phase, rounds, tokens and the
//     last answer it gave itself; the most recent finished one for a day. Hidden when there is none.
//   - `/autoreview [list]`, `/autoreview start <PR URL> [--budget-minutes N] [--budget-tokens N]`,
//     `/autoreview stop [PR URL | number]`, `/autoreview arbiter [PR URL | number]` (flow 425: the run's
//     arbiter log, one line per question: kind, verdict, rule).
//
// A started review is `keryx review run --autonomous` in a detached child — the same command a
// terminal or a scheduled timer runs — so the surface reads its files and never talks to it: the
// run directory's `progress.json` and `lock.json` are the whole interface, and `stop` is a SIGTERM
// to the pid in the lock.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findAgentCommand } from "../commands/agent-commands";
import { ARBITER_LOG_NAME, describeArbiterRecord, readArbiterLog, type ArbiterLogRecord } from "../review/arbiter-log";
import { parseAutonomousTarget } from "../review/autonomous-profile";
import { autonomousRunDir, type RunProgress } from "../review/autonomous-run";
import { classifyBusyDispatch } from "./busy-dispatch";
import { commandToken } from "./ops-sidebar";
import { onThemeChange, type TextRole } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";

type OpenTui = typeof import("@opentui/core");

export const AUTOREVIEW_COMMAND = "/autoreview";
export const AUTOREVIEW_USAGE =
  "/autoreview [list] | /autoreview start <pull request URL> [--budget-minutes N] [--budget-tokens N] | /autoreview stop [pull request URL | number] | /autoreview arbiter [pull request URL | number]";

const FINISHED_VISIBLE_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 5000;

export type AutoReviewCommand =
  | { readonly kind: "list" }
  | { readonly kind: "start"; readonly ref: string; readonly budgetMinutes?: number; readonly budgetTokens?: number }
  | { readonly kind: "stop"; readonly selector?: string }
  | { readonly kind: "arbiter"; readonly selector?: string }
  | { readonly kind: "error"; readonly message: string };

export function parseAutoReviewArgs(line: string): AutoReviewCommand {
  const words = line.trim().split(/\s+/).slice(1);
  const verb = words[0] ?? "list";
  const rest = words.slice(1);
  if (verb === "list" || verb === "ls") return { kind: "list" };
  if (verb === "arbiter") return { kind: "arbiter", ...(rest[0] === undefined ? {} : { selector: rest[0] }) };
  if (verb === "stop") return { kind: "stop", ...(rest[0] === undefined ? {} : { selector: rest[0] }) };
  if (verb !== "start") return { kind: "error", message: `unknown subcommand "${verb}". ${AUTOREVIEW_USAGE}` };

  let ref: string | undefined;
  const numbers: Record<string, number> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word === "--budget-minutes" || word === "--budget-tokens") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value <= 0 || (word === "--budget-tokens" && !Number.isInteger(value))) {
        return { kind: "error", message: `${word} needs a positive ${word === "--budget-tokens" ? "whole " : ""}number` };
      }
      numbers[word] = value;
      i += 1;
    } else if (word.startsWith("-")) {
      return { kind: "error", message: `unknown option ${word}. ${AUTOREVIEW_USAGE}` };
    } else if (ref === undefined) {
      ref = word;
    } else {
      return { kind: "error", message: `unexpected "${word}". ${AUTOREVIEW_USAGE}` };
    }
  }
  if (ref === undefined) return { kind: "error", message: `start needs a pull request URL. ${AUTOREVIEW_USAGE}` };
  try {
    parseAutonomousTarget(ref);
  } catch (problem) {
    return { kind: "error", message: problem instanceof Error ? problem.message : String(problem) };
  }
  return {
    kind: "start",
    ref,
    ...(numbers["--budget-minutes"] === undefined ? {} : { budgetMinutes: numbers["--budget-minutes"] }),
    ...(numbers["--budget-tokens"] === undefined ? {} : { budgetTokens: numbers["--budget-tokens"] }),
  };
}

export interface AutoReviewRun {
  readonly slug: string;
  readonly ref: string;
  /** `owner/repo#N`, or the directory name when the ref does not parse. */
  readonly label: string;
  /** `running` only while the lock's process is alive; a run whose process is gone is `died`. */
  readonly state: RunProgress["state"] | "died";
  readonly live: boolean;
  readonly pid: number | undefined;
  readonly phase: string;
  readonly rounds: number;
  readonly tokens: number;
  readonly startedAt: string;
  readonly updatedAt: string | undefined;
  readonly lastAnswer: RunProgress["lastAnswer"];
  readonly reason: string | undefined;
  /** What the review arbiter did in this run (flow 425); absent when it was never consulted. */
  readonly arbiter?: { readonly asked: number; readonly escalated: number };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function labelOf(ref: string, slug: string): string {
  try {
    const target = parseAutonomousTarget(ref);
    return `${target.repository}#${target.number}`;
  } catch {
    return slug;
  }
}

export function autoReviewRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "review-autonomous");
}

function arbiterCounts(dir: string): { arbiter?: { asked: number; escalated: number } } {
  const records = readArbiterLog(path.join(dir, ARBITER_LOG_NAME));
  if (records.length === 0) return {};
  return { arbiter: { asked: records.length, escalated: records.filter((record) => record.verdict === "escalate").length } };
}

/** Every run directory, newest first. A directory with neither a progress file nor a live lock is not a run. */
export function readAutoReviewRuns(cwd: string): AutoReviewRun[] {
  const root = autoReviewRoot(cwd);
  if (!existsSync(root)) return [];
  const runs: AutoReviewRun[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const progress = readJson<RunProgress & { updatedAt?: string }>(path.join(dir, "progress.json"));
    const lock = readJson<{ pid?: number; startedAt?: string }>(path.join(dir, "lock.json"));
    const live = typeof lock?.pid === "number" && pidAlive(lock.pid);
    if (progress === undefined && !live) continue;
    const ref = progress?.ref ?? "";
    const state: AutoReviewRun["state"] = live ? "running" : progress === undefined ? "died" : progress.state === "running" ? "died" : progress.state;
    runs.push({
      slug: entry.name,
      ref,
      label: labelOf(ref, entry.name),
      state,
      live,
      pid: live ? lock?.pid : undefined,
      phase: progress?.phase ?? "starting",
      rounds: progress?.rounds ?? 0,
      tokens: progress?.tokens ?? 0,
      startedAt: progress?.startedAt ?? lock?.startedAt ?? "",
      updatedAt: progress?.updatedAt,
      lastAnswer: progress?.lastAnswer,
      reason: progress?.reason,
      ...arbiterCounts(dir),
    });
  }
  const stamp = (run: AutoReviewRun): number => Date.parse(run.updatedAt ?? run.startedAt) || 0;
  return runs.sort((a, b) => Number(b.live) - Number(a.live) || stamp(b) - stamp(a));
}

export interface AutoReviewChunk {
  readonly role: TextRole | "dim";
  readonly text: string;
}

export interface AutoReviewRow {
  readonly id: string;
  readonly chunks: readonly AutoReviewChunk[];
}

export interface AutoReviewProjection {
  readonly visible: boolean;
  readonly rows: readonly AutoReviewRow[];
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Number((tokens / 1000).toFixed(1))}k` : String(tokens);
}

function stateRole(state: AutoReviewRun["state"]): TextRole {
  if (state === "running") return "accent";
  if (state === "complete") return "ok";
  if (state === "incomplete") return "attention";
  return "error";
}

/** Running reviews, or the latest finished one while it is under a day old. Nothing, otherwise. */
export function projectAutoReviewPanel(runs: readonly AutoReviewRun[], options: { width: number; now: Date }): AutoReviewProjection {
  const w = options.width;
  const shown: AutoReviewRun[] = runs.filter((run) => run.live);
  if (shown.length === 0) {
    const latest = runs[0];
    const at = latest === undefined ? 0 : Date.parse(latest.updatedAt ?? latest.startedAt) || 0;
    if (latest !== undefined && options.now.getTime() - at < FINISHED_VISIBLE_MS) shown.push(latest);
  }
  if (shown.length === 0) return { visible: false, rows: [] };
  const rows: AutoReviewRow[] = [];
  for (const run of shown) {
    const head = run.live ? `${run.label} ${run.phase}` : `${run.label} ${run.state}`;
    rows.push({ id: `sb-autoreview-${run.slug}`, chunks: [{ role: stateRole(run.state), text: fit(head, w) }] });
    rows.push({
      id: `sb-autoreview-${run.slug}-n`,
      chunks: [{ role: "dim", text: `  ${fit(`round ${run.rounds} · ${formatTokens(run.tokens)} tok`, w - 2)}` }],
    });
    if (run.lastAnswer !== undefined) {
      rows.push({ id: `sb-autoreview-${run.slug}-a`, chunks: [{ role: "muted", text: `  ${fit(`auto: ${run.lastAnswer.answer}`, w - 2)}` }] });
    }
    if (run.arbiter !== undefined) {
      const { asked, escalated } = run.arbiter;
      const text = `arbiter ${asked}${escalated > 0 ? ` · ${escalated} escalated` : " asked"}`;
      rows.push({ id: `sb-autoreview-${run.slug}-b`, chunks: [{ role: escalated > 0 ? "attention" : "muted", text: `  ${fit(text, w - 2)}` }] });
    }
  }
  return { visible: true, rows };
}

export function autoReviewListText(runs: readonly AutoReviewRun[]): string {
  if (runs.length === 0) return `No autonomous reviews yet. Start one: /autoreview start <pull request URL>\n`;
  const lines = runs.map((run) => {
    const bits = [`${run.label.padEnd(24)} ${run.state.padEnd(10)}`, `${run.phase}`, `round ${run.rounds}`, `${formatTokens(run.tokens)} tok`];
    if (run.pid !== undefined) bits.push(`pid ${run.pid}`);
    if (run.arbiter !== undefined) bits.push(`arbiter ${run.arbiter.asked}${run.arbiter.escalated > 0 ? ` (${run.arbiter.escalated} escalated)` : ""}`);
    if (run.reason !== undefined && !run.live) bits.push(run.reason);
    return `  ${bits.join(" · ")}`;
  });
  return `Autonomous reviews:\n${lines.join("\n")}\n`;
}

const ARBITER_LINES_SHOWN = 30;

/** The run's arbiter log for a transcript: one line per question, kind and verdict and rule, newest last. */
export function arbiterLogText(run: AutoReviewRun, records: readonly ArbiterLogRecord[]): string {
  if (records.length === 0) return `${run.label}: the arbiter has not been consulted in this run.\n`;
  const shown = records.slice(-ARBITER_LINES_SHOWN);
  const lines = shown.map((record) => {
    const time = record.at.length >= 19 ? record.at.slice(11, 19) : record.at;
    const why = record.verdict === "allow" || record.reason === "model" || record.reason === "cache" ? "" : ` · ${record.reason}`;
    return `  ${time}  ${describeArbiterRecord(record)}${why}`;
  });
  const hidden = records.length - shown.length;
  const escalated = records.filter((record) => record.verdict === "escalate").length;
  return [
    `Arbiter log for ${run.label}: ${records.length} question(s), ${escalated} escalated`,
    ...(hidden > 0 ? [`  (${hidden} earlier not shown; the full log is arbiter.log in the run directory)`] : []),
    ...lines,
  ].join("\n") + "\n";
}

export interface AutoReviewStartSpec {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface AutoReviewDeps {
  readonly cwd: string;
  /** One transcript line (the shell's `io.onSystem`). */
  readonly notice: (text: string) => void;
  readonly read?: (cwd: string) => AutoReviewRun[];
  /** Starts `keryx <args>` detached and returns its pid. */
  readonly start?: (spec: AutoReviewStartSpec) => number | undefined;
  readonly stop?: (pid: number) => void;
  /** The records of one run's arbiter log. */
  readonly readArbiter?: (cwd: string, run: AutoReviewRun) => ArbiterLogRecord[];
}

function defaultStart(spec: AutoReviewStartSpec): number | undefined {
  const child = nodeSpawn(process.execPath, [process.argv[1] ?? "", ...spec.args], {
    cwd: spec.cwd,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

function defaultReadArbiter(cwd: string, run: AutoReviewRun): ArbiterLogRecord[] {
  return readArbiterLog(path.join(autoReviewRoot(cwd), run.slug, ARBITER_LOG_NAME));
}

const defaultStop = (pid: number): void => {
  process.kill(pid, "SIGTERM");
};

function matches(run: AutoReviewRun, selector: string): boolean {
  const bare = selector.replace(/^#/, "");
  return run.ref === selector || run.slug === selector || run.label === selector || run.label.endsWith(`#${bare}`);
}

export interface AutoReviewController {
  handleCommand(line: string): boolean;
}

export function createAutoReviewController(deps: AutoReviewDeps): AutoReviewController {
  const read = deps.read ?? readAutoReviewRuns;
  const start = deps.start ?? defaultStart;
  const stop = deps.stop ?? defaultStop;
  const readArbiter = deps.readArbiter ?? defaultReadArbiter;
  const say = (text: string): void => deps.notice(text.endsWith("\n") ? text : `${text}\n`);

  return {
    handleCommand(line) {
      if (commandToken(line) !== AUTOREVIEW_COMMAND) return false;
      const command = parseAutoReviewArgs(line);
      if (command.kind === "error") {
        say(`/autoreview: ${command.message}`);
        return true;
      }
      if (command.kind === "list") {
        say(autoReviewListText(read(deps.cwd)));
        return true;
      }
      if (command.kind === "arbiter") {
        const runs = read(deps.cwd);
        const live = runs.filter((run) => run.live);
        // no selector: the run in progress, else the newest one
        const chosen = command.selector === undefined ? (live.length === 1 ? live[0] : live.length === 0 ? runs[0] : undefined) : runs.find((run) => matches(run, command.selector!));
        if (chosen === undefined) {
          say(
            runs.length === 0
              ? "/autoreview: no autonomous review yet, so there is no arbiter log."
              : command.selector === undefined
                ? `/autoreview: say which one: ${live.map((run) => run.label).join(", ")}.`
                : `/autoreview: no review matches "${command.selector}": ${runs.map((run) => run.label).join(", ")}.`,
          );
          return true;
        }
        say(arbiterLogText(chosen, readArbiter(deps.cwd, chosen)));
        return true;
      }
      if (command.kind === "start") {
        const target = parseAutonomousTarget(command.ref);
        const running = read(deps.cwd).find((run) => run.live && run.slug === path.basename(autonomousRunDir(deps.cwd, target)));
        if (running !== undefined) {
          say(`/autoreview: ${running.label} is already being reviewed (pid ${running.pid}); /autoreview stop ${running.label} first.`);
          return true;
        }
        const args = [
          "review",
          "run",
          "--autonomous",
          "--target",
          "pr",
          "--ref",
          command.ref,
          ...(command.budgetMinutes === undefined ? [] : ["--budget-minutes", String(command.budgetMinutes)]),
          ...(command.budgetTokens === undefined ? [] : ["--budget-tokens", String(command.budgetTokens)]),
        ];
        const pid = start({ cwd: deps.cwd, args });
        say(
          pid === undefined
            ? `/autoreview: could not start the review of ${command.ref}.`
            : `Autonomous review of ${target.repository}#${target.number} started (pid ${pid}) — progress in the sidebar, /autoreview stop to end it.`,
        );
        return true;
      }
      const live = read(deps.cwd).filter((run) => run.live && run.pid !== undefined);
      const chosen = command.selector === undefined ? (live.length === 1 ? live[0] : undefined) : live.find((run) => matches(run, command.selector!));
      if (chosen?.pid === undefined) {
        say(
          live.length === 0
            ? "/autoreview: no autonomous review is running."
            : `/autoreview: say which one to stop: ${live.map((run) => run.label).join(", ")}.`,
        );
        return true;
      }
      try {
        stop(chosen.pid);
        say(`Stopping the review of ${chosen.label} (pid ${chosen.pid}) — it ends the shell, keeps the package and reports "incomplete".`);
      } catch (problem) {
        say(`/autoreview: could not stop pid ${chosen.pid}: ${problem instanceof Error ? problem.message : String(problem)}`);
      }
      return true;
    },
  };
}

/**
 * The shell's routing of `/autoreview`, called from BOTH of `runLine`'s branches in `tui-shell.ts`:
 * idle through the agent-mode registry, busy only when `classifyBusyDispatch` names it `autoreview`
 * (it starts and stops a separate process, never the main turn). Returns whether the line was handled.
 */
export function routeAutoReviewCommand(line: string, busy: boolean, controller: AutoReviewController): boolean {
  const command = findAgentCommand(line, "agent");
  if (command === undefined || command.name !== AUTOREVIEW_COMMAND) return false;
  if (busy) {
    const target = classifyBusyDispatch({
      line,
      commandName: command.name,
      isSessionInfo: false,
      isFlows: false,
      isWorkspace: false,
      isReview: false,
      isMcp: false,
      isMcpConsumer: false,
    });
    if (target !== "autoreview") return false;
  }
  return controller.handleCommand(line);
}

type Box = { add(child: unknown): void; remove(child: unknown): void; getChildren(): unknown[] };

export interface AutoReviewPanelOptions {
  cwd: string;
  width: number;
  /** A click on the section label: the list. */
  onOpen: () => void;
  read?: (cwd: string) => AutoReviewRun[];
  now?: () => Date;
  pollMs?: number;
}

export interface AutoReviewPanelHandle {
  refresh(): void;
  projection(): AutoReviewProjection;
  /** How many times the rows were rebuilt (an unchanged poll rebuilds nothing). */
  paintCount(): number;
  dispose(): void;
}

export function mountAutoReviewPanel(otui: unknown, renderer: unknown, parent: unknown, options: AutoReviewPanelOptions): AutoReviewPanelHandle {
  const core = otui as OpenTui;
  const r = renderer as never;
  const box = new core.BoxRenderable(r, { id: "sb-autoreview", flexDirection: "column", flexShrink: 0 }) as unknown as Box;
  (parent as { add(child: unknown): void }).add(box);
  const read = options.read ?? readAutoReviewRuns;
  const now = options.now ?? (() => new Date());
  let projected: AutoReviewProjection = { visible: false, rows: [] };
  let paintedKey: string | undefined;
  let paints = 0;
  let disposed = false;

  const chunkOf = (c: AutoReviewChunk): ReturnType<typeof dimChunk> => (c.role === "dim" ? dimChunk(core, c.text) : roleChunk(core, c.role, c.text));

  const paint = (force = false): void => {
    if (disposed) return;
    projected = projectAutoReviewPanel(read(options.cwd), { width: options.width, now: now() });
    const key = JSON.stringify(projected);
    if (!force && key === paintedKey) return;
    paintedKey = key;
    paints += 1;
    clearTranscriptChildren(box);
    if (!projected.visible) return;
    box.add(new core.TextRenderable(r, { id: "sb-autoreview-k", content: core.t`${dimChunk(core, "Auto review")}`, marginTop: 1, onMouseDown: () => options.onOpen() }));
    for (const row of projected.rows) {
      box.add(new core.TextRenderable(r, { id: row.id, content: new core.StyledText(row.chunks.map(chunkOf)), onMouseDown: () => options.onOpen() }));
    }
  };

  const refresh = (): void => {
    try {
      paint();
    } catch {
      // the run files are an observation; a half-written one is read again on the next poll
    }
  };
  refresh();
  const timer = setInterval(refresh, options.pollMs ?? POLL_MS);
  timer.unref?.();
  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("autoreview-panel", () => paint(true), () => disposed || isRenderableGone(box)));
  return {
    refresh,
    projection: () => projected,
    paintCount: () => paints,
    dispose() {
      disposed = true;
      clearInterval(timer);
      unsubscribeTheme();
    },
  };
}

export interface AutoReviewSidebarOptions {
  otui: unknown;
  renderer: unknown;
  parent: unknown;
  cwd: string;
  width: number;
  notice: (text: string) => void;
  read?: AutoReviewDeps["read"];
  start?: AutoReviewDeps["start"];
  stop?: AutoReviewDeps["stop"];
  readArbiter?: AutoReviewDeps["readArbiter"];
}

export interface AutoReviewSidebar extends AutoReviewController {
  readonly panel: AutoReviewPanelHandle;
  dispose(): void;
}

export function mountAutoReviewSidebar(options: AutoReviewSidebarOptions): AutoReviewSidebar {
  const deps: AutoReviewDeps = {
    cwd: options.cwd,
    notice: options.notice,
    ...(options.read === undefined ? {} : { read: options.read }),
    ...(options.start === undefined ? {} : { start: options.start }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.readArbiter === undefined ? {} : { readArbiter: options.readArbiter }),
  };
  const base = createAutoReviewController(deps);
  const panel = mountAutoReviewPanel(options.otui, options.renderer, options.parent, {
    cwd: options.cwd,
    width: options.width,
    onOpen: () => void base.handleCommand(`${AUTOREVIEW_COMMAND} list`),
    ...(options.read === undefined ? {} : { read: options.read }),
  });
  return {
    panel,
    handleCommand(line) {
      const handled = base.handleCommand(line);
      if (handled) panel.refresh();
      return handled;
    },
    dispose: () => panel.dispose(),
  };
}
