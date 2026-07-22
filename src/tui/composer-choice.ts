// Composer-anchored choice menus (Claude Code / OpenCode style).
//
// Permissions, wiki-enrich plans, and agent `ask_user` questions share one UI:
// a Select list with label + description, docked above the input (not in the
// transcript). Esc returns cancelId. Recommended options are marked in the label
// and pre-selected.

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

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;

type KeypressEvent = {
  name: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function selectBoxHeight(count: number, withDescription: boolean): number {
  const per = withDescription ? 2 : 1;
  return Math.min(Math.max(count * per, per), 16);
}

function onKeypress(r: Renderer, handler: (key: KeypressEvent) => void): () => void {
  // Same private API used by tui-shell overlays.
  (r as { _internalKeyInput: { onInternal: (e: string, h: (k: KeypressEvent) => void) => void; offInternal: (e: string, h: (k: KeypressEvent) => void) => void } })._internalKeyInput.onInternal(
    "keypress",
    handler,
  );
  return () =>
    (r as { _internalKeyInput: { offInternal: (e: string, h: (k: KeypressEvent) => void) => void } })._internalKeyInput.offInternal(
      "keypress",
      handler,
    );
}

/**
 * Show an interactive choice menu inside `dock` (placed above the composer in
 * the main column, same band as the `/` command dropdown). Resolves the chosen
 * option id, or `cancelId` on Esc.
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
    const selectedIndex = recommendedIdx >= 0 ? recommendedIdx : 0;

    dock.visible = true;

    const title = new otui.TextRenderable(r, {
      id: `ch-title-${Date.now()}`,
      content: otui.t`${otui.bold(request.title)} ${otui.dim("↑/↓ Enter · Esc")}`,
    });
    dock.add(title);

    let subtitle: InstanceType<OpenTui["TextRenderable"]> | undefined;
    if (request.subtitle !== undefined && request.subtitle.length > 0) {
      subtitle = new otui.TextRenderable(r, {
        id: `ch-sub-${Date.now()}`,
        content: otui.t`${otui.yellow(request.subtitle)}`,
      });
      dock.add(subtitle);
    }

    const sel = new otui.SelectRenderable(r, {
      id: `ch-sel-${Date.now()}`,
      width: "100%",
      height: selectBoxHeight(options.length, true),
      showScrollIndicator: options.length > 6,
      showDescription: true,
      showSelectionIndicator: true,
      wrapSelection: true,
      selectedIndex,
      backgroundColor: "#0f1b1b",
      focusedBackgroundColor: "#0f1b1b",
      selectedBackgroundColor: "#22333b",
      textColor: "#c8d0d0",
      focusedTextColor: "#c8d0d0",
      selectedTextColor: "#ffd166",
      descriptionColor: "#6b7a7a",
      selectedDescriptionColor: "#8b9a9a",
      options: options.map((o) => ({
        name: o.displayLabel,
        description: o.description.length > 0 ? o.description : " ",
        value: o.id,
      })),
    });
    dock.add(sel);
    sel.focus();

    // Late-arriving advisory context. It is mounted ABOVE the options (so the
    // command stays the first thing read) but AFTER the menu is already usable.
    let closed = false;
    const contextLines: InstanceType<OpenTui["TextRenderable"]>[] = [];
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
          dock.insertBefore(renderable, sel);
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

    const cleanup = (): void => {
      closed = true;
      unsub();
      try {
        dock.remove(title);
        if (subtitle !== undefined) {
          dock.remove(subtitle);
        }
        for (const line of contextLines) {
          dock.remove(line);
        }
        dock.remove(sel);
      } catch {
        // best-effort
      }
      dock.visible = false;
    };

    const finish = (id: string): void => {
      cleanup();
      resolve(id);
    };

    const onKey = (key: KeypressEvent): void => {
      if (key.name === "escape") {
        finish(request.cancelId);
        key.preventDefault();
        key.stopPropagation();
      }
    };
    const unsub = onKeypress(r, onKey);

    sel.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = sel.getSelectedOption();
      const value = chosen?.value;
      if (typeof value === "string" && value.length > 0) {
        finish(value);
        return;
      }
      // Fallback: match display label if value is missing.
      const match = options.find((o) => o.displayLabel === chosen?.name);
      finish(match?.id ?? request.cancelId);
    });
  });
}
