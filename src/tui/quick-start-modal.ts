// Flow 492 T11: the `/task` modal. It paints a `QuickStartForm` and forwards its keys; everything
// the plan's state and event matrix decides lives in `quick-start-form.ts`. The modal is one tab,
// keyboard only: Up/Down between fields, Left/Right on the mode, type into a field, Enter to go on
// and, on Start, to send. Escape is the host's: it closes without sending, and the form keeps the
// draft for the next `/task`.
//
// `quickStartLines` is the pure half of the drawing, so what is on screen for each state can be
// asserted without a renderer; `openQuickStart` only turns those lines into renderables.

import { QUICK_MODES, getMode } from "../hub/work/quick-modes";
import { questionsFor } from "../hub/work/clarify";
import { openModal, type ModalHandle } from "./modal-host";
import type { QuickStartFormState, QuickStartForm, QuickStartSlot } from "./quick-start-form";
import { QUICK_START_COMMAND } from "./quick-start-command";
import { getTheme, onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { boldChunk, dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Box = InstanceType<OpenTui["BoxRenderable"]>;

export const QUICK_START_FOOTER = [
  { key: "↑/↓", label: "field" },
  { key: "←/→", label: "mode" },
  { key: "Enter", label: "next / start" },
  { key: "esc", label: "close" },
] as const;

export type LineStyle = "plain" | "bold" | "dim" | "ok" | "attention" | "error";

export interface Segment {
  text: string;
  style: LineStyle;
}

export interface QuickStartLine {
  id: string;
  segments: Segment[];
  /** True on the line(s) of the focused field: highlighted, and kept on screen by the window. */
  focus: boolean;
}

const CURSOR = "▌";
const MIN_WIDTH = 24;
const INDENT = "  ";

/** `text` cut to its last `max` characters, with an ellipsis when it was cut: the end is where typing happens. */
export function tail(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return "…" + chars.slice(chars.length - (max - 1)).join("");
}

/** `text` broken at spaces into lines of at most `width` characters; an overlong word is cut. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((candidate) => candidate.length > 0)) {
    let rest = word;
    while (Array.from(rest).length > width) {
      if (line.length > 0) {
        out.push(line);
        line = "";
      }
      const chars = Array.from(rest);
      out.push(chars.slice(0, width).join(""));
      rest = chars.slice(width).join("");
    }
    if (line.length === 0) line = rest;
    else if (line.length + 1 + rest.length <= width) line += " " + rest;
    else {
      out.push(line);
      line = rest;
    }
  }
  if (line.length > 0) out.push(line);
  return out.length > 0 ? out : [""];
}

const focused = (state: QuickStartFormState, slot: QuickStartSlot): boolean => state.phase === "editing" && state.focus === slot;

function field(state: QuickStartFormState, slot: QuickStartSlot, value: string, width: number, empty: string): Segment[] {
  const isFocus = focused(state, slot);
  if (value.length === 0 && !isFocus) return [{ text: `${INDENT}${empty}`, style: "dim" }];
  const room = Math.max(8, width - INDENT.length - 3);
  return [
    { text: `${INDENT}> `, style: "dim" },
    { text: tail(value, room) + (isFocus ? CURSOR : ""), style: "plain" },
  ];
}

/** Everything on screen for one form state, top to bottom. */
export function quickStartLines(state: QuickStartFormState, width: number): QuickStartLine[] {
  const w = Math.max(MIN_WIDTH, width);
  const lines: QuickStartLine[] = [];
  const add = (id: string, segments: Segment[], focus = false): void => {
    lines.push({ id, segments, focus });
  };

  const mode = getMode(state.mode);
  const modeSegments: Segment[] = [{ text: "Mode  ", style: "bold" }];
  for (const candidate of QUICK_MODES) {
    const chosen = candidate.id === state.mode;
    modeSegments.push({ text: chosen ? `[${candidate.label}]` : ` ${candidate.label} `, style: chosen ? "ok" : "plain" });
    modeSegments.push({ text: " ", style: "plain" });
  }
  add("mode", modeSegments, focused(state, "mode"));
  add("mode-info", [
    { text: `${INDENT}${mode.reviewDepth} review, ${mode.criteriaTemplate.length} starting criteria`, style: "dim" },
  ]);
  add("gap-1", []);

  add("description-label", [{ text: "What needs doing?", style: "bold" }, { text: " (required)", style: "dim" }]);
  add("description", field(state, "description", state.description, w, "(type the task)"), focused(state, "description"));
  add("gap-2", []);

  add("questions-label", [{ text: "Questions", style: "bold" }, { text: " (leave blank to skip)", style: "dim" }]);
  for (const question of state.questions) {
    const slot: QuickStartSlot = `question:${question.id}`;
    const focus = focused(state, slot);
    add(`q-${question.id}`, [{ text: question.text, style: focus ? "bold" : "plain" }]);
    add(`a-${question.id}`, field(state, slot, state.answers[question.id] ?? "", w, "(skipped)"), focus);
  }
  add("gap-3", []);

  add("criteria-label", [{ text: "Your own criteria", style: "bold" }, { text: " (separate with ;)", style: "dim" }]);
  add("criteria", field(state, "criteria", state.criteria, w, "(none: the template criteria apply)"), focused(state, "criteria"));
  add("gap-4", []);

  if (state.phase === "submitting") {
    add("start", [{ text: "[ Sending... ]", style: "attention" }]);
  } else if (state.phase === "done") {
    add("start", [{ text: "[ Started ]", style: "ok" }]);
  } else if (state.canSubmit) {
    add("start", [{ text: "[ Start ]", style: "ok" }], focused(state, "submit"));
  } else {
    add("start", [{ text: "[ Start ]", style: "dim" }, { text: " describe the task first", style: "dim" }], focused(state, "submit"));
  }

  if (state.error !== undefined) {
    add("gap-5", []);
    wrapText(state.error.message, w - 2).forEach((text, index) => {
      add(`error-${index}`, [{ text, style: "error" }]);
    });
  }
  return lines;
}

/** The slice of `lines` that fits `budget` rows and keeps the focused line (plus one below it) on screen. */
export function windowLines(lines: readonly QuickStartLine[], budget: number): QuickStartLine[] {
  if (budget <= 0 || lines.length <= budget) return [...lines];
  let focusAt = lines.reduce((last, line, index) => (line.focus ? index : last), -1);
  if (focusAt < 0) focusAt = 0;
  const wanted = Math.min(lines.length - 1, focusAt + 1);
  const start = Math.max(0, Math.min(lines.length - budget, wanted - budget + 1));
  return lines.slice(start, start + budget);
}

export interface QuickStartModalOptions {
  form: QuickStartForm;
  renderer: unknown;
  /** Called once when the modal has closed, by Escape, by the host or after an accepted request. */
  onClosed?: () => void;
}

export function openQuickStart(otui: unknown, chrome: unknown, options: QuickStartModalOptions): ModalHandle | undefined {
  const core = otui as OpenTui;
  const r = options.renderer as ConstructorParameters<OpenTui["TextRenderable"]>[0];
  const { form } = options;

  let body: Box | undefined;
  let width = 80;
  let budget = Number.MAX_SAFE_INTEGER;
  let blocks: Box[] = [];
  let closed = false;
  let unsubscribeForm: () => void = () => {};
  let unsubscribeTheme: () => void = () => {};

  const chunkFor = (segment: Segment) => {
    if (segment.style === "bold") return boldChunk(core, segment.text);
    if (segment.style === "dim") return dimChunk(core, segment.text);
    if (segment.style === "plain") return roleChunk(core, "text", segment.text);
    return roleChunk(core, segment.style, segment.text);
  };

  function paint(): void {
    if (closed || body === undefined) return;
    for (const block of blocks) {
      try {
        body.remove(block);
      } catch {
        // already detached
      }
    }
    blocks = [];
    const visible = windowLines(quickStartLines(form.state(), width), budget);
    visible.forEach((line, index) => {
      const box = new core.BoxRenderable(r, {
        id: `qs-${line.id}-${index}`,
        width: "100%",
        flexDirection: "row",
        ...(line.focus ? { backgroundColor: getTheme().highlight } : {}),
      });
      const chunks = line.segments.length > 0 ? line.segments.map(chunkFor) : [roleChunk(core, "text", " ")];
      box.add(new core.TextRenderable(r, { id: `qs-${line.id}-${index}-text`, content: new core.StyledText(chunks) }));
      body!.add(box);
      blocks.push(box);
    });
  }

  const sample = form.state();
  // The tallest form: the mode with the most questions, plus a long error.
  const tallest = QUICK_MODES.reduce((best, mode) => (questionsFor(mode.id).length > questionsFor(best.id).length ? mode : best));
  const contentRows = quickStartLines(
    { ...sample, mode: tallest.id, questions: questionsFor(tallest.id), error: { kind: "network", message: "x ".repeat(80), retry: true } },
    80,
  ).length;

  const handle: ModalHandle | undefined = openModal(core, chrome as never, {
    title: QUICK_START_COMMAND,
    tabs: [{ id: "task", label: "New task" }],
    footer: QUICK_START_FOOTER,
    contentRows,
    claimKey: (key) => form.handleKey(key),
    renderTab: (_tabId, tabBody, ctx) => {
      body = tabBody as Box;
      width = ctx.width;
      budget = ctx.height;
      blocks = [];
      paint();
    },
    onClose: () => {
      closed = true;
      unsubscribeForm();
      unsubscribeTheme();
      options.onClosed?.();
    },
  });
  if (handle === undefined) return undefined;

  unsubscribeForm = form.subscribe(() => {
    paint();
    if (form.state().phase === "done") handle?.close();
  });
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "quick-start-modal",
      paint,
      () => closed || isRenderableGone(body) || (r as { isDestroyed?: boolean }).isDestroyed === true,
    ),
  );
  return handle;
}
