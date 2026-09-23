// Flow 300 T7 (AC4): the sidebar's Triggers section.
//
// Hidden (zero rows) when the project declares no trigger config — the same
// "no rows for nothing" idiom as Workspace/Review, because `sidebarTop` is a
// fixed-height column. Otherwise:
//
//   Triggers                          ← label (click: open the modal)
//   spent $0.12 · 2 not recorded      ← project trigger spend, never folding an
//                                       unrecorded cost into $0
//   ! 1 open reservation              ← attention role, only when > 0
//   NET nightly · enabled · ok 3h     ← one row per EVENT-fired entry; `NET` in
//   sync · disabled · never fired       the attention role when its dispatch
//                                       has the host network
//   2 scheduled                       ← schedule-fired entries: a count only.
//                                       Flow 295's Schedules section owns their
//                                       rows (`isScheduledEntry`).
//
// Everything is read through `./trigger-ledger.ts` (the seam flow 295 reuses).

import { formatUsd } from "../governance/service";
import { entryHasNetwork } from "../trigger/describe";
import type { TriggerRunOutcomeKind } from "../trigger/record";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";
import { eventEntries, loadTriggerLedgerView, scheduledEntries, type TriggerLedgerView } from "./trigger-ledger";

type OpenTui = typeof import("@opentui/core");

export interface PanelChunk {
  readonly role: TextRole | "dim";
  readonly text: string;
}

export interface TriggersPanelRow {
  readonly id: string;
  readonly chunks: readonly PanelChunk[];
  /** What a click opens: the modal on that trigger, or the modal's list. */
  readonly target: { readonly kind: "list" } | { readonly kind: "trigger"; readonly name: string };
}

export interface TriggersPanelProjection {
  readonly visible: boolean;
  readonly rows: readonly TriggersPanelRow[];
}

export const NET_MARKER = "NET";

/** `5s`, `3m`, `2h`, `4d` — how long ago `iso` was. */
export function formatAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "?";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The theme role an outcome is painted in. */
export function outcomeRole(outcome: TriggerRunOutcomeKind): TextRole {
  if (outcome === "ok" || outcome === "reservation-resolved") return "ok";
  if (outcome === "failed") return "error";
  if (outcome === "lock-refused" || outcome === "budget-refused" || outcome === "dispatch-refused") return "attention";
  return "muted";
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** `spent $0.12 · 2 not recorded` / `spent $0` / `spend unreadable`. */
export function formatTriggerSpend(spend: TriggerLedgerView["spend"]): { text: string; role: TextRole | "dim" } {
  if (spend.state === "absent") return { text: `spent ${formatUsd(0)} · nothing fired yet`, role: "dim" };
  if (spend.state === "unreadable") return { text: "spend: ledger unreadable", role: "error" };
  // The governance report's own formatter (4 decimals, trimmed): `$0.004`,
  // never a rounded-away `$0.00` (review F3).
  const usd = formatUsd(spend.spentUsd);
  const notRecorded = spend.runsWithCostNotRecorded > 0 ? ` · ${spend.runsWithCostNotRecorded} not recorded` : "";
  return { text: `spent ${usd}${notRecorded}`, role: "dim" };
}

export function projectTriggersPanel(
  view: TriggerLedgerView | undefined,
  options: { width: number; now: Date; loadError?: string },
): TriggersPanelProjection {
  const w = options.width;
  const list = { kind: "list" } as const;
  const rows: TriggersPanelRow[] = [];
  // Review F12: a read that FAILED is not "no triggers" — say so, never hide.
  if (options.loadError !== undefined) {
    rows.push({ id: "sb-triggers-error", chunks: [{ role: "error", text: fit(`could not read: ${options.loadError}`, w) }], target: list });
    return { visible: true, rows };
  }
  if (view === undefined || view.config.kind === "absent") return { visible: false, rows: [] };
  if (view.config.kind === "broken") {
    rows.push({ id: "sb-triggers-broken", chunks: [{ role: "error", text: fit(`config unreadable (${view.config.problem})`, w) }], target: list });
    return { visible: true, rows };
  }
  const spend = formatTriggerSpend(view.spend);
  rows.push({ id: "sb-triggers-spend", chunks: [{ role: spend.role, text: fit(spend.text, w) }], target: list });
  // N8: one name for one fact — an open reservation is ONLY "open", with the
  // USD it holds; the spend line above never counts it as "not recorded".
  const open = view.openReservations.length;
  if (open > 0) {
    const held = formatUsd(view.openReservations.reduce((sum, r) => sum + r.usd, 0));
    rows.push({
      id: "sb-triggers-reservations",
      chunks: [{ role: "attention", text: fit(`! ${open} open · ${held} reserved`, w) }],
      target: list,
    });
  }
  for (const item of eventEntries(view)) {
    const { entry, latest } = item;
    const last = latest === undefined ? "never fired" : `${latest.outcome} ${formatAge(latest.at, options.now)}`;
    const chunks: PanelChunk[] = [];
    let budget = w;
    if (entryHasNetwork(entry)) {
      chunks.push({ role: "attention", text: `${NET_MARKER} ` });
      budget -= NET_MARKER.length + 1;
    }
    const lastRole: TextRole = latest === undefined ? "muted" : outcomeRole(latest.outcome);
    const state = ` · ${entry.enabled ? "enabled" : "disabled"} · `;
    // Keep the outcome whole; shorten the NAME when the row would not fit.
    const nameRoom = Math.max(1, budget - state.length - last.length);
    chunks.push({ role: "text", text: `${fit(entry.name, nameRoom)}${state}` });
    chunks.push({ role: lastRole, text: fit(last, Math.max(0, budget - Math.min(entry.name.length, nameRoom) - state.length)) });
    rows.push({ id: `sb-triggers-${entry.name}`, chunks, target: { kind: "trigger", name: entry.name } });
  }
  const scheduled = scheduledEntries(view).length;
  if (scheduled > 0) {
    rows.push({ id: "sb-triggers-scheduled", chunks: [{ role: "muted", text: fit(`${scheduled} scheduled`, w) }], target: list });
  }
  if (view.rejected.length > 0) {
    rows.push({
      id: "sb-triggers-rejected",
      chunks: [{ role: "error", text: fit(`${view.rejected.length} rejected entr${view.rejected.length === 1 ? "y" : "ies"}`, w) }],
      target: list,
    });
  }
  return { visible: true, rows };
}

type Box = { add(child: unknown): void; remove(child: unknown): void; getChildren(): unknown[] };

export interface TriggersPanelOptions {
  cwd: string;
  width: number;
  /** Open the modal, on one trigger or on its list. */
  onOpen: (name: string | undefined) => void;
  /** Injectable for tests. Default `loadTriggerLedgerView(cwd)`. */
  load?: (cwd: string) => Promise<TriggerLedgerView>;
  now?: () => Date;
}

export interface TriggersPanelHandle {
  refresh(): Promise<void>;
  /** Re-project the last read without reading again (row ages move on). */
  repaint(): void;
  /** The last projection painted (tests). */
  projection(): TriggersPanelProjection;
  /** The last view read. */
  view(): TriggerLedgerView | undefined;
  dispose(): void;
}

export function mountTriggersPanel(
  otui: unknown,
  renderer: unknown,
  parent: unknown,
  options: TriggersPanelOptions,
): TriggersPanelHandle {
  const core = otui as OpenTui;
  const r = renderer as never;
  const box = new core.BoxRenderable(r, { id: "sb-triggers", flexDirection: "column", flexShrink: 0 }) as unknown as Box;
  (parent as { add(child: unknown): void }).add(box);
  const load = options.load ?? loadTriggerLedgerView;
  const now = options.now ?? (() => new Date());
  let view: TriggerLedgerView | undefined;
  let loadError: string | undefined;
  let projected: TriggersPanelProjection = { visible: false, rows: [] };
  let generation = 0;
  let disposed = false;

  const chunkOf = (c: PanelChunk): ReturnType<typeof dimChunk> =>
    c.role === "dim" ? dimChunk(core, c.text) : roleChunk(core, c.role, c.text);

  const paint = (): void => {
    if (disposed) return;
    projected = projectTriggersPanel(view, { width: options.width, now: now(), ...(loadError !== undefined ? { loadError } : {}) });
    clearTranscriptChildren(box);
    if (!projected.visible) return;
    box.add(
      new core.TextRenderable(r, {
        id: "sb-triggers-k",
        content: core.t`${dimChunk(core, "Triggers")}`,
        marginTop: 1,
        onMouseDown: () => options.onOpen(undefined),
      }),
    );
    for (const row of projected.rows) {
      const target = row.target;
      box.add(
        new core.TextRenderable(r, {
          id: row.id,
          content: new core.StyledText(row.chunks.map(chunkOf)),
          onMouseDown: () => options.onOpen(target.kind === "trigger" ? target.name : undefined),
        }),
      );
    }
  };

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    let next: TriggerLedgerView | undefined;
    let error: string | undefined;
    try {
      next = await load(options.cwd);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (disposed || mine !== generation) return;
    view = next;
    loadError = error;
    paint();
  };
  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("triggers-panel", paint, () => disposed || isRenderableGone(box)));
  void refresh();
  return {
    refresh,
    repaint: paint,
    projection: () => projected,
    view: () => view,
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribeTheme();
    },
  };
}
