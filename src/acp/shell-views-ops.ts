// The operations-shaped view commands of `keryx acp --profile shell` (T10b): `/governance`,
// `/triggers`, `/schedules`, `/schedule`, `/autoreview` and `/task`.
//
// The TUI mounts these as sidebar sections plus modals; here each is one view over the same
// loaders (`loadTriggerLedgerView`, `readLatestGovernanceReport`, `readAutoReviewRuns`), and
// each modal key is a command line (`/schedules pause|resume|run|delete`, `/triggers run`,
// `/governance check|close|run`). Run-now and delete carry a `confirm`.
//
// Two things ACP's host cannot do, and so answer refused with the reason: `/autoreview
// start|stop` (they spawn and signal a detached review process, and keryx acp has no
// supervisor to own it) and a `/task` when this checkout has no Hub connection.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readLatestGovernanceReport, governanceDataRoot } from "../governance/service";
import { flowEntriesFrom } from "../tui/governance-flows";
import { renderEffectLine, renderSummaryLine } from "../governance/service";
import { eventEntries, loadTriggerLedgerView, scheduledEntries, type TriggerEntryView } from "../tui/trigger-ledger";
import { formatTriggerDetailLines, type TriggerModalItem } from "../tui/triggers-inspector";
import { defaultDescribeInstall, grantsLines, overviewLines, reportText, runsLines } from "../tui/schedules-inspector";
import { formatLastOutcome, formatNextRun, latestOutcome } from "../tui/schedules-panel";
import { runScheduleSlashCommand } from "../tui/schedule-command";
import { scheduleFormView, toShellScheduleLine } from "./schedule-form";
import { autoReviewListText, readAutoReviewArbiter, readAutoReviewRuns, parseAutoReviewArgs } from "../tui/autoreview-surface";
import {
  describeFire,
  QUICK_MODES,
  governanceCheck,
  governanceClose,
  governanceRun,
  scheduleDelete,
  schedulePause,
  scheduleResume,
  taskSubmit,
  TASK_USAGE,
  triggerRunNow,
} from "../commands/shell-subcommands";
import type { ShellCommandHost, ShellCommandOutcome } from "./shell-command-runners";
import { action, viewRow, type ShellView, type ShellViewAction } from "./shell-views";
import { actionOutcome, refusal, viewOutcome } from "./shell-views-outcome";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const parts = (args: string): string[] => args.trim().split(/\s+/).filter((word) => word.length > 0);

// ---------------------------------------------------------------------------
// /governance
// ---------------------------------------------------------------------------

async function governanceView(host: ShellCommandHost): Promise<ShellView> {
  const read = await readLatestGovernanceReport(host.cwd).catch((error: unknown) => ({ state: "malformed" as const, reason: errorText(error) }));
  const rerun = viewRow("report", "Governance report", {
    status: read.state === "present" ? "stored" : read.state,
    detail: read.state === "malformed" ? read.reason : "Rebuilt in this process from recorded artifacts: no model, no network.",
    actions: [action(read.state === "present" ? "Re-run" : "Run", "/governance run")],
  });
  if (read.state !== "present") {
    return { title: "Governance", rows: [rerun], body: read.state === "absent" ? "No governance report yet." : `The stored report is unreadable: ${read.reason}` };
  }
  const entries = flowEntriesFrom(read.report, host.cwd);
  const rows = entries.flows.map((flow) =>
    viewRow(flow.id, `${flow.id} ${flow.title}`, {
      status: flow.status,
      detail: `${renderSummaryLine(flow.summary)}\n${renderEffectLine(flow.effect)}`,
      actions:
        flow.status === "done"
          ? []
          : [
              action("Check", `/governance check ${flow.id}`),
              action("Complete", `/governance close ${flow.id}`, `Complete flow ${flow.id}? This runs \`keryx flow complete\` and marks the flow done if every gate passes.`),
            ],
    }),
  );
  const markdown = await readFile(path.join(governanceDataRoot(host.cwd), "artifacts", "latest.md"), "utf8").catch(() => undefined);
  return { title: "Governance", rows: [rerun, ...rows], body: [entries.note, markdown].filter((part) => part !== undefined && part.length > 0).join("\n\n") };
}

export async function runGovernance(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = parts(args);
  if (sub === undefined) return viewOutcome(await governanceView(host));
  if (sub === "run") return actionOutcome(await governanceRun(host.cwd), []);
  if (sub === "check") return actionOutcome(await governanceCheck(host.cwd, rest.join(" ")), []);
  if (sub === "close") return actionOutcome(await governanceClose(host.cwd, rest.join(" ")), []);
  return refusal(`Unknown /governance argument '${sub}'. Usage: /governance [run | check <flow id> | close <flow id>]`);
}

// ---------------------------------------------------------------------------
// /triggers
// ---------------------------------------------------------------------------

function triggerRunConfirm(item: TriggerEntryView): string {
  const { action: act } = item.entry;
  const dispatch = act.kind === "flow-next" ? act.dispatch : act.kind === "agent-task" ? act.dispatch : undefined;
  const posture = dispatch === undefined ? "" : ` It dispatches ${dispatch.provider}/${dispatch.model} with a $${dispatch.ceilingUsd} ceiling.`;
  return `Run ${item.entry.name} now (keryx trigger run ${item.entry.name})?${posture}`;
}

async function triggersView(host: ShellCommandHost): Promise<ShellView> {
  const view = await loadTriggerLedgerView(host.cwd);
  const now = new Date();
  const rows = [
    ...eventEntries(view).map((item) => {
      const latest = item.latest;
      return viewRow(item.entry.name, item.entry.name, {
        status: item.entry.enabled ? "enabled" : "disabled",
        detail: `${describeFire(item.entry.fire)}\n${latest === undefined ? "never fired" : formatLastOutcome(latest, now)}`,
        actions: item.entry.enabled ? [action("Run now", `/triggers run ${item.entry.name}`, triggerRunConfirm(item))] : [],
      });
    }),
    ...view.rejected.map((rejected, index) =>
      viewRow(`rejected-${index}`, rejected.name ?? `entry #${rejected.index}`, { status: "rejected", detail: rejected.reasons.join("\n") }),
    ),
  ];
  const scheduled = scheduledEntries(view).length;
  return {
    title: "Triggers",
    rows,
    body: [
      `${view.openReservations.length} open spend reservation(s)`,
      rows.length === 0 ? "No event-fired triggers." : "",
      scheduled > 0 ? `${scheduled} scheduled trigger(s): see /schedules.` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  };
}

async function triggerDetailView(host: ShellCommandHost, name: string): Promise<ShellView | undefined> {
  const view = await loadTriggerLedgerView(host.cwd);
  const found = view.entries.find((item) => item.entry.name === name);
  if (found === undefined) return undefined;
  const modalItem: TriggerModalItem = { kind: "entry", view: found, hook: "see keryx trigger list" };
  return {
    title: `Trigger ${name}`,
    body: formatTriggerDetailLines(modalItem, view, undefined).join("\n"),
    rows: [
      viewRow(name, name, {
        status: found.entry.enabled ? "enabled" : "disabled",
        actions: found.entry.enabled ? [action("Run now", `/triggers run ${name}`, triggerRunConfirm(found))] : [],
      }),
    ],
  };
}

export async function runTriggers(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = parts(args);
  if (sub === undefined) return viewOutcome(await triggersView(host));
  if (sub === "run") return actionOutcome(await triggerRunNow(host.cwd, rest.join(" ")), []);
  const detail = await triggerDetailView(host, sub);
  return detail === undefined ? refusal(`No trigger named '${sub}'. Usage: /triggers [<name> | run <name>]`) : viewOutcome(detail);
}

// ---------------------------------------------------------------------------
// /schedules
// ---------------------------------------------------------------------------

const isLocalSchedule = (item: TriggerEntryView): boolean => item.entry.source === "store" && item.entry.action.kind === "agent-task";

export function scheduleActions(item: TriggerEntryView): ShellViewAction[] {
  const name = item.entry.name;
  const { action: act } = item.entry;
  const ceiling = act.kind === "agent-task" ? ` Each run may spend up to $${act.dispatch.ceilingUsd}.` : "";
  const run = action("Run now", `/schedules run ${name}`, `Run ${name} now (keryx trigger run --schedule ${name})?${ceiling}`);
  if (!item.entry.enabled && !isLocalSchedule(item)) return [];
  if (!isLocalSchedule(item)) return [run];
  return [
    item.entry.enabled ? action("Pause", `/schedules pause ${name}`) : action("Resume", `/schedules resume ${name}`),
    ...(item.entry.enabled ? [run] : []),
    action("Delete", `/schedules delete ${name}`, `Delete schedule ${name}? This uninstalls its timer and removes the entry.`),
  ];
}

async function schedulesView(host: ShellCommandHost): Promise<ShellView> {
  const view = await loadTriggerLedgerView(host.cwd);
  const now = new Date();
  const rows = scheduledEntries(view).map((item) => {
    const cron = item.entry.fire.kind === "schedule" ? item.entry.fire.cron : "";
    const next = item.entry.enabled && cron.length > 0 ? formatNextRun(cron, now) : "paused";
    return viewRow(item.entry.name, item.entry.name, {
      status: item.entry.enabled ? "active" : "paused",
      detail: `${isLocalSchedule(item) ? "local schedule" : "declared in triggers.json (read-only)"} · ${describeFire(item.entry.fire)}\nnext ${next} · last ${formatLastOutcome(latestOutcome(item), now)}`,
      actions: scheduleActions(item),
    });
  });
  return {
    title: "Schedules",
    rows,
    body: rows.length === 0 ? "No schedules yet. Create one with /schedule." : "Open one with /schedules <name> for its grants, runs and latest report.",
  };
}

async function scheduleDetailView(host: ShellCommandHost, name: string): Promise<ShellView | undefined> {
  const view = await loadTriggerLedgerView(host.cwd);
  const item = scheduledEntries(view).find((candidate) => candidate.entry.name === name);
  if (item === undefined) return undefined;
  const install = await defaultDescribeInstall()(host.cwd, item).catch(() => undefined);
  const next = item.entry.fire.kind === "schedule" && item.entry.enabled ? formatNextRun(item.entry.fire.cron, new Date()) : undefined;
  const report = await reportText(host.cwd, item).catch(() => "");
  return {
    title: `Schedule ${name}`,
    rows: [viewRow(name, name, { status: item.entry.enabled ? "active" : "paused", ...(next !== undefined ? { detail: `next run ${next}` } : {}), actions: scheduleActions(item) })],
    body: [overviewLines(item, new Date(), install).join("\n"), grantsLines(item).join("\n"), runsLines(item).join("\n"), report.length > 0 ? `Latest report\n${report}` : ""]
      .filter((block) => block.length > 0)
      .join("\n\n"),
  };
}

export async function runSchedules(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = parts(args);
  const name = rest.join(" ");
  if (sub === undefined) return viewOutcome(await schedulesView(host));
  if (sub === "pause") return actionOutcome(await schedulePause(host.cwd, name), []);
  if (sub === "resume") return actionOutcome(await scheduleResume(host.cwd, name), []);
  if (sub === "delete") return actionOutcome(await scheduleDelete(host.cwd, name), []);
  if (sub === "run") return actionOutcome(await triggerRunNow(host.cwd, name, { schedule: true }), []);
  const detail = await scheduleDetailView(host, sub);
  return detail === undefined ? refusal(`No schedule named '${sub}'. Usage: /schedules [<name> | pause|resume|run|delete <name>]`) : viewOutcome(detail);
}

// ---------------------------------------------------------------------------
// /schedule: the draft card is the confirmation
// ---------------------------------------------------------------------------

/**
 * `/schedule <flags> -- <prompt>` drafts the schedule and answers a view whose one action
 * creates it, carrying the card as its `confirm`. `/schedule confirmed <same arguments>`
 * stores it and installs the timer. Nothing is written by the draft.
 */
export async function runSchedule(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const trimmed = args.trim();
  const confirmed = /^confirmed(\s|$)/.test(trimmed);
  const raw = confirmed ? trimmed.replace(/^confirmed\s*/, "") : trimmed;
  if (raw.length === 0) return viewOutcome(await scheduleFormView(host));
  const shellLine = toShellScheduleLine(raw);
  if ("error" in shellLine) return refusal(`/schedule: ${shellLine.error}`);
  const lines: string[] = [];
  let card: readonly string[] | undefined;
  const { providerId, modelId } = host.session.modelIds();
  try {
    const created = await runScheduleSlashCommand(shellLine.line, {
      ...host.scheduleOverrides,
      cwd: host.cwd,
      defaults: () => ({ provider: providerId, model: modelId }),
      print: (line) => lines.push(line),
      confirm: async (shown) => {
        card = shown;
        return confirmed;
      },
    });
    if (confirmed) {
      const text = `${lines.join("\n")}\n`;
      return created ? { text, effects: ["config"] } : refusal(text);
    }
  } catch (error) {
    return refusal(`/schedule: ${errorText(error)}`);
  }
  if (card === undefined) return refusal(`${lines.join("\n")}\n`);
  const command = `/schedule confirmed ${shellLine.line}`;
  const confirm = card.join("\n");
  // The card is the question: a client that cannot ask reads the text and runs `command` itself.
  return { text: `${confirm}\n\nNothing is created yet. To create it, run:\n${command}\n`, confirmAction: { label: "Confirm", confirm, command } };
}

// ---------------------------------------------------------------------------
// /autoreview
// ---------------------------------------------------------------------------

const NO_AUTOREVIEW_PROCESS =
  "keryx acp does not start or stop autonomous reviews: they run as a detached keryx process that nothing in this session would own. " +
  "Use keryx shell (/autoreview start), or keryx review run --autonomous from a terminal.";

async function autoReviewView(host: ShellCommandHost): Promise<ShellView> {
  const runs = readAutoReviewRuns(host.cwd);
  return {
    title: "Autonomous reviews",
    body: runs.length === 0 ? "No autonomous reviews yet. Start one with keryx shell: /autoreview start <pull request URL>" : autoReviewListText(runs),
    rows: runs.map((run) =>
      viewRow(run.slug, run.label, {
        status: run.state,
        detail: `${run.phase} · round ${run.rounds} · ${run.tokens} tokens${run.pid !== undefined ? ` · pid ${run.pid}` : ""}${run.reason !== undefined && !run.live ? `\n${run.reason}` : ""}`,
        actions: [action("Arbiter log", `/autoreview arbiter ${run.slug}`)],
      }),
    ),
  };
}

export async function runAutoReview(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const command = parseAutoReviewArgs(`/autoreview ${args}`);
  if (command.kind === "error") return refusal(`/autoreview: ${command.message}`);
  if (command.kind === "list") return viewOutcome(await autoReviewView(host));
  if (command.kind === "arbiter") return { text: readAutoReviewArbiter(host.cwd, command.selector).text };
  return refusal(NO_AUTOREVIEW_PROCESS);
}

// ---------------------------------------------------------------------------
// /task
// ---------------------------------------------------------------------------

function taskView(): ShellView {
  return {
    title: "Start a task",
    body: "Starts a flow on the Team Hub this checkout is connected to (keryx hub connect; the token comes from its environment variable).",
    rows: QUICK_MODES.map((mode) => viewRow(mode.id, mode.label, { detail: `review depth ${mode.reviewDepth}\n${mode.criteriaTemplate.join("\n")}` })),
    form: {
      fields: [
        { id: "mode", label: "Mode", kind: "choice", required: true, options: QUICK_MODES.map((mode) => mode.id) },
        { id: "description", label: "What needs doing", kind: "text", required: true, placeholder: "e.g. Make the build green" },
        { id: "criteria", label: "Your own criteria, separated by ;", kind: "text", placeholder: "optional · e.g. tests pass; no new lint errors" },
      ],
      submit: "/task {mode} {description} || {criteria}",
    },
  };
}

export async function runTask(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  if (args.trim().length === 0) return viewOutcome(taskView());
  const result = await taskSubmit(host.cwd, args);
  return result.ok ? { text: result.text } : refusal(result.text.length > 0 ? result.text : TASK_USAGE);
}
