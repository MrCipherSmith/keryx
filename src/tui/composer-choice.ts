// Composer-anchored choice menus (Claude Code / OpenCode style).
//
// Permissions, wiki-enrich plans, and agent `ask_user` questions share one UI:
// a mouse+keyboard option list with label + description, docked above the
// input (not in the transcript). Esc returns cancelId. Recommended options are
// marked in the label and pre-selected.

/** One selectable answer. */
export interface ChoiceOption {
  id: string;
  label: string;
  description: string;
  /** When true, label is prefixed with "(Recommended)" and pre-selected. */
  recommended?: boolean;
}

/** Request shown in the composer-dock choice menu. */
export interface ComposerChoiceRequest {
  title: string;
  subtitle?: string;
  /**
   * Short advisory context (one renderable per line) mounted between subtitle and
   * options WHEN IT RESOLVES — the menu is interactive from the first frame, so a
   * slow lookup can never delay the decision. A rejected promise, an empty string,
   * or a resolution that arrives after the menu closed simply shows nothing: the
   * context is advisory and must never gate, alter, or delay an answer.
   */
  context?: Promise<string>;
  options: ChoiceOption[];
  /** Returned when the user presses Esc. */
  cancelId: string;
}

import { getTheme } from "./theme";
import { containsNode } from "./modal-host";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;
type ScrollBox = InstanceType<OpenTui["ScrollBoxRenderable"]>;

type KeypressEvent = {
  name: string;
  ctrl: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Defensive cap on the subtitle (command/code preview) text — bounds a
 * pathologically large model-proposed command before it ever reaches the
 * renderer, mirroring `MAX_CHILD_SUMMARY_CHARS`'s bound-everything-that-reaches-
 * a-renderer convention elsewhere in this codebase.
 */
const MAX_SUBTITLE_CHARS = 8_000;

/** Visible rows for the scrollable command/code preview before it scrolls. */
const MAX_SUBTITLE_ROWS = 10;

/**
 * A single-line subtitle at or under this length renders as a plain,
 * non-interactive line — same as before the scrollable-preview rewrite.
 * Only a genuinely multi-line or long subtitle (a real command/code preview,
 * not a short hint like "Esc = new session") gets the ctrl+o-focusable
 * scroll box; otherwise every dialog with any subtitle at all — including
 * ones that never needed it — stole ctrl+o and confused arrow-key nav for no
 * reason.
 */
const SUBTITLE_INLINE_MAX_CHARS = 76;

/** Rows per option (label + description) — mirrors the old `SelectRenderable` layout. */
const OPTION_ROWS = 2;

/** Visible rows for the options list before it scrolls — matches the old `SelectRenderable` cap. */
const MAX_OPTIONS_ROWS = 16;

function onKeypress(r: Renderer, handler: (key: KeypressEvent) => void): () => void {
  (r as unknown as { _internalKeyInput: { onInternal: (e: string, h: (k: KeypressEvent) => void) => void } })._internalKeyInput.onInternal(
    "keypress",
    handler,
  );
  return () =>
    (r as unknown as { _internalKeyInput: { offInternal: (e: string, h: (k: KeypressEvent) => void) => void } })._internalKeyInput.offInternal(
      "keypress",
      handler,
    );
}

/**
 * Show an interactive choice menu inside `dock` (placed above the composer in
 * the main column, same band as the `/` command dropdown). Resolves the chosen
 * option id, or `cancelId` on Esc. Options are a manually painted list (not
 * OpenTUI's `SelectRenderable`) so each row can be clicked directly — the
 * native `SelectRenderable` has no per-item mouse routing, only keyboard.
 */
export function showComposerChoice(
  otui: OpenTui,
  r: Renderer,
  dock: Box,
  request: ComposerChoiceRequest,
): Promise<string> {
  return new Promise((resolve) => {
    const options = request.options.map((o) => ({
      ...o,
      displayLabel: o.recommended === true ? `(Recommended) ${o.label}` : o.label,
    }));

    const recommendedIdx = options.findIndex((o) => o.recommended === true);
    let selected = recommendedIdx >= 0 ? recommendedIdx : 0;

    dock.visible = true;
    const theme = getTheme();

    const rawSubtitle = request.subtitle !== undefined && request.subtitle.length > 0 ? request.subtitle : undefined;
    const subtitleText =
      rawSubtitle !== undefined && rawSubtitle.length > MAX_SUBTITLE_CHARS
        ? `${rawSubtitle.slice(0, MAX_SUBTITLE_CHARS)}\n…(truncated: ${rawSubtitle.length - MAX_SUBTITLE_CHARS} more characters)`
        : rawSubtitle;
    const subtitleLines = subtitleText?.split("\n") ?? [];
    const hasScrollableSubtitle =
      subtitleLines.length > 1 || (subtitleLines[0]?.length ?? 0) > SUBTITLE_INLINE_MAX_CHARS;
    const subtitleRows = Math.min(Math.max(subtitleLines.length, 1), MAX_SUBTITLE_ROWS);

    const title = new otui.TextRenderable(r, {
      id: `ch-title-${Date.now()}`,
      content: otui.t`${otui.bold(request.title)} ${otui.dim(hasScrollableSubtitle ? "↑/↓ Enter · Esc · ctrl+o scroll cmd" : "↑/↓ Enter · Esc")}`,
    });
    dock.add(title);

    let subtitleScroll: ScrollBox | undefined;
    let subtitleLine: Text | undefined;
    if (hasScrollableSubtitle) {
      subtitleScroll = new otui.ScrollBoxRenderable(r, {
        id: `ch-sub-scroll-${Date.now()}`,
        width: "100%",
        height: subtitleRows,
        scrollY: true,
        contentOptions: { flexDirection: "column" },
      });
      for (const [i, line] of subtitleLines.entries()) {
        subtitleScroll.content.add(
          new otui.TextRenderable(r, {
            id: `ch-sub-line-${i}-${Date.now()}`,
            content: otui.t`${otui.yellow(line)}`,
          }),
        );
      }
      dock.add(subtitleScroll);
    } else if (subtitleLines.length > 0) {
      // Trivial one-liner: a plain, non-interactive line — no scroll box, no
      // ctrl+o hint, exactly the pre-rewrite behavior for short subtitles.
      subtitleLine = new otui.TextRenderable(r, {
        id: `ch-sub-${Date.now()}`,
        content: otui.t`${otui.yellow(subtitleLines[0] ?? "")}`,
      });
      dock.add(subtitleLine);
    }

    const optionsRows = options.length * OPTION_ROWS;
    const optionsScroll = new otui.ScrollBoxRenderable(r, {
      id: `ch-opts-scroll-${Date.now()}`,
      width: "100%",
      height: Math.min(Math.max(optionsRows, OPTION_ROWS), MAX_OPTIONS_ROWS),
      scrollY: true,
      contentOptions: { flexDirection: "column" },
    });
    dock.add(optionsScroll);
    const optionsBox = optionsScroll.content;

    const rows: { id: string; box: Box; label: Text; desc: Text }[] = [];
    const paintOptions = (): void => {
      for (const [i, o] of options.entries()) {
        const row = rows[i];
        if (row === undefined) {
          continue;
        }
        const active = i === selected;
        row.box.backgroundColor = active ? theme.highlight : undefined;
        row.label.fg = active ? theme.focus : theme.text;
        row.label.content = active ? otui.t`${otui.bold(o.displayLabel)}` : o.displayLabel;
        row.desc.content = otui.t`${otui.dim(o.description.length > 0 ? o.description : " ")}`;
        if (active) {
          // Keyboard nav (↑/↓) must keep the highlighted row on-screen once
          // the list is taller than `MAX_OPTIONS_ROWS` — a mouse click never
          // needs this since the row is already visible to be clicked.
          optionsScroll.scrollChildIntoView(row.id);
        }
      }
    };

    const finish = (id: string): void => {
      cleanup();
      resolve(id);
    };

    for (const [i, o] of options.entries()) {
      const rowId = `ch-opt-${i}-${Date.now()}`;
      const box = new otui.BoxRenderable(r, {
        id: rowId,
        width: "100%",
        flexDirection: "column",
        onMouseDown: () => {
          finish(o.id);
        },
      });
      const label = new otui.TextRenderable(r, { id: `ch-opt-l-${i}-${Date.now()}`, content: o.displayLabel });
      const desc = new otui.TextRenderable(r, {
        id: `ch-opt-d-${i}-${Date.now()}`,
        content: otui.t`${otui.dim(o.description.length > 0 ? o.description : " ")}`,
      });
      box.add(label);
      box.add(desc);
      optionsBox.add(box);
      rows.push({ id: rowId, box, label, desc });
    }
    paintOptions();

    // Late-arriving advisory context. It is mounted ABOVE the options (so the
    // command stays the first thing read) but AFTER the menu is already usable.
    let closed = false;
    const contextLines: Text[] = [];
    const mountContext = (text: string): void => {
      if (closed || contextLines.length > 0) {
        return;
      }
      const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      for (const [i, line] of lines.entries()) {
        const renderable = new otui.TextRenderable(r, {
          id: `ch-ctx-${i}-${Date.now()}`,
          content: otui.t`${otui.dim(line)}`,
        });
        contextLines.push(renderable);
        try {
          dock.insertBefore(renderable, optionsScroll);
        } catch {
          dock.add(renderable); // best-effort: still visible, just below the options
        }
      }
    };
    if (request.context !== undefined) {
      void request.context.then(mountContext).catch(() => {
        // Advisory only: a failed lookup shows no context and no error.
      });
    }

    function cleanup(): void {
      closed = true;
      unsub();
      try {
        dock.remove(title);
        if (subtitleScroll !== undefined) {
          dock.remove(subtitleScroll);
        }
        if (subtitleLine !== undefined) {
          dock.remove(subtitleLine);
        }
        for (const line of contextLines) {
          dock.remove(line);
        }
        dock.remove(optionsScroll);
      } catch {
        // best-effort
      }
      dock.visible = false;
    }

    const onKey = (key: KeypressEvent): void => {
      if (key.name === "escape") {
        finish(request.cancelId);
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (subtitleScroll !== undefined && key.ctrl && key.name === "o") {
        const focused = r.currentFocusedRenderable;
        const inScroll = focused !== null && containsNode(subtitleScroll, focused);
        if (inScroll) {
          optionsScroll.focus();
        } else {
          subtitleScroll.focus();
        }
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      const focused = r.currentFocusedRenderable;
      const inScroll = subtitleScroll !== undefined && focused !== null && containsNode(subtitleScroll, focused);
      if (inScroll) {
        // Arrow keys / PageUp / PageDown fall through to the scroll box's own
        // native `handleKeyPress` — nothing to do here.
        return;
      }
      if (key.name === "up") {
        selected = selected > 0 ? selected - 1 : options.length - 1;
        paintOptions();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "down") {
        selected = selected < options.length - 1 ? selected + 1 : 0;
        paintOptions();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
        const chosen = options[selected];
        if (chosen !== undefined) {
          finish(chosen.id);
        }
        key.preventDefault();
        key.stopPropagation();
      }
    };
    const unsub = onKeypress(r, onKey);
    optionsScroll.focus();
  });
}
