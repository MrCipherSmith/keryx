// Flow 295 T9 (AC11, AC12, AC14): the Schedules modals.
//
//   /schedules          the LIST modal. ↑/↓ selects, Enter opens the selected
//                       schedule's detail, Esc closes. No mouse is needed anywhere.
//   detail (4 tabs)     Overview · Grants · Runs · Report, opened by Enter, by a
//                       sidebar row click, or by `/schedules <name>`.
//
// Detail actions. Each is a key, and the first line of every tab lists them:
//   p    pause, or resume. One step, because it only stops or restarts a confirmed
//        timer, with content and signature unchanged.
//   r    run now: arm, then `y`; any other key cancels. It starts
//        `keryx trigger run --schedule <name>` as a detached CHILD of this build
//        (flow 300's run-now), bound by the CLI's locks, budget and refusals. It is
//        never in-process and never a JobRegistry task.
//   d    delete: arm, then `y`; any other key cancels. (`x` is modal-host's own
//        close key, so it is never an action here.) It uninstalls the timer (only
//        keryx-written files) and removes the entry.
// Pause, resume and delete call the same service functions `keryx schedule
// pause|resume|remove` call (`../trigger/schedules.ts`). The modal reloads after each.
// Actions apply only to local schedules (`keryx schedule add`, /schedule). A schedule-fired
// trigger declared in the committed triggers.json is read-only here.

import type { AgentTaskAction } from "../trigger/config";
import { describeCost, describeFire, NETWORK_ON_WARNING } from "../trigger/describe";
import { grantedToolSpec } from "../trigger/granted-tools";
import { isScheduleInstalled, lingerStatus, planInstall, type ScheduleHost } from "../trigger/install";
import { expectedReportRelPath, type TriggerRunRecord } from "../trigger/record";
import { nextCronRuns } from "../trigger/cron";
import {
  cardSafe,
  latestReportPath,
  nestedAgentScheduleRefusal,
  pauseStoredSchedule,
  removeSchedule,
  resumeStoredSchedule,
  scheduleVerification,
} from "../trigger/schedules";
import { readScheduleReport } from "../trigger/store";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { formatLastOutcome, formatLocalDateTime, formatNextRun, latestOutcome } from "./schedules-panel";
import { loadTriggerLedgerView, scheduledEntries, type TriggerEntryView, type TriggerLedgerView } from "./trigger-ledger";
import type { TriggerRunNow } from "./trigger-run-now";

type OpenTui = typeof import("@opentui/core");

export const SCHEDULES_COMMAND = "/schedules";

/** The keys, shown as the first line of every detail tab (AC12). */
export const DETAIL_KEYS = "keys: p pause/resume · r run now (then y) · d delete (then y) · ←/→ tabs · ↑/↓ scroll · esc close";
/** The keys, shown as the first line of the list (AC12). */
export const LIST_KEYS = "keys: ↑/↓ select · enter open · esc close";

export const DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "grants", label: "Grants" },
  { id: "runs", label: "Runs" },
  { id: "report", label: "Report" },
] as const;

/** Ledger records the Runs tab lists. */
export const RUNS_SHOWN = 12;

/** The side effects the modal's keys have. Default: the same service the CLI calls. */
export interface ScheduleActions {
  pause(cwd: string, name: string): Promise<void>;
  resume(cwd: string, name: string): Promise<void>;
  remove(cwd: string, name: string): Promise<{ removed: readonly string[]; skipped: readonly string[] }>;
}

export function defaultScheduleActions(host: ScheduleHost = {}): ScheduleActions {
  return {
    pause: (cwd, name) => pauseStoredSchedule(cwd, name, host),
    resume: (cwd, name) => resumeStoredSchedule(cwd, name, host),
    remove: (cwd, name) => removeSchedule(cwd, name, host),
  };
}

function agentTask(item: TriggerEntryView): AgentTaskAction | undefined {
  return item.entry.action.kind === "agent-task" ? item.entry.action : undefined;
}

function isLocal(item: TriggerEntryView): boolean {
  return item.entry.source === "store" && agentTask(item) !== undefined;
}

function recordLine(record: TriggerRunRecord): string {
  const refusal = record.agentTask?.refusal ?? record.dispatch?.refusal;
  // M2: `detail` comes from runs.jsonl, which a commit can plant — no control characters reach the terminal.
  return cardSafe(`${record.at}  ${record.outcome}${refusal !== undefined ? ` (${refusal})` : ""} — ${record.detail}  [${describeCost(record.cost)}]`);
}

/** What the Overview says about the installed timer (M4, L1). */
export interface InstallDescription {
  /** "yes (…)" / "NO — …" / "n/a (…)". */
  readonly installed: string;
  /** The timer unit, launchd label or crontab marker. */
  readonly unit: string;
  readonly linger: "yes" | "no" | "unknown" | "n/a";
  /** L1: does the stored entry still verify (signature and binary pins)? */
  readonly verified: string;
}

/** Overview tab (unwrapped lines). */
export function overviewLines(item: TriggerEntryView, now: Date, install: InstallDescription | undefined): string[] {
  const { entry } = item;
  const cron = entry.fire.kind === "schedule" ? entry.fire.cron : "";
  // L4: local time, as the sidebar row shows it.
  const next = entry.enabled ? nextCronRuns(cron, now, 3).map(formatLocalDateTime) : [];
  const task = agentTask(item);
  const latest = latestOutcome(item);
  const lines = [
    `${entry.name}  [${entry.enabled ? "active" : "paused"}]  ${isLocal(item) ? "local schedule" : "declared in triggers.json (read-only here)"}`,
    "",
    `cadence    ${describeFire(entry.fire)}`,
    `next runs  ${entry.enabled ? next.join(", ") || "none within a year" : "— (paused)"}`,
    `last run   ${latest === undefined ? "never ran" : cardSafe(`${formatLastOutcome(latest, now)} — ${latest.detail}`)}`,
    `installed  ${install?.installed ?? "…"}`,
    `unit       ${install?.unit ?? "…"}`,
    `linger     ${install?.linger ?? "…"}${install?.linger === "no" ? " (the timer runs only while you are logged in)" : ""}`,
    `verified   ${install?.verified ?? "…"}`,
  ];
  if (task !== undefined) {
    lines.push(
      `runner     ${task.dispatch.provider}/${task.dispatch.model}, mode ${task.dispatch.permissionMode}`,
      `budget     ceiling $${task.dispatch.ceilingUsd}, max ${task.dispatch.maxSeconds}s per run`,
      "",
      "prompt",
      ...task.prompt.split("\n").map((l) => `  ${l}`),
    );
  }
  return lines;
}

/** Grants tab. */
export function grantsLines(item: TriggerEntryView): string[] {
  const task = agentTask(item);
  if (task === undefined) return ["This schedule is not an agent task; it has no grants."];
  const g = task.grants;
  const lines = [
    `network   ${g.network === "full" ? `NETWORK ON — ${NETWORK_ON_WARNING}` : "off (the agent's shell has no network)"}`,
    `account   ${g.account ?? "unknown"}`,
    `repos     ${g.repos.join(", ") || "none"}`,
    "",
    g.tools.length === 0 ? "granted tools: none" : "granted tools (run by keryx outside the sandbox with your credentials):",
  ];
  for (const id of g.tools) {
    const program = grantedToolSpec(id)?.program;
    const bin = program === undefined ? undefined : g.bins[program];
    lines.push(`  - ${id}: ${bin ?? "(unresolved)"}`);
  }
  // L4: what each program is pinned to — checked again before every run and every exec.
  const programs = Object.keys(g.bins);
  if (programs.length > 0) lines.push("", "pinned programs (a changed file refuses the run):");
  for (const program of programs) {
    const pin = g.binDigests[program];
    if (pin === undefined) {
      lines.push(`  ${program}: NOT pinned — the run refuses; recreate the schedule`);
      continue;
    }
    lines.push(`  ${program}: pinned ${pin.realpath}  sha256 ${pin.sha256.slice(0, 12)}`);
    if (pin.interpreter !== undefined) {
      lines.push(`    script wrapper — interpreter ${pin.interpreter.command} → ${pin.interpreter.realpath}  sha256 ${pin.interpreter.sha256.slice(0, 12)}, pinned`);
    }
  }
  return lines.map(cardSafe);
}

/** Runs tab. */
export function runsLines(item: TriggerEntryView): string[] {
  const outcomes = item.records.filter((r) => r.outcome !== "reserved");
  const lines = [`Runs (${Math.min(RUNS_SHOWN, outcomes.length)} shown, newest first)`];
  if (outcomes.length === 0) lines.push("  never ran — no record yet");
  for (const record of outcomes.slice(0, RUNS_SHOWN)) lines.push(`  ${recordLine(record)}`);
  return lines;
}

/**
 * The report the Report tab shows: the newest record's, else the newest file on disk.
 * M2: a record's path counts only when it is exactly where keryx writes that run's report.
 */
export function reportPathOf(cwd: string, item: TriggerEntryView): string | undefined {
  const fromRecord = item.records.find((r) => {
    const task = r.agentTask;
    return task?.reportPath !== undefined && task.reportPath === expectedReportRelPath(item.entry.name, task.runId);
  })?.agentTask?.reportPath;
  return fromRecord ?? latestReportPath(cwd, item.entry.name);
}

/** M2: the Report tab's text — read bounded, a regular file only, control characters stripped. */
export async function reportText(cwd: string, item: TriggerEntryView): Promise<string> {
  const reportPath = reportPathOf(cwd, item);
  if (reportPath === undefined) return "";
  const read = await readScheduleReport(cwd, item.entry.name, reportPath);
  if (!read.ok) return cardSafe(`(${read.reason})`);
  const lines = read.text.split(/\r?\n/).map(cardSafe);
  if (read.truncated) lines.push("", "(report truncated at the read cap)");
  return lines.join("\n");
}

export interface SchedulesModalOptions {
  cwd: string;
  runNow: TriggerRunNow;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  actions?: ScheduleActions;
  load?: (cwd: string) => Promise<TriggerLedgerView>;
  /** The Overview's timer facts (M4) and verification (L1). Default: `defaultDescribeInstall(host)`. */
  describeInstall?: (cwd: string, item: TriggerEntryView) => Promise<InstallDescription>;
  /** The scheduler host for the default `describeInstall`. */
  host?: ScheduleHost;
  /** M3a: the process environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
  /** After an action or a finished run-now (the sidebar refreshes). */
  onChanged?: () => void;
  onRunFinished?: (name: string, exitCode: number) => void;
}

export interface ScheduleDetailHandle extends ModalHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  status(): string;
  visibleLines(): readonly string[];
  /** Settles when the last action (or run-now) has been applied and repainted. */
  settled(): Promise<void>;
}

export interface SchedulesListHandle extends ModalHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  visibleLines(): readonly string[];
  selectedName(): string | undefined;
}

function bodyRowsFor(chrome: unknown, options: Pick<SchedulesModalOptions, "renderer" | "visibleRows">): number {
  const hint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const rows = typeof hint?.width === "number" && typeof hint.height === "number" ? modalBodyRows(resolveModalPanelSize(hint.width, hint.height).height) : 13;
  return Math.max(1, (options.visibleRows ?? rows) - 2);
}

/**
 * The Overview's timer facts. Cheap: files (or the crontab) and `loginctl show-user`, never a
 * scheduler query. The backend probe is cached per process (`detectBackend`), so a reload
 * does not spawn `systemctl` again.
 */
export function defaultDescribeInstall(host: ScheduleHost = {}): (cwd: string, item: TriggerEntryView) => Promise<InstallDescription> {
  return async (cwd, item) => {
    if (!isLocal(item)) {
      return { installed: "n/a (declared in triggers.json — see `keryx trigger schedule`)", unit: "—", linger: "n/a", verified: "n/a (not a local schedule)" };
    }
    const { entry } = item;
    const cron = entry.fire.kind === "schedule" ? entry.fire.cron : "";
    const plan = await planInstall(cwd, entry.name, cron, host, entry.install);
    const installed = await isScheduleInstalled(cwd, entry.name, cron, host, entry.install).catch(() => false);
    const linger = plan.backend === "systemd" ? await lingerStatus(host) : "n/a";
    const verification = await scheduleVerification(cwd, entry.name);
    return {
      installed: installed ? `yes (${plan.backend}: keryx-managed timer present)` : `NO — the timer files are missing (${plan.backend}); remove and add the schedule again`,
      unit: plan.unit,
      linger,
      verified: verification.ok ? "yes — signature and binary pins match what you confirmed" : `NO — ${verification.reason}`,
    };
  };
}

/** The detail modal for one schedule. */
export function openScheduleDetail(otui: unknown, chrome: unknown, name: string, options: SchedulesModalOptions): ScheduleDetailHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const load = options.load ?? loadTriggerLedgerView;
  const actions = options.actions ?? defaultScheduleActions();
  const describeInstall = options.describeInstall ?? defaultDescribeInstall(options.host);
  const now = options.now ?? (() => new Date());
  const bodyRows = bodyRowsFor(chrome, options);

  let item: TriggerEntryView | undefined;
  let install: InstallDescription | undefined;
  let report = "";
  let scroll = 0;
  let width: number | undefined;
  let armed: "run" | "delete" | undefined;
  let statusText = "";
  let pending: Promise<void> = Promise.resolve();
  let statusNode: { content: unknown } | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const tabLines = (): string[] => {
    const tab = host.handle?.activeTab() ?? "overview";
    if (item === undefined) return [DETAIL_KEYS, "", statusText.length > 0 ? statusText : `Reading ${name}…`];
    const body =
      tab === "grants"
        ? grantsLines(item)
        : tab === "runs"
          ? runsLines(item)
          : tab === "report"
            ? report.length > 0
              ? report.split("\n")
              : ["No report yet — the first run writes one."]
            : overviewLines(item, now(), install);
    return [DETAIL_KEYS, "", ...wrapLines(body.join("\n"), width).split("\n")];
  };
  const visible = (): string[] => windowLines(tabLines(), scroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    scroll = clampScroll(scroll, tabLines().length, bodyRows);
    if (statusNode !== undefined) statusNode.content = core.t`${roleChunk(core, armed !== undefined ? "attention" : "muted", statusText)}`;
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };

  const reload = async (): Promise<void> => {
    let view: TriggerLedgerView;
    try {
      view = await load(options.cwd);
    } catch (error) {
      statusText = `could not read the schedules: ${error instanceof Error ? error.message : String(error)}`;
      paint();
      return;
    }
    item = scheduledEntries(view).find((e) => e.entry.name === name);
    if (item === undefined) {
      report = "";
      statusText = statusText.length > 0 ? statusText : `no schedule named "${name}"`;
      paint();
      return;
    }
    install = await describeInstall(options.cwd, item).catch((error: unknown) => ({
      installed: `unknown (${error instanceof Error ? error.message : String(error)})`,
      unit: "unknown",
      linger: "unknown" as const,
      verified: "unknown",
    }));
    report = await reportText(options.cwd, item);
    paint();
  };

  const act = (work: () => Promise<string>): void => {
    pending = pending.then(async () => {
      try {
        statusText = await work();
      } catch (error) {
        statusText = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      await reload();
      options.onChanged?.();
    });
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: `${SCHEDULES_COMMAND} · ${name}`,
    tabs: DETAIL_TABS,
    initialTab: "overview",
    footer: [
      { key: "p", label: "pause/resume" },
      { key: "r", label: "run" },
      { key: "d", label: "delete" },
      { key: "←/→", label: "tabs" },
      { key: "esc", label: "close" },
    ],
    renderTab: (_tab, body, ctx) => {
      width = ctx.width;
      scroll = 0;
      const parent = body as { add(child: unknown): void };
      statusNode = new core.TextRenderable(r as never, { id: "sch-status", content: "" }) as never;
      bodyNode = new core.TextRenderable(r as never, { id: "sch-body", content: "", marginTop: 1 }) as never;
      parent.add(statusNode);
      parent.add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  host.handle = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint("schedules-modal", paint, () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true),
  );

  keys.off = options.onKeypress((key) => {
    if (closed) return;
    if (options.inputBlocked?.() === true) {
      // L3: another overlay took the keyboard. An armed action is dropped, so a `y`
      // typed for that overlay can never confirm it.
      if (armed !== undefined) {
        statusText = `${armed === "run" ? "run-now" : "delete"} of ${name} cancelled (another prompt took the keyboard)`;
        armed = undefined;
        paint();
      }
      return;
    }
    const token = key.name || key.sequence;
    if (armed !== undefined) {
      const what = armed;
      armed = undefined;
      if (token !== "y") {
        statusText = `${what === "run" ? "run-now" : "delete"} of ${name} cancelled`;
        paint();
        return;
      }
      // L3: the schedule may have vanished (another process removed it) while armed.
      const current = item;
      if (current === undefined) {
        statusText = `no schedule named "${name}" any more — nothing was ${what === "run" ? "run" : "deleted"}`;
        paint();
        return;
      }
      if (what === "delete") {
        act(async () => {
          const result = await actions.remove(options.cwd, name);
          return `deleted ${name}${result.skipped.length > 0 ? ` — left untouched (not keryx's): ${result.skipped.join(", ")}` : ""}`;
        });
        return;
      }
      const run = options.runNow.run(name, isLocal(current) ? { schedule: true } : {});
      if (run === undefined) {
        statusText = `${name} is already running from this shell`;
        paint();
        return;
      }
      statusText = `running ${name}… (keryx trigger run${isLocal(current) ? " --schedule" : ""} ${name})`;
      paint();
      pending = pending.then(async () => {
        const result = await run;
        statusText = result.refusal !== undefined ? `cannot run: ${result.refusal}` : `${name}: run-now exited ${result.exitCode}`;
        await reload();
        options.onChanged?.();
        options.onRunFinished?.(name, result.exitCode);
      });
      return;
    }
    if (token === "p" || token === "r" || token === "d") {
      const nested = nestedAgentScheduleRefusal(options.env);
      if (nested !== undefined) {
        statusText = nested;
      } else if (item === undefined) {
        statusText = `no schedule named "${name}"`;
      } else if (token !== "r" && !isLocal(item)) {
        statusText = `${name} is declared in triggers.json — edit that file; only local schedules are paused or deleted here`;
      } else if (token === "p") {
        const current = item;
        act(async () => {
          if (current.entry.enabled) {
            await actions.pause(options.cwd, name);
            return `paused ${name} — timer disabled; a fire while paused records no-op`;
          }
          await actions.resume(options.cwd, name);
          return `resumed ${name} — timer enabled`;
        });
        return;
      } else if (token === "r") {
        if (!item.entry.enabled) {
          statusText = `${name} is paused — resume it (p) before running it`;
        } else if (options.runNow.running().has(name)) {
          statusText = `${name} is already running from this shell`;
        } else {
          armed = "run";
          const task = agentTask(item);
          statusText = `run ${name} now (keryx trigger run --schedule ${name})?${task !== undefined ? ` spends up to $${task.dispatch.ceilingUsd}, network ${task.grants.network}` : ""} · y to confirm · any other key cancels`;
        }
      } else {
        armed = "delete";
        statusText = `delete ${name}: uninstall its timer and remove it? · y to confirm · any other key cancels`;
      }
      paint();
      return;
    }
    if (token === "up" || token === "k") scroll = clampScroll(scroll - 1, tabLines().length, bodyRows);
    else if (token === "down" || token === "j") scroll = clampScroll(scroll + 1, tabLines().length, bodyRows);
    else if (token === "pageup" || token === "pagedown") scroll = clampScroll(scroll + (token === "pageup" ? -bodyRows : bodyRows), tabLines().length, bodyRows);
    else return;
    paint();
  });

  const ready = reload();
  return { ...handle, ready, reload, status: () => statusText, visibleLines: visible, settled: () => pending };
}

/** `/schedules`: the list. Enter opens the selected schedule's detail (replacing this modal). */
export function openSchedulesList(
  otui: unknown,
  chrome: unknown,
  options: SchedulesModalOptions & { onOpenDetail: (name: string) => void },
): SchedulesListHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const load = options.load ?? loadTriggerLedgerView;
  const now = options.now ?? (() => new Date());
  const bodyRows = bodyRowsFor(chrome, options);
  let entries: readonly TriggerEntryView[] = [];
  let loaded = false;
  let error: string | undefined;
  let selected = 0;
  // L4: the selection follows the schedule's NAME across reloads, not its row index.
  let selectedKey: string | undefined;
  let scroll = 0;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};

  const lines = (): string[] => {
    const out = [LIST_KEYS, ""];
    if (error !== undefined) return [...out, `could not read the schedules: ${error}`];
    if (!loaded) return [...out, "Reading schedules…"];
    if (entries.length === 0) return [...out, "No schedules. Create one with /schedule, or ask: \"schedule a task every 4 hours to …\"."];
    entries.forEach((item, i) => {
      const cron = item.entry.fire.kind === "schedule" ? item.entry.fire.cron : "";
      out.push(
        `${i === selected ? ">" : " "} ${item.entry.name}  [${item.entry.enabled ? "active" : "paused"}]  next ${item.entry.enabled ? formatNextRun(cron, now()) : "—"}  last ${formatLastOutcome(latestOutcome(item), now())}`,
      );
    });
    return out;
  };
  const visible = (): string[] => windowLines(lines(), scroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    scroll = clampScroll(scrollToReveal(selected + 2, scroll, bodyRows), lines().length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };
  const reload = async (): Promise<void> => {
    try {
      entries = scheduledEntries(await load(options.cwd));
      error = undefined;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    loaded = true;
    const byName = selectedKey === undefined ? -1 : entries.findIndex((e) => e.entry.name === selectedKey);
    selected = byName >= 0 ? byName : Math.min(selected, Math.max(0, entries.length - 1));
    selectedKey = entries[selected]?.entry.name;
    paint();
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: SCHEDULES_COMMAND,
    tabs: [{ id: "list", label: "Schedules" }],
    footer: [
      { key: "↑/↓", label: "select" },
      { key: "enter", label: "open" },
      { key: "esc", label: "close" },
    ],
    renderTab: (_tab, body) => {
      bodyNode = new core.TextRenderable(r as never, { id: "sch-list", content: "" }) as never;
      (body as { add(child: unknown): void }).add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  unsubscribeTheme = onThemeChange(guardedThemeRepaint("schedules-list", paint, () => closed || isRenderableGone(bodyNode)));
  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (token === "up" || token === "k") {
      selected = Math.max(0, selected - 1);
      selectedKey = entries[selected]?.entry.name;
    } else if (token === "down" || token === "j") {
      selected = Math.min(Math.max(0, entries.length - 1), selected + 1);
      selectedKey = entries[selected]?.entry.name;
    } else if (token === "return" || token === "enter") {
      const chosen = entries[selected];
      if (chosen !== undefined) options.onOpenDetail(chosen.entry.name);
      return;
    } else return;
    paint();
  });
  const ready = reload();
  return {
    ...handle,
    ready,
    reload,
    visibleLines: visible,
    selectedName: () => entries[selected]?.entry.name,
  };
}
