// `/decisions` (flow 392, AC8): the TUI half of `keryx decisions report`. A
// read-only modal over the same lines the CLI prints (`reportText`, never a second
// formatter), a sidebar row `sb-decisions` that is present only once the journal
// holds a decision, and the shell routing for the command.
//
// Opening it never writes: it reads the journal and refuses nothing.

import { findAgentCommand } from "../commands/agent-commands";
import { ARMS, ARM_FACTORS, annotatedCount, backfilledCount, changeAnswer, decisionCount, giveReason, loadReport, oneLine, reportText, resolveFlowContext } from "../decisions/service";
import { clampScroll, wrapLines, windowLines, type ModalHandle, type OpenModalFn } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalChrome, type ModalHandle as HostModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";

type OpenTui = typeof import("@opentui/core");

export const DECISIONS_COMMAND = "/decisions";
export const DECISIONS_POLL_MS = 5000;
/** The sidebar mark for decisions answered with the operator's own text or carrying a typed reason. */
export const OWN_MARK = "✍";

export const DECISIONS_FOOTER = [
  { key: "↑/↓", label: "scroll" },
  { key: "esc", label: "close" },
] as const;

export function isDecisionsCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === DECISIONS_COMMAND;
}

export type DecisionsCommand =
  | { kind: "show" }
  | { kind: "reason"; text: string }
  | { kind: "change"; choice: string }
  | { kind: "arms" };

/**
 * `/decisions` opens the report; `/decisions reason <why>` adds the one optional
 * reason to the latest answered question, and `/decisions change <option>` changes
 * its answer (after a blind reveal, say). Neither follow-up ever holds a question.
 * `/decisions arms` (flow 400, AC16) opens the arm summary: how often the recommendation was followed in each arm.
 */
export function parseDecisionsCommand(line: string): DecisionsCommand {
  const [, sub, ...rest] = line.trim().split(/\s+/);
  const tail = rest.join(" ").trim();
  if (sub === "reason") return { kind: "reason", text: tail };
  if (sub === "change") return { kind: "change", choice: tail };
  if (sub === "arms") return { kind: "arms" };
  return { kind: "show" };
}

function shortQuestion(question: string): string {
  return oneLine(question, 60);
}

export interface DecisionsFollowupDeps {
  cwd: string;
  /** The latest question answered through the journal in this session. */
  lastDecisionId?: (() => string | undefined) | undefined;
  /** This session's id: a follow-up without a decision id only touches a decision asked under it. */
  session?: string | undefined;
  /** Where the outcome is told (the transcript). */
  notice?: ((text: string) => void) | undefined;
}

/** Run a `reason` or `change` command and say what happened. Never throws. */
export async function runDecisionsFollowup(command: Exclude<DecisionsCommand, { kind: "show" | "arms" }>, deps: DecisionsFollowupDeps): Promise<void> {
  const say = (text: string): void => {
    try {
      deps.notice?.(text);
    } catch {
      // a failing transcript is not the journal's problem
    }
  };
  const lastId = deps.lastDecisionId?.();
  try {
    // no decision from this session: look at the latest one of this flow (to name it), never the repo-wide latest;
    // it is acted on only when it was asked in this session
    const flow = lastId === undefined ? (await resolveFlowContext(deps.cwd)).flow : undefined;
    if (command.kind === "reason") {
      const done = await giveReason({ cwd: deps.cwd, text: command.text, lastId, flow, session: deps.session });
      say(`Reason ${done.replaced ? "changed" : "recorded"} for decision ${done.id} ("${shortQuestion(done.question)}").`);
      return;
    }
    if (command.choice.length === 0) throw new Error("name the option: /decisions change <option id or label>");
    const result = await changeAnswer({ cwd: deps.cwd, choice: command.choice, lastId, flow, session: deps.session });
    say(
      `Decision ${result.id} ("${shortQuestion(result.question)}"): answer changed from ${result.previous} to ${result.choice}. ` +
        `The agent already received the first answer (${result.previous}), so the change is recorded in the journal but may not reach the agent. The report counts the first answer.`,
    );
  } catch (cause) {
    say(`/decisions ${command.kind}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const UNREADABLE = "The recommendation journal could not be read.";

// --- the arm summary (flow 400, AC16) ----------------------------------------
//
// One read of the same report `keryx decisions report` is built from (`loadReport`), cut into the arm table. No
// arithmetic of its own beyond a share: the cells are the report's. The report's arm fields may be absent (a journal
// built before the arms, or a report without the A-free / A-forced split): every access is defensive and the summary
// degrades to the older modes (ordinary / partial / blind) rather than failing.

interface LooseTally {
  answered?: number;
  matched?: number;
}

interface LooseArmCell {
  decisions?: number;
  answered?: number;
  tally?: LooseTally;
  medianMs?: number | null;
}

export interface ArmsSummaryRow {
  key: string;
  label: string;
  decisions: number;
  /** Answered decisions that had a recommendation: what the share is out of. */
  answered: number;
  matched: number;
  /** Share in [0, 1] of the first answers that matched the recommendation, or null when none had one. */
  share: number | null;
  medianMs: number | null;
}

export interface ArmsSummaryChannel {
  channel: string;
  rows: ArmsSummaryRow[];
}

export interface ArmsSummary {
  /** "arms": the report carries the four arms; "modes": only the older three modes were available. */
  basis: "arms" | "modes";
  /** The one channel `rows` and `armA` cover: a typed answer on Telegram is never pooled with a TUI pick. */
  channel: string;
  rows: ArmsSummaryRow[];
  /** Arm A split by why it is A (drawn or forced), when the report has the split. */
  armA: ArmsSummaryRow[];
  /** The other channels, each in its own cut (Telegram has arms A and B merged into one row). */
  channels: ArmsSummaryChannel[];
  /** Flow 400 (AC17-AC21): reasons, ineligible questions and progress, when the report carries them. */
  extras: ArmsExtras;
}

export interface ArmsShare {
  decisions: number;
  named: number;
}

export interface ArmsExtras {
  /** Share of named reasons on agreement (the reason subsample only) and on deviation; null when the report has none. */
  reasons: { agreement: ArmsShare; deviation: ArmsShare; requestedMs: number | null; notRequestedMs: number | null } | null;
  /** Questions outside the arm comparison (irreversible, an action or a blind.ts match). */
  ineligible: { decisions: number; answered: number } | null;
  progress: { decisions: number; decisionsTarget: number; blind: number; blindTarget: number; threshold: number; counts: Array<[string, number]> } | null;
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function maybeMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readShare(value: unknown): ArmsShare {
  const v = (value ?? {}) as { decisions?: unknown; named?: unknown };
  const decisions = whole(v.decisions);
  return { decisions, named: Math.min(whole(v.named), decisions) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The AC17-AC21 blocks of a report, each one null when the report predates it. */
function summarizeExtras(report: { reasons?: unknown; ineligible?: unknown; progress?: unknown }): ArmsExtras {
  const reasons = isObject(report.reasons)
    ? {
        agreement: readShare(report.reasons["agreement"]),
        deviation: readShare(report.reasons["deviation"]),
        requestedMs: isObject(report.reasons["requested"]) ? maybeMs(report.reasons["requested"]["medianMs"]) : null,
        notRequestedMs: isObject(report.reasons["notRequested"]) ? maybeMs(report.reasons["notRequested"]["medianMs"]) : null,
      }
    : null;
  const ineligible = isObject(report.ineligible) ? { decisions: whole(report.ineligible["decisions"]), answered: whole(report.ineligible["answered"]) } : null;
  let progress: ArmsExtras["progress"] = null;
  if (isObject(report.progress) && isObject(report.progress["ac11"]) && isObject(report.progress["perArm"])) {
    const ac11 = report.progress["ac11"];
    const perArm = report.progress["perArm"];
    const counts = isObject(perArm["counts"]) ? perArm["counts"] : {};
    progress = {
      decisions: whole(ac11["decisions"]),
      decisionsTarget: whole(ac11["decisionsTarget"]),
      blind: whole(ac11["blind"]),
      blindTarget: whole(ac11["blindTarget"]),
      threshold: whole(perArm["threshold"]),
      counts: ARMS.map((arm): [string, number] => [arm, whole(counts[arm])]),
    };
  }
  return { reasons, ineligible, progress };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function cellRow(key: string, label: string, cell: unknown): ArmsSummaryRow {
  const c = (cell ?? {}) as LooseArmCell;
  const answered = nonNegative(c.tally?.answered);
  const matched = Math.min(nonNegative(c.tally?.matched), answered);
  const median = c.medianMs;
  return {
    key,
    label,
    decisions: nonNegative(c.decisions) || nonNegative(c.answered) || answered,
    answered,
    matched,
    share: answered > 0 ? matched / answered : null,
    medianMs: typeof median === "number" && Number.isFinite(median) ? median : null,
  };
}

/** What an arm is, from the factors the journal itself draws it by (never a second copy of the table). */
function armLabel(arm: (typeof ARMS)[number]): string {
  const f = ARM_FACTORS[arm];
  const mark = f.mark === "shown" ? "mark shown" : "mark hidden";
  const how = f.preselect ? "preselected" : f.order === "shuffled" ? "shuffled" : "not preselected";
  return `${arm}  ${mark}, ${how}`;
}

const MODE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["ordinary", "ordinary  mark shown"],
  ["partial", "partial  not preselected"],
  ["blind", "blind  mark hidden"],
];

/** Cut a report into the arm table. Accepts anything: a missing field is an empty cell, never an error. */
export function summarizeArms(report: unknown): ArmsSummary {
  const r = (report ?? {}) as {
    byArm?: Record<string, unknown>;
    armA?: { free?: unknown; forced?: unknown };
    byMode?: Record<string, unknown>;
    headlineChannel?: unknown;
    byChannel?: unknown;
    reasons?: unknown;
    ineligible?: unknown;
    progress?: unknown;
  };
  const extras = summarizeExtras(r);
  const channel = typeof r.headlineChannel === "string" && r.headlineChannel.length > 0 ? oneLine(r.headlineChannel, 40) : "tui";
  const channels: ArmsSummaryChannel[] = [];
  if (Array.isArray(r.byChannel)) {
    for (const entry of r.byChannel as unknown[]) {
      const e = (entry ?? {}) as { channel?: unknown; rows?: unknown };
      if (typeof e.channel !== "string" || e.channel === channel || !Array.isArray(e.rows)) continue;
      const rows = (e.rows as unknown[]).map((row) => {
        const x = (row ?? {}) as { key?: unknown; label?: unknown; row?: unknown };
        return cellRow(typeof x.key === "string" ? x.key : "?", typeof x.label === "string" ? oneLine(x.label, 40) : "?", x.row);
      });
      channels.push({ channel: oneLine(e.channel, 40), rows });
    }
  }
  if (r.byArm !== undefined && r.byArm !== null && typeof r.byArm === "object") {
    const byArm = r.byArm;
    const armA: ArmsSummaryRow[] = [];
    if (r.armA !== undefined && r.armA !== null && typeof r.armA === "object") {
      armA.push(cellRow("A-free", "A drawn", r.armA.free), cellRow("A-forced", "A forced (irreversible)", r.armA.forced));
    }
    return { basis: "arms", channel, rows: ARMS.map((arm) => cellRow(arm, armLabel(arm), byArm[arm])), armA, channels, extras };
  }
  const byMode = r.byMode ?? {};
  return { basis: "modes", channel, rows: MODE_LABELS.map(([key, label]) => cellRow(key, label, { tally: byMode[key] })), armA: [], channels: [], extras };
}

function pct(share: number | null): string {
  return share === null ? "-" : `${Math.round(share * 100)}%`;
}

function duration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`;
}

function armsTableLine(row: ArmsSummaryRow, labelWidth: number): string {
  const cells = [row.label.padEnd(labelWidth), String(row.decisions).padStart(5), `${row.matched}/${row.answered}`.padStart(7), pct(row.share).padStart(5)];
  return `${cells.join("  ")}  ${duration(row.medianMs)}`;
}

function shareText(share: ArmsShare): string {
  return share.decisions === 0 ? "-" : `${Math.round((share.named / share.decisions) * 100)}% (${share.named}/${share.decisions})`;
}

/** The reasons, ineligible and progress lines under the arm table; nothing for a report that has none of them. */
function extrasLines(extras: ArmsExtras): string[] {
  const lines: string[] = [];
  if (extras.reasons !== null) {
    const { agreement, deviation, requestedMs, notRequestedMs } = extras.reasons;
    lines.push(
      "",
      `Reasons named: agreement ${shareText(agreement)} (one-third subsample), deviation ${shareText(deviation)}`,
      `Median time to answer: reason requested ${duration(requestedMs)}, not requested ${duration(notRequestedMs)}`,
    );
  }
  if (extras.ineligible !== null) lines.push(`Not in the comparison (ineligible): ${extras.ineligible.decisions}, ${extras.ineligible.answered} answered`);
  if (extras.progress !== null) {
    const p = extras.progress;
    lines.push(
      `Progress, flow 392 AC11: ${p.decisions}/${p.decisionsTarget} decisions, ${p.blind}/${p.blindTarget} blind`,
      `Progress per arm (threshold ${p.threshold}): ${p.counts.map(([arm, n]) => `${arm} ${n}`).join(", ")}`,
    );
  }
  return lines;
}

/** The modal body: the arm table, the A split when the report has it, and a plain note when it degraded. */
export function armsSummaryText(summary: ArmsSummary): string {
  const rows = [...summary.rows, ...summary.armA, ...summary.channels.flatMap((entry) => entry.rows)];
  const width = Math.max(...rows.map((row) => row.label.length));
  const header = ["arm".padEnd(width), "asked".padStart(5), "matched".padStart(7), "share".padStart(5)].join("  ") + "  median";
  const lines = [summary.basis === "arms" ? `Recommendation arms (randomized decisions, ${summary.channel} channel only)` : "Recommendation modes (no per-arm data in this report)", "", header];
  lines.push(...summary.rows.map((row) => armsTableLine(row, width)));
  if (summary.armA.length > 0) lines.push("", "Arm A, split:", ...summary.armA.map((row) => armsTableLine(row, width)));
  for (const entry of summary.channels) lines.push("", `Channel ${entry.channel}:`, ...entry.rows.map((row) => armsTableLine(row, width)));
  lines.push("", "share = first answers that matched the recommendation, out of the answered ones that had one.");
  lines.push(...extrasLines(summary.extras));
  if (summary.basis === "modes") lines.push("The per-arm split (A, B, C, D) needs a journal report with arm data; the older modes are shown instead.");
  return lines.join("\n");
}

/** The arm summary text for a repository: one read of the report, the same data `keryx decisions report` prints. */
export async function armsText(cwd: string): Promise<string> {
  try {
    return armsSummaryText(summarizeArms(await loadReport(cwd)));
  } catch {
    return UNREADABLE;
  }
}

export interface ArmsPanelProjection {
  readonly visible: boolean;
  readonly text: string;
}

/** One sidebar row of shares per arm, only once some arm holds an answered decision with a recommendation. */
export function projectArmsPanel(summary: ArmsSummary, width: number): ArmsPanelProjection {
  if (summary.basis !== "arms" || summary.rows.every((row) => row.answered === 0)) return { visible: false, text: "" };
  const shares = summary.rows.map((row) => `${row.key} ${pct(row.share)}`).join(" ");
  const compact = summary.rows.map((row) => `${row.key}${pct(row.share)}`).join(" ");
  const candidates = [`${shares} · arms`, shares, compact];
  const text = candidates.find((candidate) => candidate.length <= width) ?? compact.slice(0, Math.max(1, width));
  return { visible: true, text };
}

/** The report body as modal lines: exactly what `keryx decisions report` prints. */
export function formatDecisionsLines(text: string): string[] {
  return text.split("\n");
}

export type PresentDecisionsOptions = {
  text: string;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  /** The tab label; the report by default. */
  tabLabel?: string;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function paint(otui: unknown, renderer: unknown, body: unknown, content: string): { content: string } | undefined {
  const parent = body as { add?: (child: unknown) => void } | undefined | null;
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } } | undefined | null)
    ?.TextRenderable;
  if (parent?.add === undefined || ctor === undefined) return undefined;
  const node = new ctor(renderer, { id: "decisions-body", content });
  parent.add(node);
  return node;
}

export function presentDecisions(open: OpenModalFn, otui: unknown, chrome: unknown, options: PresentDecisionsOptions): ModalHandle | undefined {
  const rows = formatDecisionsLines(options.text);
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  let scroll = 0;
  let width: number | undefined;
  let node: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;

  const content = (): string => {
    scroll = clampScroll(scroll, rows.length, bodyRows);
    return wrapLines(windowLines(rows, scroll, bodyRows).join("\n"), width);
  };
  const repaint = (): void => {
    if (node !== undefined) node.content = content();
  };

  const handle = open(otui, chrome, {
    title: DECISIONS_COMMAND,
    tabs: [{ id: "report", label: options.tabLabel ?? "Recommendations" }],
    initialTab: "report",
    footer: DECISIONS_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx?.width;
      node = paint(otui, options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer, body, content());
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) return undefined;
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      const step = token === "up" || token === "k" ? -1 : token === "down" || token === "j" ? 1 : token === "pageup" ? -bodyRows : token === "pagedown" ? bodyRows : 0;
      if (step === 0) return;
      scroll = clampScroll(scroll + step, rows.length, bodyRows);
      repaint();
    });
  }
  return handle;
}

export type OpenDecisionsOptions = Omit<PresentDecisionsOptions, "text"> & { cwd: string };

/** Read the journal and open the modal over what `keryx decisions report` would print. */
export async function openDecisions(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: OpenDecisionsOptions,
): Promise<HostModalHandle | undefined> {
  const { cwd, ...rest } = options;
  const text = await reportText(cwd).catch(() => UNREADABLE);
  return presentDecisions((hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input), otui, chrome, { ...rest, text }) as
    | HostModalHandle
    | undefined;
}

/** Open the same modal over the arm summary (`/decisions arms`, or a click on the arms row). */
export async function openDecisionsArms(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: OpenDecisionsOptions,
): Promise<HostModalHandle | undefined> {
  const { cwd, ...rest } = options;
  const text = await armsText(cwd);
  return presentDecisions((hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input), otui, chrome, { ...rest, text, tabLabel: "Arms" }) as
    | HostModalHandle
    | undefined;
}

// --- the sidebar row ---------------------------------------------------------

export interface DecisionsPanelProjection {
  readonly visible: boolean;
  readonly text: string;
}

/** One row, and only once the journal holds a decision: zero rows otherwise. */
export function projectDecisionsPanel(count: number, width: number, backfilled = 0, annotated = 0): DecisionsPanelProjection {
  if (count <= 0 && backfilled <= 0) return { visible: false, text: "" };
  // live decisions first; the backfilled (historical) ones are shown apart, never added into the live count
  const live = count > 0 ? `${count} decision${count === 1 ? "" : "s"}` : "";
  const before = backfilled > 0 ? `${count > 0 ? " + " : ""}${backfilled} before` : "";
  const label = `${live}${before}`;
  // flow 401: a decision answered in the operator's own words, or carrying a typed reason, is marked ✍N;
  // the modal lists each of them in full
  const marked = annotated > 0 ? `${label} ${OWN_MARK}${annotated}` : label;
  const candidates = [`${marked} · /decisions`, marked, `${label} · /decisions`, label];
  const text = candidates.find((candidate) => candidate.length <= width) ?? label.slice(0, Math.max(1, width));
  return { visible: true, text };
}

export interface DecisionsSidebarOptions {
  otui: unknown;
  chrome: ModalChrome & { showToast(message: string): void };
  parent: unknown;
  width: number;
  cwd: string;
  onKeypress: OpenDecisionsOptions["onKeypress"];
  /** Where `/decisions reason|change` tell the outcome (the transcript). */
  notice?: ((text: string) => void) | undefined;
  /** The latest question answered through the journal in this session. */
  lastDecisionId?: (() => string | undefined) | undefined;
  /** This session's id, so `/decisions reason|change` without an id stays inside this session's decisions. */
  session?: string | undefined;
  /** Test seam: how many LIVE decisions the journal holds. */
  count?: () => Promise<number>;
  /** Test seam: how many backfilled (historical) decisions the journal holds. */
  backfilled?: () => Promise<number>;
  /** Test seam: the report the arm summary is cut from. Default: `loadReport(cwd)`, a read-only call. */
  armsReport?: () => Promise<unknown>;
  /** Test seam: how many live decisions carry the operator's own text or a typed reason. */
  annotated?: () => Promise<number>;
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
}

export interface DecisionsSidebar {
  projection(): DecisionsPanelProjection;
  paintCount(): number;
  /** The arm summary row: present only once some arm holds an answered decision that had a recommendation. */
  armsProjection(): ArmsPanelProjection;
  show(): Promise<HostModalHandle | undefined>;
  /** Opens the arm summary modal (`/decisions arms`). */
  showArms(): Promise<HostModalHandle | undefined>;
  /** Routes `/decisions`; false for any other line. */
  handleCommand(line: string): boolean;
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * The shell's routing of `/decisions`, called from BOTH of `runLine`'s branches:
 * idle resolves through the agent-mode registry; busy is allowed (it only reads).
 */
export function routeDecisionsCommand(line: string, decisions: Pick<DecisionsSidebar, "handleCommand">): boolean {
  const command = findAgentCommand(line, "agent");
  if (command === undefined || command.name !== DECISIONS_COMMAND) return false;
  return decisions.handleCommand(line);
}

function defaultInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function mountDecisionsSidebar(options: DecisionsSidebarOptions): DecisionsSidebar {
  const core = options.otui as OpenTui;
  const { chrome } = options;
  const r = chrome.renderer as never;
  const count = options.count ?? (() => decisionCount(options.cwd));
  const backfilledTotal = options.backfilled ?? (() => backfilledCount(options.cwd));
  const annotatedTotal = options.annotated ?? (() => annotatedCount(options.cwd));
  const box = new core.BoxRenderable(r, { id: "sb-decisions", flexDirection: "column", flexShrink: 0 });
  (options.parent as { add(child: unknown): void }).add(box);
  const armsBox = new core.BoxRenderable(r, { id: "sb-decisions-arms", flexDirection: "column", flexShrink: 0 });
  (options.parent as { add(child: unknown): void }).add(armsBox);
  const armsReport = options.armsReport ?? (() => loadReport(options.cwd));
  let armsProjected: ArmsPanelProjection = { visible: false, text: "" };
  let armsPaintedKey: string | undefined;
  let modal: HostModalHandle | undefined;
  let projected: DecisionsPanelProjection = { visible: false, text: "" };
  let paintedKey: string | undefined;
  let paints = 0;
  let disposed = false;

  const paint = (force = false): void => {
    if (disposed) return;
    const key = JSON.stringify(projected);
    if (!force && key === paintedKey) return;
    paintedKey = key;
    paints += 1;
    clearTranscriptChildren(box);
    if (!projected.visible) return;
    const [label, ...hint] = projected.text.split(" · ");
    const chunks = [roleChunk(core, "ok", label ?? projected.text), ...(hint.length > 0 ? [dimChunk(core, ` · ${hint.join(" · ")}`)] : [])];
    box.add(
      new core.TextRenderable(r, {
        id: "sb-decisions-row",
        content: new core.StyledText(chunks),
        onMouseDown: () => {
          void show();
        },
      }),
    );
  };

  const paintArms = (force = false): void => {
    if (disposed) return;
    const key = JSON.stringify(armsProjected);
    if (!force && key === armsPaintedKey) return;
    armsPaintedKey = key;
    clearTranscriptChildren(armsBox);
    if (!armsProjected.visible) return;
    const [label, ...hint] = armsProjected.text.split(" · ");
    const chunks = [roleChunk(core, "ok", label ?? armsProjected.text), ...(hint.length > 0 ? [dimChunk(core, ` · ${hint.join(" · ")}`)] : [])];
    armsBox.add(
      new core.TextRenderable(r, {
        id: "sb-decisions-arms-row",
        content: new core.StyledText(chunks),
        onMouseDown: () => {
          void showArms();
        },
      }),
    );
  };

  const openWith = async (open: typeof openDecisions): Promise<HostModalHandle | undefined> => {
    modal?.close({ restoreFocus: false });
    modal = await open(core, chrome, {
      cwd: options.cwd,
      ...(options.onKeypress !== undefined ? { onKeypress: options.onKeypress } : {}),
    });
    return modal;
  };
  const show = (): Promise<HostModalHandle | undefined> => openWith(openDecisions);
  const showArms = (): Promise<HostModalHandle | undefined> => openWith(openDecisionsArms);

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    let n: number;
    try {
      n = await count();
    } catch {
      n = 0;
    }
    let before: number;
    try {
      before = await backfilledTotal();
    } catch {
      before = 0;
    }
    let marked: number;
    try {
      marked = await annotatedTotal();
    } catch {
      marked = 0;
    }
    projected = projectDecisionsPanel(n, options.width, before, marked);
    paint();
    // the arm row reads the report once per poll, and only when the journal holds anything; a failing read hides the row
    try {
      armsProjected = n > 0 ? projectArmsPanel(summarizeArms(await armsReport()), options.width) : { visible: false, text: "" };
    } catch {
      armsProjected = { visible: false, text: "" };
    }
    paintArms();
  };

  const unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "decisions-row",
      () => {
        paint(true);
        paintArms(true);
      },
      () => disposed || isRenderableGone(box),
    ),
  );
  void refresh();
  const stopPoll = (options.interval ?? defaultInterval)(refresh, options.pollMs ?? DECISIONS_POLL_MS);

  return {
    projection: () => projected,
    armsProjection: () => armsProjected,
    paintCount: () => paints,
    show,
    showArms,
    handleCommand(line) {
      if (!isDecisionsCommand(line)) return false;
      const command = parseDecisionsCommand(line);
      if (command.kind === "show") {
        void show();
      } else if (command.kind === "arms") {
        void showArms();
      } else {
        void runDecisionsFollowup(command, { cwd: options.cwd, lastDecisionId: options.lastDecisionId, session: options.session, notice: options.notice }).then(() => refresh());
      }
      return true;
    },
    refresh,
    dispose() {
      disposed = true;
      stopPoll();
      unsubscribeTheme();
      modal?.close({ restoreFocus: false });
    },
  };
}
