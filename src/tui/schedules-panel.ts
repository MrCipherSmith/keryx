// Flow 295 T9 (AC10, AC13, AC14): the sidebar's Schedules section.
//
// It is mounted right after flow 300's Governance and Triggers sections (the fixed order
// sb-jobs → sb-governance → sb-triggers → sb-schedules), and reads through the same seam,
// `./trigger-ledger.ts`. It shows exactly the entries `isScheduledEntry` keeps. The Triggers
// section shows only a "N scheduled" count for them.
//
//   Schedules                         ← label (click: the /schedules list)
//   check-github 16:00 ok $0.004      ← name · next run (or "paused") · last outcome + cost
//   nightly paused refused
//
// The section is hidden (zero rows) when nothing is scheduled. Each row fits
// SIDEBAR_TEXT_WIDTH. Colours come from theme slots and are repainted on a theme switch
// (`guardedThemeRepaint`). A click on a row opens that schedule's detail modal.

import { nextCronRuns } from "../trigger/cron";
import { isScheduleInstalled } from "../trigger/install";
import type { TriggerRunRecord } from "../trigger/record";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";
import { formatAge, outcomeRole } from "./triggers-panel";
import { loadTriggerLedgerView, scheduledEntries, type TriggerEntryView, type TriggerLedgerView } from "./trigger-ledger";

type OpenTui = typeof import("@opentui/core");

export interface ScheduleChunk {
  readonly role: TextRole | "dim";
  readonly text: string;
}

export interface SchedulesPanelRow {
  readonly id: string;
  readonly name: string;
  readonly chunks: readonly ScheduleChunk[];
}

export interface SchedulesPanelProjection {
  readonly visible: boolean;
  readonly rows: readonly SchedulesPanelRow[];
}

/** The newest record that is a run's outcome. A spend reservation is not an outcome. */
export function latestOutcome(view: TriggerEntryView): TriggerRunRecord | undefined {
  return view.records.find((record) => record.outcome !== "reserved");
}

/** `Wed 2026-09-23 16:00`, in local time — the Overview's full form of what the row shows. */
export function formatLocalDateTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * L4: the colour of a last outcome. A reservation resolved by hand means the run was killed
 * before it recorded its own outcome — something to look at, never a green "resolved".
 */
export function scheduleOutcomeRole(outcome: TriggerRunRecord["outcome"]): TextRole {
  return outcome === "reservation-resolved" ? "attention" : outcomeRole(outcome);
}

/** `14:00` today, `Tue 09:30` otherwise, `—` when none is due within a year. Local time, like the timer. */
export function formatNextRun(cron: string, now: Date): string {
  const next = nextCronRuns(cron, now, 1)[0];
  if (next === undefined) return "—";
  const hhmm = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  const sameDay = next.getFullYear() === now.getFullYear() && next.getMonth() === now.getMonth() && next.getDate() === now.getDate();
  return sameDay ? hhmm : `${next.toLocaleDateString("en-US", { weekday: "short" })} ${hhmm}`;
}

/** `ok 3h $0.0042` / `budget-refused 1d` / `never ran` — the modal's full form. */
export function formatLastOutcome(record: TriggerRunRecord | undefined, now: Date): string {
  if (record === undefined) return "never ran";
  const cost = record.cost.recorded ? ` $${Number(record.cost.usd.toFixed(4))}` : "";
  return `${record.outcome} ${formatAge(record.at, now)}${cost}`;
}

/** The sidebar's compact outcome word: ok / failed / refused / no-op / resolved. */
export function shortOutcome(outcome: TriggerRunRecord["outcome"]): string {
  if (outcome.endsWith("-refused")) return "refused";
  if (outcome === "reservation-resolved") return "resolved";
  return outcome;
}

/** `ok $0.004` / `refused` / `never ran` — what fits a 30-column row. */
export function compactOutcome(record: TriggerRunRecord | undefined): string {
  if (record === undefined) return "never ran";
  const usd = record.cost.recorded ? record.cost.usd : undefined;
  const cost = usd === undefined ? "" : usd > 0 && usd < 0.001 ? " <$0.001" : ` $${Number(usd.toFixed(3))}`;
  return `${shortOutcome(record.outcome)}${cost}`;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function projectSchedulesPanel(
  view: TriggerLedgerView | undefined,
  options: { width: number; now: Date; loadError?: string; notInstalled?: ReadonlySet<string> },
): SchedulesPanelProjection {
  const w = options.width;
  if (options.loadError !== undefined) {
    return { visible: true, rows: [{ id: "sb-schedules-error", name: "", chunks: [{ role: "error", text: fit(`could not read: ${options.loadError}`, w) }] }] };
  }
  if (view === undefined) return { visible: false, rows: [] };
  const scheduled = scheduledEntries(view);
  if (scheduled.length === 0) return { visible: false, rows: [] };
  const rows = scheduled.map((item): SchedulesPanelRow => {
    const { entry } = item;
    const cron = entry.fire.kind === "schedule" ? entry.fire.cron : "";
    // L4: an active schedule whose timer files are gone never fires — say so, not a time.
    const missing = entry.enabled && options.notInstalled?.has(entry.name) === true;
    const state = !entry.enabled ? "paused" : missing ? "not installed" : formatNextRun(cron, options.now);
    const latest = latestOutcome(item);
    const last = compactOutcome(latest);
    const middle = ` ${state} `;
    // Keep the state and the outcome whole where possible; shorten the NAME first.
    const nameRoom = Math.max(1, w - middle.length - last.length);
    const name = fit(entry.name, nameRoom);
    const lastRoom = Math.max(0, w - name.length - middle.length);
    return {
      id: `sb-schedules-${entry.name}`,
      name: entry.name,
      chunks: [
        { role: "text", text: name },
        { role: entry.enabled && !missing ? "dim" : "attention", text: middle },
        { role: latest === undefined ? "muted" : scheduleOutcomeRole(latest.outcome), text: fit(last, lastRoom) },
      ],
    };
  });
  return { visible: true, rows };
}

type Box = { add(child: unknown): void; remove(child: unknown): void; getChildren(): unknown[] };

export interface SchedulesPanelOptions {
  cwd: string;
  width: number;
  /** A row click: that schedule's detail; the label: the list. */
  onOpen: (name: string | undefined) => void;
  load?: (cwd: string) => Promise<TriggerLedgerView>;
  now?: () => Date;
  /** Called after every read, with the view just painted (the composition's report notices). */
  onRead?: (view: TriggerLedgerView) => void;
  /** L4: is this local schedule's timer present? Default: a file (or crontab) check, no scheduler query. */
  isInstalled?: (cwd: string, item: TriggerEntryView) => Promise<boolean>;
}

async function defaultIsInstalled(cwd: string, item: TriggerEntryView): Promise<boolean> {
  const { entry } = item;
  if (entry.source !== "store" || entry.fire.kind !== "schedule") return true;
  return isScheduleInstalled(cwd, entry.name, entry.fire.cron, {}, entry.install).catch(() => true);
}

export interface SchedulesPanelHandle {
  refresh(): Promise<void>;
  /** Re-project (next-run times move on). Rebuilds the rows only when the projection changed. */
  repaint(): void;
  projection(): SchedulesPanelProjection;
  /** How many times the rows were rebuilt (AC13: an unchanged tick rebuilds nothing). */
  paintCount(): number;
  view(): TriggerLedgerView | undefined;
  dispose(): void;
}

export function mountSchedulesPanel(otui: unknown, renderer: unknown, parent: unknown, options: SchedulesPanelOptions): SchedulesPanelHandle {
  const core = otui as OpenTui;
  const r = renderer as never;
  const box = new core.BoxRenderable(r, { id: "sb-schedules", flexDirection: "column", flexShrink: 0 }) as unknown as Box;
  (parent as { add(child: unknown): void }).add(box);
  const load = options.load ?? loadTriggerLedgerView;
  const now = options.now ?? (() => new Date());
  let view: TriggerLedgerView | undefined;
  let loadError: string | undefined;
  let notInstalled: ReadonlySet<string> = new Set();
  let projected: SchedulesPanelProjection = { visible: false, rows: [] };
  let paintedKey: string | undefined;
  let paints = 0;
  let generation = 0;
  let disposed = false;
  const isInstalled = options.isInstalled ?? defaultIsInstalled;

  const chunkOf = (c: ScheduleChunk): ReturnType<typeof dimChunk> => (c.role === "dim" ? dimChunk(core, c.text) : roleChunk(core, c.role, c.text));

  const paint = (force = false): void => {
    if (disposed) return;
    projected = projectSchedulesPanel(view, { width: options.width, now: now(), notInstalled, ...(loadError !== undefined ? { loadError } : {}) });
    // AC13: an unchanged projection is not repainted (a theme switch forces it: same text, new colours).
    const key = JSON.stringify(projected);
    if (!force && key === paintedKey) return;
    paintedKey = key;
    paints += 1;
    clearTranscriptChildren(box);
    if (!projected.visible) return;
    box.add(
      new core.TextRenderable(r, {
        id: "sb-schedules-k",
        content: core.t`${dimChunk(core, "Schedules")}`,
        marginTop: 1,
        onMouseDown: () => options.onOpen(undefined),
      }),
    );
    for (const row of projected.rows) {
      const name = row.name;
      box.add(
        new core.TextRenderable(r, {
          id: row.id,
          content: new core.StyledText(row.chunks.map(chunkOf)),
          onMouseDown: () => options.onOpen(name.length > 0 ? name : undefined),
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
    let missing: Set<string> = new Set();
    if (next !== undefined) {
      const checks = await Promise.all(
        scheduledEntries(next).map(async (item) => ((await isInstalled(options.cwd, item).catch(() => true)) ? undefined : item.entry.name)),
      );
      missing = new Set(checks.filter((n): n is string => n !== undefined));
    }
    if (disposed || mine !== generation) return;
    view = next;
    loadError = error;
    notInstalled = missing;
    paint();
    if (next !== undefined) options.onRead?.(next);
  };
  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("schedules-panel", () => paint(true), () => disposed || isRenderableGone(box)));
  return {
    refresh,
    repaint: () => paint(),
    projection: () => projected,
    paintCount: () => paints,
    view: () => view,
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribeTheme();
    },
  };
}
