// Theme picker modal: 1/4 list + 3/4 live preview. The live palette does not
// change until the operator submits — Esc / close leaves the current theme.
// OpenTUI is a parameter (ADR-0005); this file never statically imports it.
import { openModal } from "./modal-host";
import { markdownToChunks } from "./transcript-blocks";
import {
  THEME_IDS,
  getTheme,
  resolveTheme,
  themeLabel,
  type Theme,
  type ThemeId,
  type ThemeMode,
} from "./theme";

export function isThemeCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === "/theme";
}

export const THEME_PICKER_FOOTER = [
  { key: "↑/↓", label: "select" },
  { key: "enter", label: "apply" },
  { key: "esc", label: "cancel" },
] as const;

export const THEME_PREVIEW_MARKDOWN = [
  "## Assistant",
  "Switch palettes **without applying** until Submit.",
  "",
  "- one item in the list",
  "- `inline code` stays muted",
].join("\n");

export const THEME_PREVIEW_CODE = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`;",
  "}",
].join("\n");

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (
  otui: unknown,
  chrome: unknown,
  input: OpenModalInput,
) => ModalHandle | undefined;

export type PresentThemePickerOptions = {
  current: ThemeId;
  mode?: ThemeMode | null;
  onApply: (id: ThemeId) => void;
  renderer?: unknown;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

type BoxLike = {
  add: (child: unknown) => void;
  remove: (child: unknown) => void;
  getChildren: () => unknown[];
  backgroundColor?: unknown;
  borderColor?: unknown;
};

type OtuiLike = {
  BoxRenderable: new (renderer: unknown, opts: Record<string, unknown>) => BoxLike;
  TextRenderable: new (renderer: unknown, opts: Record<string, unknown>) => unknown;
  StyledText?: new (chunks: unknown) => unknown;
  stringToStyledText?: (s: string) => { chunks: unknown };
  t?: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  bold?: (s: unknown) => unknown;
  dim?: (s: unknown) => unknown;
};

function asOtui(otui: unknown): OtuiLike | undefined {
  if (otui === undefined || otui === null) {
    return undefined;
  }
  const cand = otui as Partial<OtuiLike>;
  if (cand.BoxRenderable === undefined || cand.TextRenderable === undefined) {
    return undefined;
  }
  return cand as OtuiLike;
}

function clearChildren(box: BoxLike): void {
  for (const child of [...box.getChildren()]) {
    box.remove(child);
  }
}

export function formatThemePickerRows(
  selected: ThemeId,
  current: ThemeId,
  ids: readonly ThemeId[] = THEME_IDS,
): string[] {
  return ids.map((id) => {
    const cursor = id === selected ? ">" : " ";
    const mark = id === current ? "*" : " ";
    return `${cursor}${mark} ${themeLabel(id)}`;
  });
}

export function moveThemeSelection(
  selected: ThemeId,
  delta: number,
  ids: readonly ThemeId[] = THEME_IDS,
): ThemeId {
  if (ids.length === 0) {
    return selected;
  }
  const idx = ids.indexOf(selected);
  const from = idx < 0 ? 0 : idx;
  const next = Math.max(0, Math.min(ids.length - 1, from + delta));
  return ids[next] ?? selected;
}

function addText(
  otui: OtuiLike,
  renderer: unknown,
  parent: BoxLike,
  opts: { id: string; content: unknown; fg?: string; onMouseDown?: () => void },
): void {
  parent.add(
    new otui.TextRenderable(renderer, {
      id: opts.id,
      content: opts.content,
      ...(opts.fg !== undefined ? { fg: opts.fg } : {}),
      ...(opts.onMouseDown !== undefined ? { onMouseDown: opts.onMouseDown } : {}),
    }),
  );
}

function styled(otui: OtuiLike, chunk: unknown, fallback: string): unknown {
  if (otui.t === undefined) {
    return fallback;
  }
  return otui.t`${chunk}`;
}

function markdownContent(otui: OtuiLike, md: string): unknown {
  if (otui.StyledText !== undefined && typeof otui.stringToStyledText === "function") {
    return new otui.StyledText(markdownToChunks(otui as typeof import("@opentui/core"), md));
  }
  return md;
}

function paintList(
  otui: OtuiLike,
  renderer: unknown,
  list: BoxLike,
  selected: ThemeId,
  current: ThemeId,
  onSelect: (id: ThemeId) => void,
  onApply: () => void,
): void {
  clearChildren(list);
  const chrome = getTheme();
  addText(otui, renderer, list, {
    id: "theme-list-title",
    content: "Themes",
    fg: chrome.muted,
  });
  for (const id of THEME_IDS) {
    const row = formatThemePickerRows(selected, current, [id])[0] ?? themeLabel(id);
    const isSelected = id === selected;
    addText(otui, renderer, list, {
      id: `theme-opt-${id}`,
      content: isSelected && otui.bold !== undefined ? styled(otui, otui.bold(row), row) : row,
      fg: isSelected ? chrome.focus : chrome.text,
      onMouseDown: () => onSelect(id),
    });
  }
  addText(otui, renderer, list, {
    id: "theme-submit",
    content: otui.bold !== undefined ? styled(otui, otui.bold("[ Apply ]"), "[ Apply ]") : "[ Apply ]",
    fg: chrome.ok,
    onMouseDown: onApply,
  });
}

function paintPreview(otui: OtuiLike, renderer: unknown, preview: BoxLike, theme: Theme, id: ThemeId): void {
  clearChildren(preview);
  preview.backgroundColor = theme.bg;
  preview.borderColor = theme.border;

  addText(otui, renderer, preview, {
    id: "theme-preview-title",
    content: `Preview · ${themeLabel(id)}`,
    fg: theme.muted,
  });

  const user = new otui.BoxRenderable(renderer, {
    id: "theme-preview-user",
    flexDirection: "column",
    flexShrink: 0,
    borderStyle: "rounded",
    border: true,
    borderColor: theme.border,
    backgroundColor: theme.panel,
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
  });
  addText(otui, renderer, user, { id: "theme-preview-user-k", content: "you", fg: theme.user });
  addText(otui, renderer, user, {
    id: "theme-preview-user-v",
    content: "Try this palette on the live chrome.",
    fg: theme.text,
  });
  preview.add(user);

  addText(otui, renderer, preview, {
    id: "theme-preview-md",
    content: markdownContent(otui, THEME_PREVIEW_MARKDOWN),
    fg: theme.assistant,
  });

  const code = new otui.BoxRenderable(renderer, {
    id: "theme-preview-code",
    flexDirection: "column",
    flexShrink: 0,
    borderStyle: "rounded",
    border: true,
    borderColor: theme.border,
    backgroundColor: theme.panel,
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
  });
  addText(otui, renderer, code, { id: "theme-preview-code-k", content: "ts · 3 lines", fg: theme.muted });
  addText(otui, renderer, code, { id: "theme-preview-code-v", content: THEME_PREVIEW_CODE, fg: theme.tool });
  preview.add(code);

  addText(otui, renderer, preview, {
    id: "theme-preview-tool",
    content: "⚙ tool  read src/tui/theme.ts",
    fg: theme.tool,
  });
  addText(otui, renderer, preview, {
    id: "theme-preview-side",
    content: "── side-1 ──  ◇ framed reply",
    fg: theme.side,
  });
  addText(otui, renderer, preview, {
    id: "theme-preview-chips",
    content: "[focus]  [ok]  [error]",
    fg: theme.focus,
  });
  addText(otui, renderer, preview, { id: "theme-preview-ok", content: "ok", fg: theme.ok });
  addText(otui, renderer, preview, { id: "theme-preview-err", content: "error", fg: theme.error });
}

export function presentThemePicker(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentThemePickerOptions,
): ModalHandle | undefined {
  let selected: ThemeId = options.current;
  let applied = false;
  let handle: ModalHandle | undefined;
  let listBox: BoxLike | undefined;
  let previewBox: BoxLike | undefined;
  let unsubscribeKey: (() => void) | undefined;

  const core = asOtui(otui);
  const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;

  const paint = (): void => {
    if (core === undefined || listBox === undefined || previewBox === undefined) {
      return;
    }
    paintList(core, renderer, listBox, selected, options.current, select, submit);
    paintPreview(core, renderer, previewBox, resolveTheme(selected, options.mode ?? null), selected);
  };

  const select = (id: ThemeId): void => {
    if (applied || id === selected) {
      return;
    }
    selected = id;
    paint();
  };

  const submit = (): void => {
    if (applied) {
      return;
    }
    applied = true;
    options.onApply(selected);
    handle?.close();
  };

  handle = openModal(otui, chrome, {
    title: "/theme",
    tabs: [{ id: "picker", label: "Theme" }],
    initialTab: "picker",
    footer: THEME_PICKER_FOOTER,
    renderTab: (_tabId, body) => {
      if (core === undefined || body === undefined || body === null) {
        return;
      }
      const parent = body as { add?: (child: unknown) => void };
      if (parent.add === undefined) {
        return;
      }
      const split = new core.BoxRenderable(renderer, {
        id: "theme-split",
        width: "100%",
        flexGrow: 1,
        flexDirection: "row",
        minHeight: 18,
        gap: 1,
      });
      listBox = new core.BoxRenderable(renderer, {
        id: "theme-list",
        width: "25%",
        flexGrow: 1,
        flexShrink: 0,
        minWidth: 18,
        flexDirection: "column",
        borderStyle: "rounded",
        border: true,
        borderColor: getTheme().border,
        backgroundColor: getTheme().panel,
        paddingLeft: 1,
        paddingRight: 1,
      });
      previewBox = new core.BoxRenderable(renderer, {
        id: "theme-preview",
        width: "75%",
        flexGrow: 3,
        flexShrink: 1,
        minWidth: 24,
        flexDirection: "column",
        borderStyle: "rounded",
        border: true,
        borderColor: resolveTheme(selected, options.mode ?? null).border,
        backgroundColor: resolveTheme(selected, options.mode ?? null).bg,
        paddingLeft: 1,
        paddingRight: 1,
      });
      split.add(listBox);
      split.add(previewBox);
      parent.add(split);
      paint();
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      if (applied) {
        return;
      }
      const token = key.name || key.sequence;
      if (token === "up" || token === "k") {
        select(moveThemeSelection(selected, -1));
        return;
      }
      if (token === "down" || token === "j") {
        select(moveThemeSelection(selected, 1));
        return;
      }
      if (token === "return" || token === "enter") {
        submit();
      }
    });
  }
  return handle;
}

/** Open the shared host. No-op when OpenTUI / chrome is missing. */
export function openThemePicker(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentThemePickerOptions,
): ModalHandle | undefined {
  return presentThemePicker(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}
