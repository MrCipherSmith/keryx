// Flow 300 T7 (AC5, AC6): the `/triggers` modal — list + detail, and run-now.
//
// List: every EVENT-fired entry (schedule-fired ones belong to flow 295's
// Schedules section) and every rejected entry, so a broken one can be selected
// and its reasons read. Detail: the entry exactly as `keryx trigger list/status`
// describes it (`../trigger/describe.ts` — shared, not copied), the dispatch
// posture of a dispatching `flow-next`, its last ledger records, and every open
// reservation with the exact `keryx trigger resolve` command.
//
// Run-now: `r` arms it on the selected trigger, `y` confirms, ANY other key
// cancels. A disabled or rejected entry cannot be armed; the status line says
// why. A confirmed run is `keryx trigger run <name>` in a child process of this
// same build (`./trigger-run-now.ts`) — the modal shows `running…`, then the
// new ledger record and the tail of the child's output.

import {
  describeAction,
  describeCost,
  describeEntry,
  describeFire,
  describeHookInstalled,
  describeOpenReservation,
  entryDispatch,
  NETWORK_ON_WARNING,
  UNATTENDED_ROSTER_DESCRIPTION,
} from "../trigger/describe";
import type { RejectedTriggerEntry } from "../trigger/config";
import type { TriggerRunRecord } from "../trigger/record";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { formatAge, formatTriggerSpend } from "./triggers-panel";
import { eventEntries, loadTriggerLedgerView, scheduledEntries, type TriggerEntryView, type TriggerLedgerView } from "./trigger-ledger";
import type { TriggerRunNow, TriggerRunNowResult } from "./trigger-run-now";

type OpenTui = typeof import("@opentui/core");

export const TRIGGERS_COMMAND = "/triggers";

export const TRIGGERS_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "open" },
  { key: "[/]", label: "next" },
  { key: "r", label: "run" },
  { key: "y", label: "confirm" },
  { key: "esc", label: "close" },
] as const;

/** How many ledger records the detail tab lists. */
export const DETAIL_RECORDS = 8;

export type TriggerModalItem =
  | { readonly kind: "entry"; readonly view: TriggerEntryView; readonly hook: string }
  | { readonly kind: "rejected"; readonly rejected: RejectedTriggerEntry };

export interface LastRunNow {
  readonly result: TriggerRunNowResult;
  /** The ledger record the run wrote, when one appeared. */
  readonly record: TriggerRunRecord | undefined;
}

function itemName(item: TriggerModalItem): string {
  return item.kind === "entry" ? item.view.entry.name : (item.rejected.name ?? `(entry #${item.rejected.index})`);
}

/** Why `item` cannot be armed, or `undefined` when it can. */
export function runNowRefusal(item: TriggerModalItem | undefined, running: ReadonlySet<string>): string | undefined {
  if (item === undefined) return "no trigger selected";
  if (item.kind === "rejected") {
    return `${itemName(item)} is malformed and cannot run: ${item.rejected.reasons.join("; ")} — fix .metaproject/triggers.json`;
  }
  const { entry } = item.view;
  if (!entry.enabled) {
    return `${entry.name} is disabled — \`keryx trigger run\` would do nothing but record a no-op; enable it in .metaproject/triggers.json`;
  }
  if (running.has(entry.name)) return `${entry.name} is already running from this shell`;
  return undefined;
}

export function describeRecordLines(record: TriggerRunRecord): string[] {
  const lines = [`${record.at}  ${record.outcome} — ${record.detail}  [${describeCost(record.cost)}]`];
  const d = record.dispatch;
  if (d?.refusal !== undefined) lines.push(`    refusal: ${d.refusal}`);
  if (d?.denials !== undefined && d.denials.length > 0) {
    lines.push(`    denials: ${d.denials.map((x) => `${x.tool}: ${x.reason}`).join("; ")}`);
  }
  return lines;
}

/** The detail tab, as lines (unwrapped). Exported so AC5's test can hold it against the CLI. */
export function formatTriggerDetailLines(
  item: TriggerModalItem,
  view: TriggerLedgerView,
  last: LastRunNow | undefined,
): string[] {
  if (item.kind === "rejected") {
    return [
      `${itemName(item)}  [REJECTED]`,
      "",
      "This entry could not be loaded, so it cannot run:",
      ...item.rejected.reasons.map((reason) => `  - ${reason}`),
    ];
  }
  const { entry, records, runCount } = item.view;
  const lines = [describeEntry(entry), "", `fire     ${describeFire(entry.fire)}`, `action   ${describeAction(entry.action)}`, `hook     ${item.hook}`];
  const d = entryDispatch(entry);
  if (d !== undefined) {
    lines.push(
      "",
      "Unattended dispatch",
      `  provider/model   ${d.provider}/${d.model}`,
      `  permission mode  ${d.permissionMode}`,
      `  ceiling          $${d.ceilingUsd}`,
      `  max seconds      ${d.maxSeconds}`,
      `  max attempts     ${d.maxAttempts}`,
      `  roster           ${UNATTENDED_ROSTER_DESCRIPTION}`,
      `  network          ${d.network ? `NETWORK ON — ${NETWORK_ON_WARNING}` : "off"}`,
    );
  }
  lines.push("", `Runs (${Math.min(DETAIL_RECORDS, records.length)} of ${runCount}, newest first)`);
  if (records.length === 0) lines.push("  never fired — no record yet");
  for (const record of records.slice(0, DETAIL_RECORDS)) lines.push(...describeRecordLines(record).map((l) => `  ${l}`));
  const open = view.openReservations.filter((r) => r.trigger === entry.name);
  if (open.length > 0) {
    lines.push("", "Open spend reservations");
    for (const reservation of open) lines.push(`  ${describeOpenReservation(reservation)}`);
  }
  if (last !== undefined) {
    lines.push("", `Last run-now (exit ${last.result.exitCode}) — ${last.result.argv.slice(2).join(" ")}`);
    lines.push(last.record === undefined ? "  no new ledger record" : `  ${describeRecordLines(last.record).join("\n  ")}`);
    const tail = last.result.output.trimEnd();
    if (tail.length > 0) lines.push("  output:", ...tail.split("\n").slice(-12).map((l) => `    ${l}`));
  }
  return lines;
}

export function formatTriggerListLines(items: readonly TriggerModalItem[], view: TriggerLedgerView, selected: number, now: Date): string[] {
  const lines: string[] = [];
  const spend = formatTriggerSpend(view.spend);
  lines.push(`${spend.text} · ${view.openReservations.length} open reservation${view.openReservations.length === 1 ? "" : "s"}`);
  if (items.length === 0) lines.push("  No event-fired triggers.");
  items.forEach((item, index) => {
    const mark = index === selected ? ">" : " ";
    if (item.kind === "rejected") {
      lines.push(`${mark} ${itemName(item)}  [REJECTED]`);
      return;
    }
    const { entry, latest } = item.view;
    const net = entryDispatch(entry)?.network === true ? "  NET" : "";
    const last = latest === undefined ? "never fired" : `${latest.outcome} ${formatAge(latest.at, now)} ago`;
    lines.push(`${mark} ${entry.name}  [${entry.enabled ? "enabled" : "disabled"}]  ${describeFire(entry.fire)}  ${last}${net}`);
  });
  const scheduled = scheduledEntries(view).length;
  if (scheduled > 0) lines.push("", `${scheduled} scheduled trigger${scheduled === 1 ? "" : "s"} — shown in the Schedules section`);
  return lines;
}

/** Lines of the status block above the tab body (review F10: two, not one). */
export const STATUS_ROWS = 2;

/**
 * The arm prompt. For a dispatching entry it states what confirming spends
 * and grants — its ceiling, and NETWORK ON when the agent gets the host
 * network (review F10) — so `y` is never pressed on a one-line summary.
 */
export function armPrompt(item: TriggerModalItem): string {
  const name = itemName(item);
  const base = `run ${name} now (keryx trigger run ${name})?`;
  const d = item.kind === "entry" ? entryDispatch(item.view.entry) : undefined;
  const posture = d === undefined ? "" : ` dispatches ${d.provider}/${d.model}, ceiling $${d.ceilingUsd}${d.network ? ", NETWORK ON" : ", network off"} ·`;
  return `${base}${posture} y to confirm · any other key cancels`;
}

export interface TriggersModalOptions {
  cwd: string;
  runNow: TriggerRunNow;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  /** Select this trigger and open its detail tab. */
  initialName?: string;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  load?: (cwd: string) => Promise<TriggerLedgerView>;
  describeHook?: typeof describeHookInstalled;
  now?: () => Date;
  /** Called once per confirmed run when it ends (the shell's toast). */
  onRunFinished?: (last: LastRunNow) => void;
  /** True while a composer choice or permission prompt owns the keyboard (review F11): keys are ignored. */
  inputBlocked?: () => boolean;
}

export interface TriggersModalHandle extends ModalHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  /** Tests: what the status line and the active tab body show. */
  status(): string;
  visibleLines(): readonly string[];
  selectedName(): string | undefined;
  /** Settles when the in-flight run-now (if any) has been recorded and repainted. */
  settled(): Promise<void>;
}

export function openTriggers(otui: unknown, chrome: unknown, options: TriggersModalOptions): TriggersModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const load = options.load ?? loadTriggerLedgerView;
  const describeHook = options.describeHook ?? describeHookInstalled;
  const now = options.now ?? (() => new Date());
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  // The status block (STATUS_ROWS lines) and the blank under it (review F10).
  const bodyRows = Math.max(1, (options.visibleRows ?? panelRows) - STATUS_ROWS - 1);

  let view: TriggerLedgerView | undefined;
  let items: TriggerModalItem[] = [];
  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let width: number | undefined;
  let armed: string | undefined;
  let statusText = "keys: r run now · y confirm · any other key cancels";
  const lastRuns = new Map<string, LastRunNow>();
  let inFlight: Promise<void> = Promise.resolve();
  let statusNode: { content: unknown } | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  // Filled once the modal is open; `onClose` (which can run first) reads it.
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const selectedItem = (): TriggerModalItem | undefined => items[selected];
  const activeTab = (): string => host.handle?.activeTab() ?? "list";
  const listLines = (): string[] => (view === undefined ? ["Reading triggers…"] : formatTriggerListLines(items, view, selected, now()));
  const detailLines = (): string[] => {
    const item = selectedItem();
    if (view === undefined) return ["Reading triggers…"];
    if (item === undefined) return ["No trigger selected."];
    const last = lastRuns.get(itemName(item));
    return wrapLines(formatTriggerDetailLines(item, view, last).join("\n"), width).split("\n");
  };
  const visible = (): string[] =>
    activeTab() === "detail" ? windowLines(detailLines(), detailScroll, bodyRows) : windowLines(listLines(), listScroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    // Row 0 of the list is the spend summary; item i sits on row i + 1.
    listScroll = clampScroll(scrollToReveal(selected + 1, listScroll, bodyRows), listLines().length, bodyRows);
    detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
    const running = options.runNow.running();
    const role = armed !== undefined ? "attention" : running.size > 0 ? "accent" : "muted";
    if (statusNode !== undefined) {
      const status = wrapLines(statusText, width).split("\n").slice(0, STATUS_ROWS).join("\n");
      statusNode.content = core.t`${roleChunk(core, role, status)}`;
    }
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };

  const reload = async (): Promise<void> => {
    let next: TriggerLedgerView;
    try {
      next = await load(options.cwd);
    } catch (error) {
      // Review F12: a read that fails says so; it never leaves a stale list looking current.
      statusText = `could not read the triggers: ${error instanceof Error ? error.message : String(error)}`;
      paint();
      return;
    }
    const entries = eventEntries(next);
    const hooks = await Promise.all(entries.map((e) => describeHook(options.cwd, e.entry).catch(() => "unknown")));
    const previous = selectedItem() === undefined ? undefined : itemName(selectedItem() as TriggerModalItem);
    view = next;
    items = [
      ...entries.map((e, i): TriggerModalItem => ({ kind: "entry", view: e, hook: hooks[i] ?? "unknown" })),
      ...next.rejected.map((rejected): TriggerModalItem => ({ kind: "rejected", rejected })),
    ];
    const keep = previous === undefined ? -1 : items.findIndex((i) => itemName(i) === previous);
    selected = keep >= 0 ? keep : Math.min(selected, Math.max(0, items.length - 1));
    paint();
  };

  const confirm = (name: string): void => {
    const run = options.runNow.run(name);
    if (run === undefined) {
      statusText = `${name} is already running from this shell`;
      paint();
      return;
    }
    statusText = `running ${name}… (keryx trigger run ${name})`;
    paint();
    inFlight = run.then(async (result) => {
      if (result.refusal !== undefined) {
        // Review N1: an unsafe log location — nothing was started.
        statusText = `cannot run: ${result.refusal}`;
        paint();
        return;
      }
      await reload();
      const fresh = view === undefined ? undefined : eventEntries(view).find((e) => e.entry.name === name);
      const record = fresh?.records.find((rec) => rec.at >= result.startedAt);
      const last: LastRunNow = { result, record };
      lastRuns.set(name, last);
      statusText =
        record === undefined
          ? `${name}: exited ${result.exitCode}, no new ledger record — see the output in Detail`
          : `${name}: ${record.outcome} — ${record.detail}`;
      paint();
      options.onRunFinished?.(last);
    });
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: TRIGGERS_COMMAND,
    tabs: [
      { id: "list", label: "Triggers" },
      { id: "detail", label: "Detail" },
    ],
    initialTab: options.initialName !== undefined ? "detail" : "list",
    footer: TRIGGERS_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      statusNode = new core.TextRenderable(r as never, { id: "trg-status", content: "" }) as never;
      bodyNode = new core.TextRenderable(r as never, { id: "trg-body", content: "", marginTop: 1 }) as never;
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
  const modal = handle;
  host.handle = handle;
  // Subscribed only once the modal really opened (review F13).
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint("triggers-modal", paint, () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (armed !== undefined) {
      const name = armed;
      armed = undefined;
      if (token === "y") {
        confirm(name);
      } else {
        statusText = `run-now of ${name} cancelled`;
        paint();
      }
      return;
    }
    const onDetail = modal.activeTab() === "detail";
    const move = (next: number): void => {
      const clamped = Math.min(Math.max(0, items.length - 1), Math.max(0, next));
      if (clamped !== selected) {
        selected = clamped;
        detailScroll = 0;
      }
    };
    if (token === "r") {
      const refusal = runNowRefusal(selectedItem(), options.runNow.running());
      if (refusal !== undefined) {
        statusText = `cannot run: ${refusal}`;
      } else {
        armed = itemName(selectedItem() as TriggerModalItem);
        statusText = armPrompt(selectedItem() as TriggerModalItem);
      }
    } else if (token === "[" || token === "p") move(selected - 1);
    else if (token === "]" || token === "n") move(selected + 1);
    else if (token === "return" || token === "enter") modal.setTab("detail");
    else if (token === "up" || token === "k") {
      if (onDetail) detailScroll = clampScroll(detailScroll - 1, detailLines().length, bodyRows);
      else move(selected - 1);
    } else if (token === "down" || token === "j") {
      if (onDetail) detailScroll = clampScroll(detailScroll + 1, detailLines().length, bodyRows);
      else move(selected + 1);
    } else if (onDetail && (token === "pageup" || token === "pagedown")) {
      detailScroll = clampScroll(detailScroll + (token === "pageup" ? -bodyRows : bodyRows), detailLines().length, bodyRows);
    } else return;
    paint();
  });

  const ready = reload().then(() => {
    if (options.initialName !== undefined) {
      const index = items.findIndex((i) => itemName(i) === options.initialName);
      if (index >= 0) {
        selected = index;
      } else {
        // Review F9: a typo'd name stays on the list and says so — it never
        // opens some OTHER trigger's detail.
        modal.setTab("list");
        statusText = `no trigger named "${options.initialName}"`;
      }
      paint();
    }
  });
  return {
    ...modal,
    ready,
    reload,
    status: () => statusText,
    visibleLines: visible,
    selectedName: () => (selectedItem() === undefined ? undefined : itemName(selectedItem() as TriggerModalItem)),
    settled: () => inFlight,
  };
}
