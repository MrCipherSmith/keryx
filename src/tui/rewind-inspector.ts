// The `/rewind` modal: this session's per-turn snapshots (newest first) with
// time, prompt excerpt and number of files the turn changed; pick one, choose
// files only / history only / both, confirm, apply. Same modal-host shape as
// `turn-guard-inspector.ts`; the recorder and the session store do the work
// behind the injected `listings` / `apply` callbacks.

import type { RewindMode } from "../rewind/apply";
import { availableRewindModes, excerpt, formatRewindConfirmLines, formatRewindListLines, MODE_LABELS } from "../rewind/format";
import type { RewindListing } from "../rewind/recorder";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const REWIND_COMMAND = "/rewind";

export type { RewindMode };
export { availableRewindModes, formatRewindConfirmLines, formatRewindListLines };

export interface RewindApplyResult {
  ok: boolean;
  lines: string[];
}

export function isRewindCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === REWIND_COMMAND;
}

export const REWIND_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "select" },
  { key: "y", label: "apply" },
  { key: "esc", label: "close" },
] as const;

// Letters, not digits: the modal host reserves 1-9 for tab jumps.
const MODE_KEYS: Record<RewindMode, string> = { files: "f", history: "h", both: "b" };

export function formatRewindModeLines(entry: RewindListing, cursor: number): string[] {
  const modes = availableRewindModes(entry);
  const lines = [`Rewind to the start of: ${excerpt(entry.prompt, 60)}`, "", "What should be rolled back?", ""];
  modes.forEach((mode, index) => {
    lines.push(`${index === cursor ? ">" : " "} ${MODE_KEYS[mode]}  ${MODE_LABELS[mode]}`);
  });
  if (modes.length === 1) lines.push("", "History is not available for an undo point.");
  return lines;
}

export interface RewindModalOptions {
  listings: () => Promise<readonly RewindListing[]>;
  apply: (input: { seq: number; mode: RewindMode }) => Promise<RewindApplyResult>;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
}

export interface RewindModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
}

type Stage = "list" | "mode" | "confirm" | "applying" | "result";

export function openRewind(otui: unknown, chrome: unknown, options: RewindModalOptions): RewindModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let entries: readonly RewindListing[] = [];
  let loaded = false;
  let selected = 0;
  let listScroll = 0;
    let stage: Stage = "list";
  let modeCursor = 0;
  let mode: RewindMode = "files";
  let resultLines: string[] = [];
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};

  const current = (): RewindListing | undefined => entries[selected];
  const listLines = (): string[] => (loaded ? formatRewindListLines(entries, selected) : ["Loading snapshots…"]);
  const stageLines = (): string[] => {
    const entry = current();
    if (stage === "list" || entry === undefined) return listLines();
    if (stage === "mode") return formatRewindModeLines(entry, modeCursor);
    if (stage === "confirm") return formatRewindConfirmLines(entry, mode);
    if (stage === "applying") return ["Rewinding…"];
    return resultLines;
  };
  const wrapped = (): string[] => wrapLines(stageLines().join("\n"), width).split("\n");
  const visible = (): string[] => windowLines(wrapped(), stage === "list" ? listScroll : 0, bodyRows);
  const paint = (): void => {
    if (closed) return;
    listScroll = clampScroll(scrollToReveal(selected, listScroll, bodyRows), wrapped().length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };
  const reload = (): void => {
    void options.listings().then(
      (next) => {
        entries = next;
        loaded = true;
        selected = Math.min(selected, Math.max(0, entries.length - 1));
        paint();
      },
      () => {
        loaded = true;
        paint();
      },
    );
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: REWIND_COMMAND,
    tabs: [{ id: "turns", label: "Turns" }],
    footer: REWIND_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "rewind-body", content: "" }) as never;
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
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "rewind-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );
  reload();

  const startApply = (entry: RewindListing): void => {
    stage = "applying";
    void options.apply({ seq: entry.seq, mode }).then(
      (result) => {
        stage = "result";
        resultLines = [...result.lines, "", "enter  back to the list"];
        reload();
      },
      (error: unknown) => {
        stage = "result";
        resultLines = [`Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "", "enter  back to the list"];
      },
    ).finally(paint);
    paint();
  };

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    const entry = current();
    const step = (delta: number, limit: number, value: number): number => Math.min(Math.max(0, limit), Math.max(0, value + delta));
    if (stage === "list") {
      if (token === "up" || token === "k") selected = step(-1, entries.length - 1, selected);
      else if (token === "down" || token === "j") selected = step(1, entries.length - 1, selected);
      else if ((token === "return" || token === "enter") && entry !== undefined) {
        modeCursor = 0;
        const modes = availableRewindModes(entry);
        if (modes.length === 1) {
          mode = modes[0]!;
          stage = "confirm";
        } else stage = "mode";
      } else return;
      paint();
      return;
    }
    if (entry === undefined || stage === "applying") return;
    const modes = availableRewindModes(entry);
    if (stage === "mode") {
      const chosen = modes.find((candidate) => MODE_KEYS[candidate] === token);
      if (token === "up" || token === "k") modeCursor = step(-1, modes.length - 1, modeCursor);
      else if (token === "down" || token === "j") modeCursor = step(1, modes.length - 1, modeCursor);
      else if (token === "return" || token === "enter") {
        mode = modes[modeCursor] ?? "files";
        stage = "confirm";
      } else if (chosen !== undefined) {
        mode = chosen;
        stage = "confirm";
      } else if (token === "backspace" || token === "n") stage = "list";
      else return;
    } else if (stage === "confirm") {
      if (token === "y") {
        startApply(entry);
        return;
      }
      if (token !== "n" && token !== "backspace") return;
      stage = modes.length === 1 ? "list" : "mode";
    } else if (token === "return" || token === "enter") stage = "list";
    else return;
    paint();
  });

  return { ...modal, visibleLines: visible };
}
