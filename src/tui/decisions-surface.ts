// `/decisions` (flow 392, AC8): the TUI half of `keryx decisions report`. A
// read-only modal over the same lines the CLI prints (`reportText`, never a second
// formatter), a sidebar row `sb-decisions` that is present only once the journal
// holds a decision, and the shell routing for the command.
//
// Opening it never writes: it reads the journal and refuses nothing.

import { findAgentCommand } from "../commands/agent-commands";
import { annotatedCount, backfilledCount, changeAnswer, decisionCount, giveReason, oneLine, reportText, resolveFlowContext } from "../decisions/service";
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
  | { kind: "change"; choice: string };

/**
 * `/decisions` opens the report; `/decisions reason <why>` adds the one optional
 * reason to the latest answered question, and `/decisions change <option>` changes
 * its answer (after a blind reveal, say). Neither follow-up ever holds a question.
 */
export function parseDecisionsCommand(line: string): DecisionsCommand {
  const [, sub, ...rest] = line.trim().split(/\s+/);
  const tail = rest.join(" ").trim();
  if (sub === "reason") return { kind: "reason", text: tail };
  if (sub === "change") return { kind: "change", choice: tail };
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
export async function runDecisionsFollowup(command: Exclude<DecisionsCommand, { kind: "show" }>, deps: DecisionsFollowupDeps): Promise<void> {
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

/** The report body as modal lines: exactly what `keryx decisions report` prints. */
export function formatDecisionsLines(text: string): string[] {
  return text.split("\n");
}

export type PresentDecisionsOptions = {
  text: string;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
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
    tabs: [{ id: "report", label: "Recommendations" }],
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
  /** Test seam: how many live decisions carry the operator's own text or a typed reason. */
  annotated?: () => Promise<number>;
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
}

export interface DecisionsSidebar {
  projection(): DecisionsPanelProjection;
  paintCount(): number;
  show(): Promise<HostModalHandle | undefined>;
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

  const show = async (): Promise<HostModalHandle | undefined> => {
    modal?.close({ restoreFocus: false });
    modal = await openDecisions(core, chrome, {
      cwd: options.cwd,
      ...(options.onKeypress !== undefined ? { onKeypress: options.onKeypress } : {}),
    });
    return modal;
  };

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
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("decisions-row", () => paint(true), () => disposed || isRenderableGone(box)));
  void refresh();
  const stopPoll = (options.interval ?? defaultInterval)(refresh, options.pollMs ?? DECISIONS_POLL_MS);

  return {
    projection: () => projected,
    paintCount: () => paints,
    show,
    handleCommand(line) {
      if (!isDecisionsCommand(line)) return false;
      const command = parseDecisionsCommand(line);
      if (command.kind === "show") {
        void show();
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
