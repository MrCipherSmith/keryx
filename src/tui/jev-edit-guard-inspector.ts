// flow 343: the `/editguard` modal — on/off, threshold, today's counts and
// the most recent flags (file, clause, probability), with an in-modal
// toggle (`t`). Same read-then-render shape `turn-guard-inspector.ts`'s
// `/guard` modal uses, but the state this modal shows lives in a PROJECT
// file (`.metaproject/tasks.config.json`'s `review.jev.edit_guard` plus
// `.metaproject/data/jev/edit-guard.jsonl`), not in-session history — so
// where `/guard` reads a live array reference synchronously on every paint,
// this modal is handed an already-fetched snapshot at open time and
// re-fetches (`loadStatus`) after every toggle.

import { openModal, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const EDIT_GUARD_COMMAND = "/editguard";

export function isEditGuardCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === EDIT_GUARD_COMMAND;
}

export const EDIT_GUARD_FOOTER = [
  { key: "t", label: "toggle on/off" },
  { key: "esc", label: "close" },
] as const;

export interface EditGuardRecentFlag {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly clauseId: string;
  readonly probability: number;
  readonly at: string;
}

export interface EditGuardStatusSnapshot {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly maxCalls: number;
  readonly today: { readonly calls: number; readonly flagged: number; readonly costUsd: number };
  readonly recentFlags: readonly EditGuardRecentFlag[];
}

/** Pure text lines the modal (and a plain-text fallback) render — no OpenTUI types, so this has its own render test with no renderer involved. */
export function formatEditGuardLines(status: EditGuardStatusSnapshot): string[] {
  const lines: string[] = [
    `Jev EDIT GUARD: ${status.enabled ? "on" : "off"}  —  threshold ${status.threshold}  —  max ${status.maxCalls} call(s)/edit`,
    "press t to toggle on/off",
    "",
    `today: ${status.today.calls} Jev call(s), ${status.today.flagged} flag(s), $${status.today.costUsd.toFixed(4)}`,
    "",
    `Recent flags (${status.recentFlags.length}):`,
  ];
  if (status.recentFlags.length === 0) {
    lines.push("  (none yet)");
  } else {
    for (const flag of status.recentFlags) {
      lines.push(`  ${flag.file}:${flag.line} — ${flag.ruleId}#${flag.clauseId} (p=${flag.probability.toFixed(2)})`);
    }
  }
  return lines;
}

/** The sidebar's one-line summary — mirrors `renderRoutingSidebarValue`'s shape (`route-command.ts`). `undefined` (never rendered) while off. */
export function renderEditGuardSidebarValue(status: EditGuardStatusSnapshot): string | undefined {
  if (!status.enabled) return undefined;
  const flagged = status.today.flagged;
  return `on · ${status.today.calls} checked today${flagged > 0 ? `, ${flagged} flagged` : ""}`;
}

export interface EditGuardModalOptions {
  /** Already-fetched at open time — the caller (`tui-shell.ts`) awaits this before ever calling {@link openEditGuard}, the same async-then-open shape `/bus` uses. */
  initialStatus: EditGuardStatusSnapshot;
  /** Re-fetch after a toggle (or a manual refresh) — reads both the config file and the log fresh. */
  loadStatus: () => Promise<EditGuardStatusSnapshot>;
  /** Flip `review.jev.edit_guard` and persist it. Never itself refetches — the modal calls `loadStatus` right after. */
  toggle: () => Promise<void>;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  inputBlocked?: () => boolean;
  /** Surfaced on a failed toggle/refresh — never thrown into the modal. */
  onError?: (message: string) => void;
}

export function openEditGuard(otui: unknown, chrome: unknown, options: EditGuardModalOptions): ModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;

  let status = options.initialStatus;
  let closed = false;
  let toggling = false;
  let bodyNode: { content: unknown } | undefined;
  const keys: { off?: () => void } = {};

  const paint = (): void => {
    if (closed || bodyNode === undefined) return;
    const suffix = toggling ? "\n\n(toggling…)" : "";
    bodyNode.content = core.t`${dimChunk(core, `${formatEditGuardLines(status).join("\n")}${suffix}`)}`;
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: EDIT_GUARD_COMMAND,
    tabs: [{ id: "status", label: "Status" }],
    footer: EDIT_GUARD_FOOTER,
    contentRows: formatEditGuardLines(status).length + 2,
    renderTab: (_tabId, body) => {
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "edit-guard-body", content: "" }) as never;
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
      "edit-guard-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || toggling || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (token !== "t") return;
    toggling = true;
    paint();
    void options
      .toggle()
      .then(() => options.loadStatus())
      .then((next) => {
        status = next;
      })
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        toggling = false;
        paint();
      });
  });

  return handle;
}
