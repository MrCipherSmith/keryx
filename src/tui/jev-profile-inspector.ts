// Flow 344: the `/jevprofile` modal — every `review.jev.*` key next to its
// measured verdict (or "experimental — not measured"), the project's current
// value, and the recommended value, with a way to act on either without
// leaving the TUI. Single-tab, unlike `/guard`'s History/Detail split: there
// is no history here, only a fixed list of keys — same reason
// `routing-inspector.ts`'s settings view stays a flat list rather than a
// list+detail pair.
//
// Read-side (`current`) and write-side (`onToggle`/`onApplyRecommended`) are
// both injected closures, never direct disk I/O from this file — the same
// split every `*-inspector.ts` in this directory already holds, so the modal
// stays testable without a filesystem and `src/commands/review-jev-profile.ts`
// stays the only place `.metaproject/tasks.config.json` is actually touched
// from this feature's TUI half.

import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { RECOMMENDED_JEV_PROFILE } from "../review/jev-profile";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const JEV_PROFILE_COMMAND = "/jevprofile";

export function isJevProfileCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === JEV_PROFILE_COMMAND;
}

export const JEV_PROFILE_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter/space", label: "toggle" },
  { key: "a", label: "apply recommended" },
  { key: "esc", label: "close" },
] as const;

function boolLabel(value: unknown): string {
  return typeof value === "boolean" ? (value ? "on" : "off") : "(unset)";
}

/** One line per `review.jev.*` key, current value, recommended value, and its measured verdict — the same rows `renderJevProfileMarkdown` prints, laid out for a fixed-width panel instead of a markdown table. */
export function formatJevProfileLines(current: Readonly<Record<string, unknown>>, selected: number): string[] {
  return RECOMMENDED_JEV_PROFILE.map((entry, index) => {
    const mark = index === selected ? ">" : " ";
    const currentValue = boolLabel(current[entry.key]);
    const recommended = entry.recommended ? "on" : "off";
    return `${mark} review.jev.${entry.key}  —  current: ${currentValue}, recommended: ${recommended}\n    ${entry.verdict}`;
  });
}

export interface JevProfileModalOptions {
  /** A live view of `.metaproject/tasks.config.json`'s `review.jev.*` block — read fresh each paint. */
  current: () => Readonly<Record<string, unknown>>;
  /** Flip one key's boolean and persist it — resolves once the write lands. */
  onToggle: (key: string) => Promise<void>;
  /** Merge-write the full recommended profile and persist it. */
  onApplyRecommended: () => Promise<void>;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
}

export interface JevProfileModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
}

export function openJevProfile(otui: unknown, chrome: unknown, options: JevProfileModalOptions): JevProfileModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let selected = 0;
  let scroll = 0;
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  let busy = false;
  const keys: { off?: () => void } = {};

  const bodyLines = (): string[] => {
    const header = "review.jev.* — measured verdicts (flow 344). enter/space toggles one key; a applies the recommended profile.";
    return [header, "", ...formatJevProfileLines(options.current(), selected)];
  };
  const visible = (): string[] => windowLines(wrapLines(bodyLines().join("\n"), width).split("\n"), scroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    scroll = clampScroll(scrollToReveal(selected + 2, scroll, bodyRows), bodyLines().length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: JEV_PROFILE_COMMAND,
    tabs: [{ id: "profile", label: "Profile" }],
    footer: JEV_PROFILE_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "jev-profile-body", content: "" }) as never;
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
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "jev-profile-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || busy || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    const move = (next: number): void => {
      const clamped = Math.min(RECOMMENDED_JEV_PROFILE.length - 1, Math.max(0, next));
      if (clamped !== selected) selected = clamped;
    };
    if (token === "up" || token === "k") {
      move(selected - 1);
    } else if (token === "down" || token === "j") {
      move(selected + 1);
    } else if (token === "return" || token === "enter" || token === "space") {
      const entry = RECOMMENDED_JEV_PROFILE[selected];
      if (entry === undefined) return;
      busy = true;
      void options
        .onToggle(entry.key)
        .catch(() => {})
        .finally(() => {
          busy = false;
          paint();
        });
    } else if (token === "a") {
      busy = true;
      void options
        .onApplyRecommended()
        .catch(() => {})
        .finally(() => {
          busy = false;
          paint();
        });
    } else {
      return;
    }
    paint();
  });

  return { ...handle, visibleLines: visible };
}
