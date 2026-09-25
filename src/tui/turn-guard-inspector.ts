// Flow 329 (AC4): the `/guard` modal — this session's turn-guard history
// (most recent first), each entry's facts, Jev's probabilities (when asked)
// and the reason, plus whether the guard is currently on or off. Read-only:
// unlike `/ci`'s `t`/`r` (triage on demand), the guard already ran after each
// turn settled — there is nothing left to trigger from here. Same list+detail
// shape `ci-triage-inspector.ts`/`conform-inspector.ts` established, trimmed
// to what a read-only history view needs.

import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { renderTurnGuardAdvisory } from "../review/turn-guard";
import type { TurnGuardResult } from "./turn-guard-source";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const TURN_GUARD_COMMAND = "/guard";

export function isTurnGuardCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === TURN_GUARD_COMMAND;
}

export const TURN_GUARD_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "detail" },
  { key: "esc", label: "close" },
] as const;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function statusSummary(result: TurnGuardResult): string {
  if (result.skipped) return `skipped (${result.skipReason ?? result.verdict.reason})`;
  if (result.verdict.flagged) {
    const parts: string[] = [];
    if (result.verdict.doneProbability !== undefined) parts.push(`done ${pct(result.verdict.doneProbability)}`);
    if (result.verdict.contradictionProbability !== undefined) parts.push(`contradiction ${pct(result.verdict.contradictionProbability)}`);
    return `FLAGGED${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
  }
  return "looks done";
}

/** One line per history entry, newest first — `history[0]` is the most recent turn. */
export function formatTurnGuardListLines(history: readonly TurnGuardResult[], selected: number): string[] {
  if (history.length === 0) {
    return ["No turns guarded yet this session."];
  }
  return history.map((result, index) => {
    const mark = index === selected ? ">" : " ";
    const when = new Date(result.at).toLocaleTimeString();
    const request = result.userRequest.replace(/\s+/g, " ").trim();
    const short = request.length > 48 ? `${request.slice(0, 45)}…` : request;
    return `${mark} ${when}  ${short.length > 0 ? short : "(empty request)"}  —  ${statusSummary(result)}`;
  });
}

export function formatTurnGuardDetailLines(result: TurnGuardResult | undefined): string[] {
  if (result === undefined) return ["No turn selected."];
  return renderTurnGuardAdvisory({ verdict: result.verdict, facts: result.facts, ...(result.usage !== undefined ? { usage: result.usage } : {}) }).split(
    "\n",
  );
}

export interface TurnGuardModalOptions {
  /** A live view of this session's history — read fresh each paint, newest first. */
  history: () => readonly TurnGuardResult[];
  /** Whether the guard is currently on for this session — shown in the header. */
  enabled: () => boolean;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
}

export interface TurnGuardModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
  selected(): TurnGuardResult | undefined;
}

export function openTurnGuard(otui: unknown, chrome: unknown, options: TurnGuardModalOptions): TurnGuardModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const selectedResult = (): TurnGuardResult | undefined => options.history()[selected];
  const activeTab = (): string => host.handle?.activeTab() ?? "list";
  const listLines = (): string[] => {
    const header = `guard: ${options.enabled() ? "on" : "off"} — /guard on|off to change`;
    return [header, "", ...formatTurnGuardListLines(options.history(), selected)];
  };
  const detailLines = (): string[] => wrapLines(formatTurnGuardDetailLines(selectedResult()).join("\n"), width).split("\n");
  const visible = (): string[] =>
    activeTab() === "detail" ? windowLines(detailLines(), detailScroll, bodyRows) : windowLines(listLines(), listScroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    listScroll = clampScroll(scrollToReveal(selected + 2, listScroll, bodyRows), listLines().length, bodyRows);
    detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: TURN_GUARD_COMMAND,
    tabs: [
      { id: "list", label: "History" },
      { id: "detail", label: "Detail" },
    ],
    footer: TURN_GUARD_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "turn-guard-body", content: "" }) as never;
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
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "turn-guard-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    const onDetail = modal.activeTab() === "detail";
    const move = (next: number): void => {
      const clamped = Math.min(Math.max(0, options.history().length - 1), Math.max(0, next));
      if (clamped !== selected) {
        selected = clamped;
        detailScroll = 0;
      }
    };
    if (token === "return" || token === "enter") {
      modal.setTab("detail");
    } else if (token === "up" || token === "k") {
      if (onDetail) detailScroll = clampScroll(detailScroll - 1, detailLines().length, bodyRows);
      else move(selected - 1);
    } else if (token === "down" || token === "j") {
      if (onDetail) detailScroll = clampScroll(detailScroll + 1, detailLines().length, bodyRows);
      else move(selected + 1);
    } else if (onDetail && (token === "pageup" || token === "pagedown")) {
      detailScroll = clampScroll(detailScroll + (token === "pageup" ? -bodyRows : bodyRows), detailLines().length, bodyRows);
    } else {
      return;
    }
    paint();
  });

  return { ...modal, visibleLines: visible, selected: selectedResult };
}
